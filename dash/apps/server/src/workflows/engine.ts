import type { LeaseLock } from "@freebirdai/connect/host";
import {
  FINAL_TASK_STATUSES,
  actionVariant,
  caseScope,
  firstNode,
  nextNode,
  nodeMode,
  nodeName,
  passes,
  withDefaults,
  workflowReads,
  type AgentSpec,
  type Principal,
  type Task,
  type WorkflowCase,
  type WorkflowNode,
  type WorkflowSpec,
  type WorkflowStart,
} from "@freebirdai/dash-spec";
import { EXECUTORS, RECORD_CHANGE_VARIANTS, intentFor, renderSettings, type ActionContext, type ActionResult, type Approval, type Resume } from "./actions.js";
import { ParkWorkflow, type WorkflowEnv } from "./env.js";
import { RevisionConflict } from "./store.js";

/**
 * The case engine: one record's way through a workflow's graph.
 *
 * A case runs step by step. Each step leaves a task. A step's outcome names
 * an arrow, and the arrow names the next step; arrows may point back, so a
 * case counts its visits to each step and its steps in all, and stops when
 * either limit is reached. A step set to Approve (every outside step, in
 * trial) waits for a person; a Wait waits for its time or its event. A
 * waiting case is saved and the engine moves on; whatever wakes it — an
 * approval, an answer, a reply, a deadline — calls `advance` again.
 *
 * Every save carries the revision it read, so two servers (or a person and
 * the runner) never overwrite each other's progress; each case runs under its
 * own lease. Cancelling is sticky: no step starts once it is asked.
 */

export interface EngineOptions {
  readonly env: WorkflowEnv;
  readonly leases?: LeaseLock | undefined;
  /** This server, among any others. */
  readonly holder: string;
}

/** How long a case may hold its lease while it runs. */
export const CASE_LEASE_MS = 5 * 60_000;

export class CaseBusy extends Error {
  constructor(readonly caseId: string) {
    super("That case is being worked on right now. Try again in a moment.");
    this.name = "CaseBusy";
  }
}

const FINISHED = new Set(["done", "failed", "cancelled", "timed_out"]);

export class WorkflowEngine {
  constructor(private readonly options: EngineOptions) {}

  private get env(): WorkflowEnv {
    return this.options.env;
  }

  private iso(): string {
    return new Date(this.env.now()).toISOString();
  }

  /* ── opening ─────────────────────────────────────────────────────── */

  /** Open a case and run it as far as it goes. */
  async open(
    workflow: WorkflowSpec,
    seed: {
      readonly row?: Record<string, unknown> | undefined;
      readonly rowKey?: string | undefined;
      readonly inputs?: Record<string, unknown> | undefined;
      readonly start: WorkflowStart;
      readonly run?: string | undefined;
      readonly actor?: Principal | null | undefined;
    },
  ): Promise<WorkflowCase> {
    const at = this.iso();
    const actor = seed.actor ?? workflow.enabledBy;
    const opened = await this.env.cases.put({
      id: this.env.newId(),
      workflow: workflow.id,
      workflowName: workflow.name,
      ...(seed.run ? { run: seed.run } : {}),
      ...(seed.rowKey !== undefined ? { rowKey: seed.rowKey } : {}),
      status: "running",
      ...(firstNode(workflow) ? { at: firstNode(workflow) } : {}),
      data: { row: seed.row ?? {}, input: seed.inputs ?? {}, steps: {}, vars: {} },
      visits: {},
      steps: 0,
      revision: 0,
      cancelRequested: false,
      ...(seed.start.agentId ? { agent: seed.start.agentId } : {}),
      ...(actor ? { actor } : {}),
      start: seed.start,
      trial: workflow.trial > 0,
      startedAt: at,
      updatedAt: at,
    });
    return this.advance(opened.id);
  }

  /* ── running ─────────────────────────────────────────────────────── */

  /**
   * Run a case on from where it is. With `approved`, the step waiting for
   * approval runs as that person; with `resume`, the waiting step hears what
   * woke it.
   */
  async advance(caseId: string, how: { readonly approved?: Approval; readonly declined?: { readonly by: Principal }; readonly resume?: Resume } = {}): Promise<WorkflowCase> {
    const key = `case:${caseId}`;
    const leased = this.options.leases ? await this.options.leases.acquire(key, this.options.holder, CASE_LEASE_MS) : true;
    if (!leased) throw new CaseBusy(caseId);
    try {
      return await this.walk(caseId, how);
    } finally {
      await this.options.leases?.release(key, this.options.holder);
    }
  }

  private async walk(caseId: string, how: { approved?: Approval; declined?: { by: Principal }; resume?: Resume }): Promise<WorkflowCase> {
    let one = await this.env.cases.get(caseId);
    if (!one) throw new Error(`There is no case "${caseId}".`);
    const workflow = await this.env.store.get(one.workflow);
    if (!workflow) return this.finish(one, "failed", "Its workflow is gone.");

    const save = async (next: WorkflowCase): Promise<WorkflowCase> => {
      one = await this.env.cases.put({ ...next, updatedAt: this.iso() }, one!.revision);
      return one;
    };

    /* Woken: the step it was waiting on runs again with what woke it. */
    let resuming: { node: string; task?: string | undefined; approved?: Approval; declined?: { by: Principal }; resume?: Resume } | null = null;
    if (how.approved || how.declined || how.resume) {
      if (one.status !== "waiting" || !one.waiting) return one;
      resuming = { node: one.waiting.node, task: one.waiting.task, ...how };
      const { waiting: _waiting, ...rest } = one;
      one = await save({ ...rest, status: "running", at: resuming.node });
    }
    if (one.status !== "running") return one;

    for (;;) {
      if (one.cancelRequested) return this.finish(one, "cancelled", "Cancelled.");
      const node = workflow.nodes.find((each) => each.id === one!.at);
      if (!node) return this.finish(one, "done");
      const variant = actionVariant(node.action);
      const executor = EXECUTORS[node.action];
      const isResume = resuming?.node === node.id;

      if (!isResume) {
        const visits = (one.visits[node.id] ?? 0) + 1;
        if (one.steps + 1 > workflow.limits.stepsPerCase) return this.finish(one, "failed", `Stopped after ${workflow.limits.stepsPerCase} steps: the limit for one case.`);
        if (visits > workflow.limits.visitsPerStep) return this.finish(one, "failed", `Stopped: "${nodeName(node)}" was reached ${workflow.limits.visitsPerStep} times, the limit for one step.`);
        one = await save({ ...one, steps: one.steps + 1, visits: { ...one.visits, [node.id]: visits } });
      }

      const scope = caseScope(one);
      const now = this.env.now();

      /* Only when: otherwise skipped, and the case goes on. */
      if (!isResume && node.when && !passes(node.when, scope, now)) {
        await this.writeTask(this.newTask(workflow, one, node, { status: "skipped", title: `Skipped: ${nodeName(node)} (only when ${node.when})`, finishedAt: this.iso() }));
        one = await this.moveOn(save, one, workflow, node, "next");
        if (one.status !== "running") return one;
        continue;
      }

      if (!variant || !executor || !variant.available) {
        const failedTask = this.newTask(workflow, one, node, { status: "failed", title: `${nodeName(node)} cannot run here yet.`, finishedAt: this.iso() });
        await this.writeTask(failedTask);
        one = await this.afterFailure(save, one, workflow, node, `${nodeName(node)} cannot run here yet.`);
        if (one.status !== "running") return one;
        continue;
      }

      /* The task this step writes to: the one it was waiting on, or a new one. */
      const held = isResume && resuming?.task ? await this.env.tasks.get(resuming.task) : null;
      let task: Task = held ?? this.newTask(workflow, one, node, { status: "running", title: nodeName(node), startedAt: this.iso() });

      /* Settings: frozen when proposed, else filled in from the case now. */
      let settings: Record<string, unknown>;
      try {
        settings = task.pending ? { ...task.pending } : renderSettings(variant, withDefaults(variant, node.settings), scope, now);
      } catch (error) {
        await this.writeTask({ ...task, status: "failed", error: String(error instanceof Error ? error.message : error), finishedAt: this.iso() });
        one = await this.afterFailure(save, one, workflow, node, `${nodeName(node)}: its settings could not be filled in: ${error instanceof Error ? error.message : String(error)}`);
        if (one.status !== "running") return one;
        continue;
      }

      /* Declined: the approval was refused. The case goes down `declined`, if there is such an arrow. */
      if (isResume && resuming?.declined) {
        await this.writeTask({ ...task, status: "dismissed", approvedBy: resuming.declined.by.userId, finishedAt: this.iso(), title: `Declined: ${task.title}` });
        one = await this.moveOn(save, one, workflow, node, "declined");
        resuming = null;
        if (one.status !== "running") return one;
        continue;
      }

      /* Approve: the step waits for a person, with its settings frozen as they will run. */
      const mode = nodeMode(node, one.trial);
      if (mode === "approve" && !(isResume && resuming?.approved)) {
        const proposed: Task = {
          ...task,
          status: "waiting_approval",
          title: this.proposalTitle(node, settings, workflow),
          pending: settings,
          reason: one.trial && node.mode === "auto" ? `In trial: "${workflow.name}" asks before every outside step for its first cases.` : `From "${workflow.name}"${one.rowKey ? ` for ${one.rowKey}` : ""}.`,
        };
        await this.writeTask(proposed);
        this.env.onEvent?.({ type: "task.waiting", task: proposed.id, workflow: workflow.id, agent: proposed.agent });
        one = await save({ ...one, status: "waiting", waiting: { node: node.id, kind: "approval", key: `task:${proposed.id}`, task: proposed.id } });
        return one;
      }

      const agentId = text(settings["agentId"]) || node.agentId || one.agent;
      const agent = agentId ? await this.env.agents.get(agentId) : null;
      const ctx: ActionContext = {
        env: this.env,
        workflow,
        case: one,
        node,
        variant,
        settings,
        scope,
        actor: one.actor ?? workflow.enabledBy ?? null,
        agent: agent ?? null,
        ...(isResume && resuming?.approved ? { approved: resuming.approved } : {}),
        ...(isResume && resuming?.resume ? { resume: resuming.resume } : {}),
        task: { ...task, status: "running", ...(agent ? { agent: agent.id } : {}) },
        startCase: (workflowId, inputs) => this.startChild(workflowId, inputs, one!),
      };
      resuming = null;

      let result: ActionResult;
      try {
        result = await executor(ctx);
      } catch (error) {
        if (error instanceof ParkWorkflow) {
          await this.park(workflow, error.reason);
          await this.writeTask({ ...task, status: "failed", error: error.reason, finishedAt: this.iso() });
          return this.finish(one, "failed", `Paused: ${error.reason}`);
        }
        if (error instanceof RevisionConflict) throw error;
        result = { kind: "failed", error: error instanceof Error ? error.message : String(error) };
      }

      const approvedBy = ctx.approved ? { approvedBy: ctx.approved.by.userId } : {};
      if (result.kind === "wait") {
        task = { ...task, ...result.task, ...approvedBy, ...(agent ? { agent: agent.id } : {}) };
        await this.writeTask(task);
        const outputs = result.outputs ? { ...result.outputs, task: task.id } : { task: task.id };
        one = await save({
          ...one,
          status: "waiting",
          waiting: { ...result.wait, node: node.id, task: task.id },
          data: { ...one.data, steps: { ...one.data.steps, [node.id]: outputs } },
        });
        return one;
      }

      if (result.kind === "failed") {
        await this.writeTask({ ...task, ...result.task, ...approvedBy, status: "failed", error: result.error, finishedAt: this.iso() });
        one = await this.afterFailure(save, one, workflow, node, result.error);
        if (one.status !== "running") return one;
        continue;
      }

      task = { ...task, ...result.task, ...approvedBy, ...(agent && !result.task.agent ? { agent: agent.id } : {}), finishedAt: this.iso() };
      if (task.status === "running") task = { ...task, status: "done" };
      await this.writeTask(task);
      const { __vars, ...outputs } = (result.outputs ?? {}) as Record<string, unknown> & { __vars?: Record<string, unknown> };
      one = await save({
        ...one,
        data: {
          ...one.data,
          steps: { ...one.data.steps, [node.id]: { ...outputs, task: task.id } },
          vars: { ...one.data.vars, ...(__vars ?? {}) },
        },
      });
      one = await this.moveOn(save, one, workflow, node, result.outcome);
      if (one.status !== "running") return one;
    }
  }

  private async moveOn(save: (next: WorkflowCase) => Promise<WorkflowCase>, one: WorkflowCase, workflow: WorkflowSpec, node: WorkflowNode, outcome: string): Promise<WorkflowCase> {
    const next = nextNode(workflow, node.id, outcome);
    if (!next) {
      const status = outcome === "timed_out" ? "timed_out" : "done";
      return this.finish(one, status);
    }
    return save({ ...one, at: next });
  }

  private async afterFailure(save: (next: WorkflowCase) => Promise<WorkflowCase>, one: WorkflowCase, workflow: WorkflowSpec, node: WorkflowNode, error: string): Promise<WorkflowCase> {
    if (node.onFailure === "continue") return this.moveOn(save, one, workflow, node, "next");
    if (node.onFailure === "path") {
      const next = nextNode(workflow, node.id, "failed");
      if (next) return save({ ...one, at: next });
    }
    return this.finish(one, "failed", error);
  }

  /** End a case, tell whatever waits on it, and count down a trial. */
  private async finish(one: WorkflowCase, status: "done" | "failed" | "cancelled" | "timed_out", error?: string): Promise<WorkflowCase> {
    const { waiting: _waiting, ...rest } = one;
    const ended = await this.env.cases.put({ ...rest, status, finishedAt: this.iso(), updatedAt: this.iso(), ...(error ? { error } : {}) }, one.revision);
    if (ended.trial) {
      const workflow = await this.env.store.get(ended.workflow);
      if (workflow && workflow.trial > 0) await this.env.store.put({ ...workflow, trial: workflow.trial - 1 });
    }
    this.env.onEvent?.({ type: "case.finished", workflow: ended.workflow, case: ended.id, status });
    /* A step in another case may be waiting for this one. */
    await this.emit(`case-done:${ended.id}`, { status, case: ended.id });
    return ended;
  }

  private async park(workflow: WorkflowSpec, reason: string): Promise<void> {
    const held = await this.env.store.get(workflow.id);
    if (held) await this.env.store.put({ ...held, parked: { reason, at: this.iso() } });
    this.env.onEvent?.({ type: "workflow.parked", workflow: workflow.id, reason });
  }

  private async startChild(workflowId: string, inputs: Record<string, unknown>, parent: WorkflowCase): Promise<{ id: string; status: string }> {
    const workflow = await this.env.store.get(workflowId);
    if (!workflow) throw new Error(`There is no workflow "${workflowId}".`);
    if (workflowReads(workflow)) throw new Error(`"${workflow.name}" reads its own records, so it cannot be started by another workflow.`);
    const child = await this.open(workflow, {
      inputs,
      start: { kind: "workflow", parentCase: parent.id, ...(parent.agent ? { agentId: parent.agent } : {}) },
      actor: parent.actor ?? null,
    });
    return { id: child.id, status: child.status };
  }

  /* ── tasks ───────────────────────────────────────────────────────── */

  private newTask(workflow: WorkflowSpec, one: WorkflowCase, node: WorkflowNode, fields: Partial<Task>): Task {
    const variant = actionVariant(node.action);
    return {
      id: this.env.newId(),
      workflow: workflow.id,
      workflowName: workflow.name,
      case: one.id,
      node: node.id,
      action: node.action,
      base: variant?.base ?? node.action.split(".")[0] ?? node.action,
      title: nodeName(node),
      status: "running",
      body: { kind: "notice", text: "" },
      links: {},
      ...(one.agent ? { agent: one.agent } : {}),
      createdAt: this.iso(),
      ...fields,
    } as Task;
  }

  private async writeTask(task: Task): Promise<void> {
    await this.env.tasks.put(task);
  }

  /** One line for what an approval will do: "Text +1 555 0100 from Maintenance agent: …". */
  private proposalTitle(node: WorkflowNode, settings: Record<string, unknown>, workflow: WorkflowSpec): string {
    const variant = actionVariant(node.action);
    if (variant && RECORD_CHANGE_VARIANTS.has(variant.id)) {
      const intent = intentFor(variant, settings, workflowReads(workflow)?.connection);
      if (intent) {
        const fields = Object.keys(intent.values ?? {});
        const verb = { create: "Create", update: "Update", delete: "Delete", action: `Run ${intent.action ?? "an action"} on` }[intent.kind];
        return `${verb} ${intent.entity}${intent.id ? ` ${intent.id}` : ""} on ${this.env.connectionTitle?.(intent.connection) ?? intent.connection}${fields.length > 0 ? `: ${fields.join(", ")}` : ""}`;
      }
    }
    if (variant?.base === "outreach") return `${variant.label} ${text(settings["to"])}: ${text(settings["purpose"]).slice(0, 80)}`;
    if (variant?.id === "send.webhook") return `Send to ${text(settings["url"])}`;
    return nodeName(node);
  }

  /* ── waking ──────────────────────────────────────────────────────── */

  /**
   * Something happened: wake every case waiting for it. A signal for a task
   * that has already finished is kept on the task, never applied.
   */
  async emit(key: string, payload: Readonly<Record<string, unknown>> = {}): Promise<number> {
    const waiting = await this.env.cases.waitingOn(key);
    for (const one of waiting) {
      try {
        await this.advance(one.id, { resume: { kind: "event", payload } });
      } catch (error) {
        if (!(error instanceof CaseBusy || error instanceof RevisionConflict)) throw error;
      }
    }
    if (waiting.length === 0 && key.startsWith("task:")) {
      const task = await this.env.tasks.get(key.slice(5));
      if (task && FINAL_TASK_STATUSES.includes(task.status)) {
        await this.env.tasks.put({ ...task, late: [...(task.late ?? []), { at: this.iso(), what: JSON.stringify(payload).slice(0, 500) }] });
      }
    }
    return waiting.length;
  }

  /** Cases whose deadline has passed go down their time-out path. */
  async timeouts(): Promise<number> {
    const due = await this.env.cases.overdue(this.iso());
    let woken = 0;
    for (const one of due) {
      try {
        await this.advance(one.id, { resume: { kind: "timeout" } });
        woken++;
      } catch (error) {
        if (!(error instanceof CaseBusy || error instanceof RevisionConflict)) throw error;
      }
    }
    return woken;
  }

  /** Stop a case: sticky, even across a restart. A waiting case ends now; a running one at its next step. */
  async cancel(caseId: string): Promise<WorkflowCase> {
    const one = await this.env.cases.get(caseId);
    if (!one) throw new Error(`There is no case "${caseId}".`);
    if (FINISHED.has(one.status)) return one;
    if (one.status === "waiting") {
      if (one.waiting?.task) {
        const task = await this.env.tasks.get(one.waiting.task);
        if (task && !FINAL_TASK_STATUSES.includes(task.status)) await this.env.tasks.put({ ...task, status: "dismissed", finishedAt: this.iso(), error: "The case was cancelled." });
      }
      return this.finish({ ...one, cancelRequested: true }, "cancelled", "Cancelled.");
    }
    return this.env.cases.put({ ...one, cancelRequested: true, updatedAt: this.iso() }, one.revision);
  }
}

const text = (value: unknown): string => (value === undefined || value === null ? "" : typeof value === "string" ? value : String(value));

export type { AgentSpec };
