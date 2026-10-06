import {
  changePermission,
  isApiTrigger,
  predicateProblem,
  stepMode,
  templateProblem,
  workflowInputSchema,
  workflowReads,
  workflowSchema,
  type AgentSpec,
  type Principal,
  type WorkflowInput,
  type WorkflowSpec,
  type WorkflowStep,
} from "@freebirdai/dash-spec";
import type { Policy } from "../identity/policy.js";
import type { WorkflowStore } from "./store.js";

/**
 * Making, changing and removing workflows, in one place for the routes and the
 * chat to share.
 *
 * The rules that matter:
 * - **Auto is guarded.** A step set to auto changes an account with the
 *   permission of whoever saved it, so only somebody who holds that
 *   permission can save it. Every save makes the saver the person the
 *   workflow runs as (`enabledBy`).
 * - **What it reads must exist**, and an enabled workflow's reader must be
 *   allowed to read it.
 * - **Expressions are checked when saved**, so a typo is a message on save,
 *   not a run that quietly matches nothing.
 * - **A workflow an agent starts stays while the agent refers to it.**
 */

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problems: readonly WorkflowProblem[] = [],
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export interface WorkflowProblem {
  /** The step at fault, by id; absent for the workflow as a whole. */
  readonly step?: string;
  readonly field?: string;
  readonly message: string;
}

export interface WorkflowServiceDeps {
  readonly store: WorkflowStore;
  readonly policy: Policy;
  readonly agents: { list(): Promise<AgentSpec[]> };
  readonly hasConnection: (id: string) => boolean;
  readonly now?: () => Date;
}

const allocateId = (name: string, taken: ReadonlySet<string>): string => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workflow";
  let id = base;
  for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
  return id;
};

/** Zod's complaints in a person's words: "Step 3: Say which record type the change is on." */
const issues = (error: { issues: Array<{ path: Array<string | number>; message: string }> }): string =>
  error.issues
    .map((issue) => {
      const [first, second, ...rest] = issue.path;
      if (first === "steps" && typeof second === "number") return `Step ${second + 1}${rest.length > 0 && !/^[A-Z]/.test(issue.message) ? ` (${rest.join(".")})` : ""}: ${issue.message}`;
      return `${issue.path.join(".") || "Workflow"}: ${issue.message}`;
    })
    .join(" ");

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Every template a step holds, by field. */
const templatesOf = (step: WorkflowStep): Array<[string, string | undefined]> => {
  switch (step.kind) {
    case "calendar":
      return [["title", step.title], ["at", step.at], ["end", step.end]];
    case "propose_change":
      return [
        ["recordId", step.recordId],
        ...Object.entries(step.parents ?? {}).map(([name, value]): [string, string] => [`parents.${name}`, value]),
        ...Object.entries(step.values ?? {}).map(([name, value]): [string, string] => [`values.${name}`, value]),
      ];
    case "message":
      return [["to", step.to], ["purpose", step.purpose]];
    case "note":
      return [["text", step.text]];
    case "think":
      return [];
  }
};

export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  list(): Promise<WorkflowSpec[]> {
    return this.deps.store.list();
  }

  get(id: string): Promise<WorkflowSpec | null> {
    return this.deps.store.get(id);
  }

  /** Workflows an agent can start: their trigger is `agent`. For the agent page's tool picker. */
  async startableByAgent(): Promise<WorkflowSpec[]> {
    return (await this.deps.store.list()).filter((one) => one.trigger.kind === "agent");
  }

  /** The agents whose tools start a workflow. */
  async startedBy(id: string): Promise<AgentSpec[]> {
    return (await this.deps.agents.list()).filter((agent) => agent.tools.some((tool) => tool.kind === "run_workflow" && tool.workflow === id));
  }

  /** What is wrong with a workflow as it would be saved, by this person. */
  async problems(principal: Principal, workflow: Omit<WorkflowSpec, "id" | "createdAt" | "updatedAt" | "failures">): Promise<WorkflowProblem[]> {
    const out: WorkflowProblem[] = [];
    const connection = (id: string | undefined, where: Omit<WorkflowProblem, "message">) => {
      if (id && !this.deps.hasConnection(id)) out.push({ ...where, message: `"${id}" is not one of this workspace's connections.` });
    };
    if (isApiTrigger(workflow.trigger)) {
      connection(workflow.trigger.connection, { field: "trigger" });
      if (workflow.source) out.push({ field: "source", message: "A trigger on an API reads the records it watches; leave the source out." });
    }
    connection(workflow.source?.connection, { field: "source" });
    const criteria = predicateProblem(workflow.criteria);
    if (criteria) out.push({ field: "criteria", message: `The criteria cannot be read: ${criteria}` });

    const agents = new Map((await this.deps.agents.list()).map((agent) => [agent.id, agent]));
    const reads = workflowReads(workflow);
    const ids = new Set<string>();
    for (const step of workflow.steps) {
      if (ids.has(step.id)) out.push({ step: step.id, message: `Two steps are called "${step.id}".` });
      ids.add(step.id);
      const when = predicateProblem(step.when);
      if (when) out.push({ step: step.id, field: "when", message: `The condition cannot be read: ${when}` });
      for (const [field, template] of templatesOf(step)) {
        const problem = templateProblem(template);
        if (problem) out.push({ step: step.id, field, message: problem });
      }
      if (step.kind === "propose_change") {
        connection(step.connection, { step: step.id, field: "connection" });
        const where = step.connection ?? reads?.connection;
        if (!where) out.push({ step: step.id, field: "connection", message: "Say which connection the change is on." });
        if (step.change === "action" && !step.action) out.push({ step: step.id, field: "action", message: "Say which action to run." });
        if (step.change !== "create" && !step.recordId) out.push({ step: step.id, field: "recordId", message: "Say which record to change, e.g. {{ id }}." });
        if (where && stepMode(step) === "auto") {
          const held = await this.deps.policy.can(principal, changePermission(step.change), { connection: where });
          if (!held.ok) {
            out.push({
              step: step.id,
              field: "mode",
              message: `You cannot set this change to automatic: it would use your permission, and ${held.reason.replace(/\.$/, "").toLowerCase()}. Set it to approve.`,
            });
          }
        }
      }
      if (step.kind === "message") {
        const agent = agents.get(step.agentId);
        if (!agent) out.push({ step: step.id, field: "agentId", message: `There is no agent "${step.agentId}".` });
        else if (agent.archived) out.push({ step: step.id, field: "agentId", message: `${agent.name} is archived.` });
      }
    }
    if (workflow.enabled && reads) {
      const may = await this.deps.policy.can(principal, "records.read", { connection: reads.connection });
      if (!may.ok) out.push({ field: "source", message: `You cannot turn this on: it reads ${reads.connection}, which you may not read.` });
    }
    return out;
  }

  private async checked(principal: Principal, input: unknown, held: WorkflowSpec | null): Promise<Omit<WorkflowSpec, "id" | "createdAt" | "updatedAt">> {
    const parsed = workflowInputSchema.safeParse(input);
    if (!parsed.success) throw new WorkflowError(issues(parsed.error), 400);
    const given: WorkflowInput = parsed.data;
    const enabled = given.enabled ?? held?.enabled ?? false;
    const next = {
      name: given.name,
      enabled,
      description: given.description ?? held?.description ?? "",
      trigger: given.trigger,
      ...(given.source ? { source: given.source } : {}),
      ...(given.criteria ? { criteria: given.criteria } : {}),
      ...(given.rowKey ? { rowKey: given.rowKey } : {}),
      once: given.once ?? held?.once ?? "per-row",
      steps: given.steps ?? held?.steps ?? [],
      /* Whoever saves it is who it runs as: auto steps use their permission. */
      enabledBy: principal,
      /* Turned on (again): whatever paused it is for the person to have fixed, so the pause and the count go. */
      ...(held?.parked && given.enabled !== true ? { parked: held.parked } : {}),
      failures: given.enabled === true ? 0 : (held?.failures ?? 0),
    };
    const problems = await this.problems(principal, next);
    if (problems.length > 0) {
      const forbidden = problems.some((one) => one.field === "mode" || (one.field === "source" && /cannot turn this on/.test(one.message)));
      throw new WorkflowError(problems.map((one) => one.message).join(" "), forbidden ? 403 : 400, problems);
    }
    return next;
  }

  async create(principal: Principal, input: WorkflowInput): Promise<WorkflowSpec> {
    const valid = await this.checked(principal, input, null);
    const taken = new Set((await this.deps.store.list()).map((one) => one.id));
    const at = this.now();
    const workflow = workflowSchema.parse({ ...valid, id: allocateId(valid.name, taken), createdAt: at, updatedAt: at });
    await this.deps.store.put(workflow);
    return workflow;
  }

  async update(principal: Principal, id: string, input: WorkflowInput): Promise<WorkflowSpec> {
    const held = await this.deps.store.get(id);
    if (!held) throw new WorkflowError(`There is no workflow "${id}".`, 404);
    const valid = await this.checked(principal, input, held);
    /* What it watches changed: what it has seen no longer says anything. */
    if (!same(held.trigger, valid.trigger) || !same(held.source, valid.source) || held.rowKey !== valid.rowKey) await this.deps.store.clearFired(id);
    const next = workflowSchema.parse({ ...valid, id, createdAt: held.createdAt, updatedAt: this.now() });
    await this.deps.store.put(next);
    return next;
  }

  /** Turn on or off. Turning on makes this person the one it runs as, and clears a pause. */
  async setEnabled(principal: Principal, id: string, enabled: boolean): Promise<WorkflowSpec> {
    const held = await this.deps.store.get(id);
    if (!held) throw new WorkflowError(`There is no workflow "${id}".`, 404);
    if (!enabled) {
      const next = { ...held, enabled: false, updatedAt: this.now() };
      await this.deps.store.put(next);
      return next;
    }
    const { id: _id, createdAt: _created, updatedAt: _updated, parked: _parked, failures: _failures, enabledBy: _by, ...rest } = held;
    return this.update(principal, id, { ...rest, enabled: true });
  }

  async remove(id: string): Promise<void> {
    const held = await this.deps.store.get(id);
    if (!held) throw new WorkflowError(`There is no workflow "${id}".`, 404);
    const agents = await this.startedBy(id);
    if (agents.length > 0) {
      throw new WorkflowError(`${agents.map((agent) => agent.name).join(" and ")} can start this workflow. Remove it from their tools first.`, 409);
    }
    await this.deps.store.delete(id);
  }
}
