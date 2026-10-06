import type { WriteIntent, WriteReview } from "@freebirdai/connect";
import { WriteError } from "@freebirdai/connect/host";
import { FINAL_TASK_STATUSES, actionVariant, workflowReads, type Principal, type Task, type TaskStatus, type WorkflowCase } from "@freebirdai/dash-spec";
import { RECORD_CHANGE_VARIANTS, agentMay, intentFor } from "./actions.js";
import { CaseBusy } from "./engine.js";
import { startWorkflow, type Starter } from "./start.js";

/**
 * Tasks: one record of every action a workflow took. This is where people act
 * on them.
 *
 * - **Approve** a task waiting for approval. A change to an account is
 *   prepared fresh, as the approver, and Apply sends exactly the review they
 *   saw; anything else runs as them. **Approve always** also turns that step
 *   to Auto, if the approver holds the permission it needs.
 * - **Decline** it: the case goes down its `declined` arrow, if it has one.
 * - **Answer** a question an Ask step put to a teammate.
 * - **Reverse** a finished task, where it can be undone: an account change
 *   through the same review (the record as it is now, with what will be sent),
 *   a calendar entry or note inside Dash directly. The reversal is a task of
 *   its own, linked both ways.
 */

export class TaskError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: { readonly review?: WriteReview; readonly task?: Task } = {},
  ) {
    super(message);
    this.name = "TaskError";
  }
}

const stale = (error: unknown): boolean => error instanceof WriteError && (error.code === "not-found" || (error.code === "invalid" && /Nothing would change/.test(error.message)));

export class TaskService {
  constructor(private readonly starter: Starter) {}

  private get env() {
    return this.starter.env;
  }

  private iso(): string {
    return new Date(this.env.now()).toISOString();
  }

  list(options: { status?: TaskStatus; workflow?: string; case?: string; limit?: number } = {}): Promise<Task[]> {
    return this.env.tasks.list(options);
  }

  private async held(id: string): Promise<Task> {
    const task = await this.env.tasks.get(id);
    if (!task) throw new TaskError(`There is no task "${id}".`, 404);
    return task;
  }

  /** The change a task waiting for approval would make, as a write intent. */
  private async pendingIntent(task: Task): Promise<WriteIntent | null> {
    const variant = actionVariant(task.action);
    if (!variant || !RECORD_CHANGE_VARIANTS.has(variant.id) || !task.pending) return null;
    const workflow = task.workflow ? await this.env.store.get(task.workflow) : null;
    return intentFor(variant, task.pending, workflow ? workflowReads(workflow)?.connection : undefined);
  }

  /**
   * Open a task waiting for approval: a change to an account is prepared now,
   * as this person, and its review returned. One whose record has moved on so
   * far that it no longer applies comes back with why, to be declined.
   */
  async review(principal: Principal, id: string): Promise<{ readonly task: Task; readonly review?: WriteReview; readonly stale?: string }> {
    const task = await this.held(id);
    if (task.status !== "waiting_approval") return { task };
    const intent = await this.pendingIntent(task);
    if (!intent) return { task };
    const agent = task.agent ? await this.env.agents.get(task.agent) : null;
    if (!agentMay(agent, intent.kind, intent.connection, intent.entity)) throw new TaskError(`${agent?.name ?? task.agent} may no longer make this change.`, 403);
    try {
      const review = await this.env.writes.prepare(principal, intent, { via: "workflow", ...(agent ? { onBehalfOf: { kind: "agent" as const, id: agent.id } } : {}) });
      /* What the approver saw, kept on the task: the before and after it records once applied. */
      const shown: Task = {
        ...task,
        body: {
          kind: "change",
          what: `${review.entityName}${intent.id ? ` ${intent.id}` : ""} on ${review.connectionTitle}`,
          changes: review.rows.filter((row) => row.changed).map((row) => ({ field: row.field, label: row.label, before: row.before, after: row.after })),
        },
      };
      await this.env.tasks.put(shown);
      return { task: shown, review };
    } catch (error) {
      if (stale(error)) return { task, stale: (error as Error).message };
      if (error instanceof WriteError) throw new TaskError(error.message, error.status);
      throw error;
    }
  }

  /** Say yes. For a change, to the review this person opened. */
  async approve(principal: Principal, id: string, approval: { readonly pendingId?: string; readonly digest?: string; readonly always?: boolean } = {}): Promise<{ readonly task: Task; readonly case?: WorkflowCase }> {
    const task = await this.held(id);
    if (task.status !== "waiting_approval") throw new TaskError(`This has already been ${task.status.replace("_", " ")}.`, 409, { task });

    /* An agent's request to start a workflow. */
    if (!task.case) {
      const workflowId = String(task.pending?.["workflow"] ?? task.workflow ?? "");
      const workflow = await this.env.store.get(workflowId);
      if (!workflow) {
        const gone: Task = { ...task, status: "failed", error: "The workflow is gone.", finishedAt: this.iso() };
        await this.env.tasks.put(gone);
        return { task: gone };
      }
      const { run } = await startWorkflow(
        this.starter,
        workflow,
        { kind: "approval", userId: principal.userId, ...(task.agent ? { agentId: task.agent } : {}) },
        { inputs: (task.pending?.["inputs"] ?? {}) as Record<string, unknown>, actor: principal },
      );
      const done: Task = {
        ...task,
        status: run.status === "failed" || run.status === "parked" ? "failed" : "done",
        approvedBy: principal.userId,
        finishedAt: this.iso(),
        ...(run.cases[0] ? { links: { ...task.links, startedCase: run.cases[0] } } : {}),
        ...(run.error ? { error: run.error } : {}),
      };
      await this.env.tasks.put(done);
      return { task: done };
    }

    const intent = await this.pendingIntent(task);
    if (intent && (!approval.pendingId || !approval.digest)) throw new TaskError("Open the change and approve its review first.", 400);
    let advanced: WorkflowCase;
    try {
      advanced = await this.starter.engine.advance(task.case, {
        approved: { by: principal, ...(approval.pendingId ? { pendingId: approval.pendingId } : {}), ...(approval.digest ? { digest: approval.digest } : {}) },
      });
    } catch (error) {
      if (error instanceof CaseBusy) throw new TaskError(error.message, 409);
      throw error;
    }
    const after = await this.held(id);
    /* It went back to waiting: the record moved, or the review was not this person's. A fresh review comes back. */
    if (after.status === "waiting_approval") {
      const fresh = await this.review(principal, id).catch(() => null);
      throw new TaskError(after.error ?? "Look at the change again before sending.", 409, { task: after, ...(fresh?.review ? { review: fresh.review } : {}) });
    }
    if (approval.always) await this.approveAlways(principal, after);
    return { task: after, case: advanced };
  }

  /** Turn the step behind a task to Auto, if the approver holds what it needs. */
  private async approveAlways(principal: Principal, task: Task): Promise<void> {
    if (!task.workflow || !task.node) return;
    const workflow = await this.env.store.get(task.workflow);
    const node = workflow?.nodes.find((one) => one.id === task.node);
    const variant = node ? actionVariant(node.action) : undefined;
    if (!workflow || !node || !variant) return;
    if (variant.permission) {
      const connection = String(task.pending?.["connection"] ?? workflowReads(workflow)?.connection ?? "");
      const may = await this.env.policy.can(principal, variant.permission, connection ? { connection } : {});
      if (!may.ok) throw new TaskError(`Approved, but it cannot be made automatic: ${may.reason}`, 403);
    }
    await this.env.store.put({ ...workflow, nodes: workflow.nodes.map((one) => (one.id === node.id ? { ...one, mode: "auto" } : one)), enabledBy: principal, updatedAt: this.iso() });
  }

  /** Say no: the case goes down its `declined` arrow, if it has one, and otherwise ends. */
  async decline(principal: Principal, id: string): Promise<Task> {
    const task = await this.held(id);
    if (task.status !== "waiting_approval") throw new TaskError(`This has already been ${task.status.replace("_", " ")}.`, 409, { task });
    if (!task.case) {
      const dismissed: Task = { ...task, status: "dismissed", approvedBy: principal.userId, finishedAt: this.iso() };
      await this.env.tasks.put(dismissed);
      return dismissed;
    }
    try {
      await this.starter.engine.advance(task.case, { declined: { by: principal } });
    } catch (error) {
      if (error instanceof CaseBusy) throw new TaskError(error.message, 409);
      throw error;
    }
    return this.held(id);
  }

  /** Answer a question an Ask step put to the team. */
  async answer(principal: Principal, id: string, answer: string): Promise<Task> {
    const task = await this.held(id);
    if (task.body.kind !== "question") throw new TaskError("That task is not a question.", 400);
    if (FINAL_TASK_STATUSES.includes(task.status)) throw new TaskError("That question has already been answered or has timed out.", 409, { task });
    if (task.body.options.length > 0 && !task.body.options.includes(answer)) throw new TaskError(`Answer with one of: ${task.body.options.join(", ")}.`, 400);
    await this.starter.engine.emit(`task:${id}`, { answer, by: principal.userId });
    return this.held(id);
  }

  /** Tick off a to-do. */
  async complete(principal: Principal, id: string): Promise<Task> {
    const task = await this.held(id);
    if (task.body.kind !== "todo") throw new TaskError("That task is not a to-do.", 400);
    const next: Task = { ...task, body: { ...task.body, done: true }, approvedBy: principal.userId };
    await this.env.tasks.put(next);
    return next;
  }

  /* ── reverse ─────────────────────────────────────────────────────── */

  private reversible(task: Task): NonNullable<Task["reversal"]> {
    if (task.status !== "done" || !task.reversal?.available) throw new TaskError(task.reversal?.reason ?? "This task cannot be reversed.", 409, { task });
    return task.reversal;
  }

  /** What Reverse would do: for an account change, its review, prepared now, as this person. */
  async reverseReview(principal: Principal, id: string): Promise<{ readonly task: Task; readonly review?: WriteReview; readonly stale?: string }> {
    const task = await this.held(id);
    const reversal = this.reversible(task);
    if (!reversal.intent) return { task };
    try {
      const review = await this.env.writes.prepare(principal, reversal.intent as unknown as WriteIntent, { via: "workflow", ...(task.agent ? { onBehalfOf: { kind: "agent" as const, id: task.agent } } : {}) });
      return { task, review };
    } catch (error) {
      if (stale(error)) return { task, stale: (error as Error).message };
      if (error instanceof WriteError) throw new TaskError(error.message, error.status);
      throw error;
    }
  }

  /** Undo it. The reversal is a task of its own, and the original is marked reversed. */
  async reverse(principal: Principal, id: string, approval: { readonly pendingId?: string; readonly digest?: string } = {}): Promise<{ readonly task: Task; readonly reversal: Task }> {
    const task = await this.held(id);
    const reversal = this.reversible(task);
    const at = this.iso();
    let made: Task;
    if (reversal.intent) {
      if (!approval.pendingId || !approval.digest) throw new TaskError("Open the reversal and approve its review first.", 400);
      try {
        const result = await this.env.writes.commit(principal, approval.pendingId, approval.digest);
        made = {
          id: this.env.newId(),
          ...(task.workflow ? { workflow: task.workflow } : {}),
          ...(task.workflowName ? { workflowName: task.workflowName } : {}),
          ...(task.case ? { case: task.case } : {}),
          action: task.action,
          base: task.base,
          title: `Reversed: ${task.title}`,
          status: "done",
          body: { kind: "notice", text: `${result.title}${result.changed.length > 0 ? `: ${result.changed.join(", ")}` : ""}.` },
          actedAs: principal.userId,
          ...(task.agent ? { agent: task.agent } : {}),
          links: { journal: result.eventId, ...(task.links.record ? { record: task.links.record } : {}) },
          reversal: { available: false, reason: "This is itself a reversal." },
          createdAt: at,
          finishedAt: at,
        };
      } catch (error) {
        if (error instanceof WriteError) throw new TaskError(error.message, error.status, error.extra.review ? { review: error.extra.review } : {});
        throw error;
      }
    } else if (reversal.internal) {
      const { kind, id: target, value } = reversal.internal;
      if (kind === "calendar") {
        if (value && typeof value === "object") await this.env.calendar.put(value as never);
        else await this.env.calendar.delete(target);
      }
      if (kind === "case_value" && task.case) {
        const one = await this.env.cases.get(task.case);
        if (one && one.status !== "running") {
          const vars = { ...one.data.vars };
          if (value === undefined) delete vars[target];
          else vars[target] = value;
          await this.env.cases.put({ ...one, data: { ...one.data, vars }, updatedAt: at }, one.revision);
        }
      }
      made = {
        id: this.env.newId(),
        ...(task.workflow ? { workflow: task.workflow } : {}),
        ...(task.workflowName ? { workflowName: task.workflowName } : {}),
        ...(task.case ? { case: task.case } : {}),
        action: task.action,
        base: task.base,
        title: `Reversed: ${task.title}`,
        status: "done",
        body: { kind: "notice", text: kind === "calendar" ? (value ? "Put back on the calendar." : "Removed from the calendar.") : kind === "notice" ? "Withdrawn." : "Undone." },
        actedAs: principal.userId,
        links: {},
        reversal: { available: false, reason: "This is itself a reversal." },
        createdAt: at,
        finishedAt: at,
      };
    } else {
      throw new TaskError("This task cannot be reversed.", 409);
    }
    await this.env.tasks.put(made);
    const reversed: Task = { ...task, status: "reversed", reversal: { ...reversal, reversedBy: principal.userId, reversedAt: at, reversalTask: made.id } };
    await this.env.tasks.put(reversed);
    return { task: reversed, reversal: made };
  }
}
