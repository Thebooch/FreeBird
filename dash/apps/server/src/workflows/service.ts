import {
  TRIGGER_NODE,
  actionVariant,
  fieldProblems,
  isApiTrigger,
  missingFields,
  nodeName,
  nodeOutcomes,
  predicateProblem,
  templateProblem,
  workflowInputSchema,
  workflowReads,
  workflowSchema,
  type AgentSpec,
  type Principal,
  type WorkflowInput,
  type WorkflowSpec,
} from "@freebirdai/dash-spec";
import type { Policy } from "../identity/policy.js";
import type { WorkflowStore } from "./store.js";

/**
 * Making, changing and removing workflows, in one place for the routes, the
 * builder and the chat to share.
 *
 * - **The graph must hold together.** Every step is a variant from the
 *   catalog; every arrow leaves from an outcome its step has and lands on a
 *   step that exists. Loops are allowed: the case limits stop them.
 * - **Auto is guarded.** A step set to Auto changes an account with the
 *   permission of whoever saved it, so only somebody who holds that
 *   permission can save it. Every save makes the saver the person it runs as.
 * - **Expressions and templates are checked when saved.**
 * - **A step missing a setting** can be saved while the workflow is off, and
 *   says what it needs; turning it on needs every step complete.
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
  /** Only a missing setting: saved, but cannot be turned on. */
  readonly incomplete?: boolean;
  /** How the chat asks for it, for a missing setting. */
  readonly ask?: string;
}

export interface WorkflowServiceDeps {
  readonly store: WorkflowStore;
  readonly policy: Policy;
  readonly agents: { list(): Promise<AgentSpec[]> };
  readonly hasConnection: (id: string) => boolean;
  /** The workspace's appointment type ids, for a booking trigger. Absent: not checked. */
  readonly appointmentTypes?: () => Promise<readonly string[]>;
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

/** Zod's complaints in a person's words: "Step 3: …". */
const issues = (error: { issues: Array<{ path: Array<string | number>; message: string }> }): string =>
  error.issues
    .map((issue) => {
      const [first, second] = issue.path;
      if (first === "nodes" && typeof second === "number") return `Step ${second + 1}: ${issue.message}`;
      return `${issue.path.join(".") || "Workflow"}: ${issue.message}`;
    })
    .join(" ");

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const STARTS_WORKFLOWS = new Set(["run_workflow.start", "run_workflow.each"]);

/** The workflows a workflow's steps start. */
const startsOf = (workflow: Pick<WorkflowSpec, "nodes">): string[] =>
  workflow.nodes.filter((node) => STARTS_WORKFLOWS.has(node.action) && typeof node.settings["workflow"] === "string").map((node) => String(node.settings["workflow"]));

/**
 * A way round from this workflow back to itself through the steps that start
 * workflows, as the ids along it, or null. The workflow being saved counts as
 * it will be, the others as they are.
 */
export const callLoop = (workflow: Pick<WorkflowSpec, "nodes">, self: string | undefined, saved: ReadonlyMap<string, Pick<WorkflowSpec, "nodes">>): string[] | null => {
  const me = self ?? " new workflow ";
  const next = (id: string): string[] => (id === me ? startsOf(workflow) : startsOf(saved.get(id) ?? { nodes: [] }));
  const seen = new Set<string>();
  const walk = (id: string, path: string[]): string[] | null => {
    for (const target of next(id)) {
      if (target === me) return [...path, me];
      if (seen.has(target)) continue;
      seen.add(target);
      const found = walk(target, [...path, target]);
      if (found) return found;
    }
    return null;
  };
  return walk(me, [me]);
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

  /** Workflows an agent can start: their trigger is `agent`. */
  async startableByAgent(): Promise<WorkflowSpec[]> {
    return (await this.deps.store.list()).filter((one) => one.trigger.kind === "agent");
  }

  /** The agents whose tools start a workflow. */
  async startedBy(id: string): Promise<AgentSpec[]> {
    return (await this.deps.agents.list()).filter((agent) => agent.tools.some((tool) => tool.kind === "run_workflow" && tool.workflow === id));
  }

  /** Everything wrong with a workflow as it would be saved, by this person; missing settings marked `incomplete`. */
  async problems(principal: Principal, workflow: Pick<WorkflowSpec, "trigger" | "source" | "criteria" | "nodes" | "edges" | "enabled" | "trial">, self?: string): Promise<WorkflowProblem[]> {
    const out: WorkflowProblem[] = [];
    const connection = (id: unknown, where: Omit<WorkflowProblem, "message">) => {
      if (typeof id === "string" && id && !this.deps.hasConnection(id)) out.push({ ...where, message: `"${id}" is not one of this workspace's connections.` });
    };
    if (isApiTrigger(workflow.trigger)) {
      connection(workflow.trigger.connection, { field: "trigger" });
      if (workflow.source) out.push({ field: "source", message: "A trigger on an API reads the records it watches; leave the source out." });
    }
    connection(workflow.source?.connection, { field: "source" });
    if (workflow.trigger.kind === "booking" && this.deps.appointmentTypes) {
      const known = new Set(await this.deps.appointmentTypes());
      for (const type of workflow.trigger.types) if (!known.has(type)) out.push({ field: "trigger", message: `There is no appointment type "${type}".` });
    }
    const criteria = predicateProblem(workflow.criteria);
    if (criteria) out.push({ field: "criteria", message: `The criteria cannot be read: ${criteria}` });

    const agents = new Map((await this.deps.agents.list()).map((agent) => [agent.id, agent]));
    const workflows = new Map((await this.deps.store.list()).map((one) => [one.id, one]));
    const reads = workflowReads(workflow);
    const ids = new Set<string>();
    for (const node of workflow.nodes) {
      const at = { step: node.id };
      const name = nodeName(node);
      if (ids.has(node.id) || node.id === TRIGGER_NODE) out.push({ ...at, message: `Two steps are called "${node.id}".` });
      ids.add(node.id);
      const variant = actionVariant(node.action);
      if (!variant) {
        out.push({ ...at, field: "action", message: `"${node.action}" is not an action.` });
        continue;
      }
      if (!variant.available) out.push({ ...at, field: "action", message: `${variant.label} is not available yet.` });
      const when = predicateProblem(node.when);
      if (when) out.push({ ...at, field: "when", message: `${name}: the condition cannot be read: ${when}` });
      for (const problem of fieldProblems(variant, node.settings)) out.push({ ...at, field: problem.key, message: `${name}: ${problem.message}` });
      /* A step on "the booking" means the one that started the case; any other workflow must say which. */
      if (workflow.trigger.kind !== "booking" && variant.fields.some((field) => field.key === "booking")) {
        const booking = String(node.settings["booking"] ?? "").replace(/\s+/g, "");
        if (!booking || booking === "{{id}}") out.push({ ...at, field: "booking", incomplete: true, message: `${name}: say which booking, e.g. {{ steps.<hold step>.booking }}. This workflow isn't started by a booking.` });
      }
      for (const field of missingFields(variant, node.settings)) {
        out.push({ ...at, field: field.key, incomplete: true, message: `${name} needs ${field.label.toLowerCase()}.`, ...(field.ask ? { ask: field.ask } : {}) });
      }
      for (const field of variant.fields) {
        const value = node.settings[field.key];
        if (value === undefined || value === null || value === "") continue;
        if (field.kind === "template" || field.kind === "longtext") {
          const problem = templateProblem(String(value));
          if (problem) out.push({ ...at, field: field.key, message: `${name}: ${field.label}: ${problem}` });
        }
        if (field.kind === "values" && typeof value === "object") {
          for (const [key, one] of Object.entries(value as Record<string, unknown>)) {
            const problem = templateProblem(String(one));
            if (problem) out.push({ ...at, field: field.key, message: `${name}: ${key}: ${problem}` });
          }
        }
        if (field.kind === "expression") {
          const problem = predicateProblem(String(value));
          if (problem) out.push({ ...at, field: field.key, message: `${name}: ${field.label} cannot be read: ${problem}` });
        }
        if (field.kind === "connection") connection(value, { ...at, field: field.key });
        if (field.kind === "agent") {
          const agent = agents.get(String(value));
          if (!agent) out.push({ ...at, field: field.key, message: `${name}: there is no agent "${String(value)}".` });
          else if (agent.archived) out.push({ ...at, field: field.key, message: `${name}: ${agent.name} is archived.` });
        }
        if (field.kind === "step" && !workflow.nodes.some((one) => one.id === value)) out.push({ ...at, field: field.key, message: `${name}: there is no step "${String(value)}".` });
        if (field.kind === "workflow") {
          const target = workflows.get(String(value));
          if (!target) out.push({ ...at, field: field.key, message: `${name}: there is no workflow "${String(value)}".` });
          else if (workflowReads(target)) out.push({ ...at, field: field.key, message: `${name}: "${target.name}" reads its own records, so another workflow cannot start it.` });
          else if (target.id === self) out.push({ ...at, field: field.key, message: `${name}: a workflow cannot start itself.` });
        }
      }
      if (node.agentId && !agents.has(node.agentId)) out.push({ ...at, field: "agentId", message: `${name}: there is no agent "${node.agentId}".` });

      /* Auto uses the saver's permission: only someone who holds it may set it. */
      if (variant.leavesDash && node.mode === "auto" && variant.permission) {
        const where = (typeof node.settings["connection"] === "string" && node.settings["connection"]) || reads?.connection;
        const held = await this.deps.policy.can(principal, variant.permission, where ? { connection: where } : {});
        if (!held.ok) {
          out.push({ ...at, field: "mode", message: `${name} cannot be automatic: it would use your permission, and ${held.reason.replace(/\.$/, "").toLowerCase()}. Set it to approve.` });
        }
      }
    }

    const leaving = new Set<string>();
    for (const edge of workflow.edges) {
      const fromNode = workflow.nodes.find((one) => one.id === edge.from);
      if (edge.from !== TRIGGER_NODE && !fromNode) out.push({ message: `An arrow leaves from "${edge.from}", which is not a step.` });
      if (!workflow.nodes.some((one) => one.id === edge.to)) out.push({ message: `An arrow points at "${edge.to}", which is not a step.` });
      if (fromNode) {
        const allowed = new Set([...nodeOutcomes(fromNode), "next", "failed"]);
        if (!allowed.has(edge.outcome)) out.push({ step: fromNode.id, message: `${nodeName(fromNode)} has no outcome "${edge.outcome}".` });
      } else if (edge.from === TRIGGER_NODE && edge.outcome !== "next") out.push({ message: "The trigger has one way out." });
      const key = `${edge.from}\u0000${edge.outcome}`;
      if (leaving.has(key)) out.push({ ...(fromNode ? { step: fromNode.id } : {}), message: `Two arrows leave ${fromNode ? nodeName(fromNode) : "the trigger"} for "${edge.outcome}".` });
      leaving.add(key);
    }
    /* A workflow may not start itself, however far round: A starts B, B starts A. */
    const loop = callLoop(workflow, self, workflows);
    if (loop) out.push({ message: `These workflows would start each other for ever: ${loop.map((id) => (id === loop[0] ? "this one" : `"${workflows.get(id)?.name ?? id}"`)).join(" starts ")}.` });

    if (workflow.nodes.length > 0 && !workflow.edges.some((edge) => edge.from === TRIGGER_NODE)) {
      out.push({ incomplete: true, message: "Draw an arrow from the trigger to the first step." });
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
    const base = workflowSchema.parse({
      id: held?.id ?? "draft",
      name: given.name,
      description: given.description ?? held?.description ?? "",
      enabled,
      trial: given.trial ?? held?.trial ?? 0,
      trigger: given.trigger,
      triggerLimits: given.triggerLimits ?? held?.triggerLimits ?? {},
      ...(given.source ? { source: given.source } : {}),
      ...(given.criteria ? { criteria: given.criteria } : {}),
      ...(given.rowKey ? { rowKey: given.rowKey } : {}),
      once: given.once ?? held?.once ?? "per-row",
      nodes: given.nodes ?? held?.nodes ?? [],
      edges: given.edges ?? held?.edges ?? [],
      limits: given.limits ?? held?.limits ?? {},
      guardrails: given.guardrails ?? held?.guardrails ?? "",
      /* Whoever saves it is who it runs as. */
      enabledBy: principal,
      ...(held?.parked && given.enabled !== true ? { parked: held.parked } : {}),
      failures: given.enabled === true ? 0 : (held?.failures ?? 0),
      ...(held?.fromTemplate ? { fromTemplate: held.fromTemplate } : {}),
      trialCases: held?.trialCases ?? [],
      createdAt: held?.createdAt ?? this.now(),
      updatedAt: this.now(),
    });
    const problems = (await this.problems(principal, base, held?.id)).filter((one) => !(one.incomplete && !enabled));
    if (problems.length > 0) {
      const forbidden = problems.some((one) => one.field === "mode" || (one.field === "source" && /cannot turn this on/.test(one.message)));
      throw new WorkflowError(problems.map((one) => one.message).join(" "), forbidden ? 403 : 400, problems);
    }
    const { id: _id, createdAt: _created, updatedAt: _updated, ...rest } = base;
    return rest;
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
    if (!same(held.trigger, valid.trigger) || !same(held.source, valid.source) || held.rowKey !== valid.rowKey) await this.deps.store.clearFired(id);
    /* A change to what cases follow is a new version: cases already open keep theirs. */
    const changed = !same(held.nodes, valid.nodes) || !same(held.edges, valid.edges) || !same(held.limits, valid.limits) || held.guardrails !== valid.guardrails || !same(held.trigger, valid.trigger) || !same(held.source, valid.source);
    const next = workflowSchema.parse({ ...valid, id, version: changed ? held.version + 1 : held.version, createdAt: held.createdAt, updatedAt: this.now() });
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
    const { id: _id, createdAt: _c, updatedAt: _u, parked: _p, failures: _f, enabledBy: _b, fromTemplate: _t, ...rest } = held;
    return this.update(principal, id, { ...rest, enabled: true });
  }

  async remove(id: string): Promise<void> {
    const held = await this.deps.store.get(id);
    if (!held) throw new WorkflowError(`There is no workflow "${id}".`, 404);
    const agents = await this.startedBy(id);
    if (agents.length > 0) throw new WorkflowError(`${agents.map((agent) => agent.name).join(" and ")} can start this workflow. Remove it from their tools first.`, 409);
    const callers = (await this.deps.store.list()).filter((one) => one.id !== id && startsOf(one).includes(id));
    if (callers.length > 0) throw new WorkflowError(`${callers.map((one) => `"${one.name}"`).join(" and ")} starts this workflow. Change that step first.`, 409);
    await this.deps.store.delete(id);
  }
}
