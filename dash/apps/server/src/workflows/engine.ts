import { createHash } from "node:crypto";
import type { LeaseLock } from "@freebirdai/connect/host";
import {
  FINAL_TASK_STATUSES,
  MAX_CALL_DEPTH,
  actionVariant,
  caseScope,
  definitionOf,
  durationMs,
  firstNode,
  nextNode,
  nodeMode,
  nodeName,
  passes,
  withDefaults,
  workflowReads,
  type AgentSpec,
  type CaseAttempt,
  type CaseWait,
  type Principal,
  type Task,
  type WorkflowCase,
  type WorkflowNode,
  type WorkflowSpec,
  type WorkflowStart,
} from "@freebirdai/dash-spec";
import { EXECUTORS, RECORD_CHANGE_VARIANTS, intentFor, renderSettings, type ActionContext, type ActionResult, type Approval, type Resume } from "./actions.js";
import { ParkWorkflow, type WorkflowEnv } from "./env.js";
import { agentNamed, readRecordAs } from "./reads.js";
import { RevisionConflict } from "./store.js";

/**
 * The case engine: one record's way through a workflow's graph.
 *
 * A case runs step by step. Each step leaves a task. A step's outcome names
 * an arrow, and the arrow names the next step; arrows may point back, so a
 * case counts its visits to each step and its steps in all, and stops when
 * either limit is reached. A step set to Approve (every outside step, in
 * trial) waits for a person; a Wait waits for its time or its event.
 *
 * **Nothing is done before it is written down.** A step's attempt — its
 * operation id, the task it writes to — is saved on the case before the step
 * starts, and marked `executing` just before it acts; its task records the
 * outcome and outputs before the case moves on. A case found running with
 * nobody working on it is recovered from what was written: a finished task
 * moves it on without acting again; a step interrupted while acting runs
 * again only if it cannot do the same thing twice, and otherwise asks a
 * person whether it happened.
 *
 * **A case follows the workflow it opened on.** Its steps and arrows are
 * frozen on the case; editing the workflow changes new cases only. An
 * approval applies to the attempt it was made for and nothing else.
 *
 * Every save carries the revision it read; each call that works on a case
 * holds its own lease on it, renewed at each step. Cancelling is sticky.
 */

export interface EngineOptions {
  readonly env: WorkflowEnv;
  readonly leases?: LeaseLock | undefined;
  /** This server, among any others. Each call adds its own id to it. */
  readonly holder: string;
  /** How often a call working on a case renews its lease, in real time. Default a third of the lease. */
  readonly heartbeatMs?: number | undefined;
}

/** A call's hold on a case: renewed between steps and, by a heartbeat, while a step acts. */
interface Hold {
  /** Renew now; throws `CaseBusy` if the case is no longer this call's. */
  renew(): Promise<void>;
  /** Throws `CaseBusy` if a heartbeat found the case is no longer this call's. */
  check(): void;
}

/** How long a case may hold its lease between steps. */
export const CASE_LEASE_MS = 5 * 60_000;
/** A running case untouched this long, with nobody holding it, was interrupted. */
export const STALL_MS = CASE_LEASE_MS;
/** How long a signal nobody has taken is kept for a case that starts waiting later. */
export const SIGNAL_KEEP_MS = 7 * 86_400_000;
/** How many counted trial cases a workflow remembers, so a case announced again is not counted again. */
const TRIAL_LEDGER = 500;
/** The longest one retry waits. */
const MAX_RETRY_DELAY_MS = 86_400_000;

/** What a new case starts from. */
export interface OpenSeed {
  readonly id?: string | undefined;
  readonly row?: Record<string, unknown> | undefined;
  readonly rowKey?: string | undefined;
  readonly inputs?: Record<string, unknown> | undefined;
  readonly start: WorkflowStart;
  readonly run?: string | undefined;
  readonly actor?: Principal | null | undefined;
  readonly chain?: readonly string[] | undefined;
}

export class CaseBusy extends Error {
  constructor(readonly caseId: string) {
    super("That case is being worked on right now. Try again in a moment.");
    this.name = "CaseBusy";
  }
}

/** What woke a case, or why it is being looked at. */
export interface Wake {
  readonly approved?: Approval;
  readonly declined?: { readonly by: Principal };
  /** A person says an interrupted send did happen: the case goes on without sending again. */
  readonly settled?: { readonly by: Principal };
  readonly resume?: Resume;
  /** A retry's time came. */
  readonly retry?: boolean;
  /** Check the record a waiting case watches. */
  readonly poll?: boolean;
  /** The task a person acted on: the wake applies only if the case still waits on it. */
  readonly task?: string | undefined;
}

const FINISHED = new Set(["done", "failed", "cancelled", "timed_out"]);
const PERSON_WAITS = new Set(["approval", "uncertain"]);

const shortHash = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16);

/** What a case is about, for a sentence: its row's title where it has one (a booking does), else its row key. */
const rowLabel = (one: Pick<WorkflowCase, "rowKey" | "data">): string => {
  const title = (one.data.row as Record<string, unknown> | undefined)?.["title"];
  return typeof title === "string" && title.trim() ? title.trim() : (one.rowKey ?? "");
};

export class WorkflowEngine {
  /** Cases this process is working on now, so recovery never takes one from under itself. */
  private readonly active = new Set<string>();

  constructor(private readonly options: EngineOptions) {}

  private get env(): WorkflowEnv {
    return this.options.env;
  }

  private iso(ms = this.env.now()): string {
    return new Date(ms).toISOString();
  }

  /* ── opening ─────────────────────────────────────────────────────── */

  /**
   * Open a case and run it as far as it goes. With `id`, opening is
   * idempotent: a case already open under that id is returned as it is.
   */
  async open(workflow: WorkflowSpec, seed: OpenSeed): Promise<WorkflowCase> {
    const { case: one, created } = await this.create(workflow, seed);
    return created ? this.advance(one.id) : one;
  }

  /**
   * Write a new case down, and nothing more. With `id`, a case already under
   * that id is returned (`created: false`). Kept apart from running it, so a
   * caller that claimed a record knows the case exists before anything acts.
   */
  async create(workflow: WorkflowSpec, seed: OpenSeed): Promise<{ readonly case: WorkflowCase; readonly created: boolean }> {
    const at = this.iso();
    const actor = seed.actor ?? workflow.enabledBy;
    const first = firstNode(workflow);
    let opened: WorkflowCase;
    try {
      opened = await this.env.cases.put({
        id: seed.id ?? this.env.newId(),
        workflow: workflow.id,
        workflowName: workflow.name,
        ...(seed.run ? { run: seed.run } : {}),
        ...(seed.rowKey !== undefined ? { rowKey: seed.rowKey } : {}),
        status: "running",
        ...(first ? { at: first } : {}),
        data: { row: seed.row ?? {}, input: seed.inputs ?? {}, steps: {}, vars: {} },
        definition: definitionOf(workflow),
        chain: [...(seed.chain ?? [])],
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
    } catch (error) {
      if (error instanceof RevisionConflict && seed.id) {
        const held = await this.env.cases.get(seed.id);
        if (held) return { case: held, created: false };
      }
      throw error;
    }
    return { case: opened, created: true };
  }

  /* ── running ─────────────────────────────────────────────────────── */

  /**
   * Take a case's lease for this call alone, run `work`, and let it go. A
   * heartbeat renews the lease while `work` runs, however long one step takes
   * (a slow API, a long run of child starts), so nobody else takes the case
   * from a call still working on it. A heartbeat that finds the lease gone
   * marks the hold lost, and the call stops before writing or starting more.
   */
  private async leased<T>(caseId: string, work: (hold: Hold) => Promise<T>): Promise<T> {
    if (this.active.has(caseId)) throw new CaseBusy(caseId);
    const key = `case:${caseId}`;
    /* Each call is its own holder: the same server calling twice does not get the lease twice. */
    const holder = `${this.options.holder}:${this.env.newId()}`;
    const leases = this.options.leases;
    if (leases && !(await leases.acquire(key, holder, CASE_LEASE_MS))) throw new CaseBusy(caseId);
    this.active.add(caseId);
    let lost = false;
    const beat = leases
      ? setInterval(() => {
          void leases.acquire(key, holder, CASE_LEASE_MS).then(
            (ok) => {
              if (!ok) lost = true;
            },
            () => undefined,
          );
        }, this.options.heartbeatMs ?? CASE_LEASE_MS / 3)
      : null;
    (beat as { unref?: () => void } | null)?.unref?.();
    const hold: Hold = {
      renew: async () => {
        if (lost || (leases && !(await leases.acquire(key, holder, CASE_LEASE_MS)))) {
          lost = true;
          throw new CaseBusy(caseId);
        }
      },
      check: () => {
        if (lost) throw new CaseBusy(caseId);
      },
    };
    try {
      return await work(hold);
    } finally {
      if (beat) clearInterval(beat);
      this.active.delete(caseId);
      if (!lost) await leases?.release(key, holder);
    }
  }

  /**
   * Run a case on from where it is. With `approved`, the step waiting for
   * approval runs as that person; with `resume`, the waiting step hears what
   * woke it; with nothing, a running case carries on (or is recovered).
   */
  advance(caseId: string, how: Wake = {}): Promise<WorkflowCase> {
    return this.leased(caseId, (hold) => this.walk(caseId, how, hold));
  }

  private async walk(caseId: string, how: Wake, hold: Hold): Promise<WorkflowCase> {
    let one = await this.env.cases.get(caseId);
    if (!one) throw new Error(`There is no case "${caseId}".`);
    /* Cancelled while it waited: it ends here, whatever woke it. */
    if (one.cancelRequested && one.status === "waiting") {
      if (one.waiting?.task) await this.dismissStale(one.waiting.task, "The case was cancelled.");
      return this.finish(one, "cancelled", "Cancelled.");
    }
    const live = await this.env.store.get(one.workflow);
    if (!live) return this.finish(one, "failed", "Its workflow is gone.");
    /* The graph the case opened on; the rest (its name, whether it is parked) as it is now. */
    const { source: _source, rowKey: _rowKey, ...liveRest } = live;
    const workflow: WorkflowSpec = { ...liveRest, ...one.definition };

    const save = async (next: WorkflowCase): Promise<WorkflowCase> => {
      one = await this.env.cases.put({ ...next, updatedAt: this.iso() }, one!.revision);
      return one;
    };

    /* ── what woke it ── */
    let wake: Wake | null = null;
    /*
     * A signal this case has taken but not yet acknowledged. It stays this
     * case's to take again until what it caused is written down, so an
     * interruption in between never loses it.
     */
    let heldSignal: string | undefined;
    const consumed = async (): Promise<void> => {
      if (heldSignal) await this.env.signals.ack(heldSignal);
      heldSignal = undefined;
    };
    if (how.approved || how.declined || how.settled || how.resume || how.retry || how.poll) {
      if (one.status !== "waiting" || !one.waiting) return one;
      const waiting = one.waiting;
      if (how.task !== undefined && waiting.task !== how.task) {
        await this.dismissStale(how.task, "This was for an earlier step of the case, and no longer applies.");
        return one;
      }
      if ((how.approved || how.declined) && !PERSON_WAITS.has(waiting.kind)) return one;
      if (how.settled && waiting.kind !== "uncertain") return one;
      if (how.retry && waiting.kind !== "retry") return one;
      let resume = how.resume;
      if (how.poll) {
        const heard = await this.pollRecord(one, workflow);
        if (heard === "waiting") return one;
        if (heard === "parked") return this.env.cases.get(caseId).then((held) => held ?? one!);
        resume = { kind: "event", payload: { record: heard } };
      } else if (resume?.kind === "event" && !resume.payload) {
        /* A signal: taken by this case alone, or it was someone else's. */
        const signal = await this.env.signals.take(waiting.key, one.id, one.startedAt);
        if (!signal) return one;
        heldSignal = signal.id;
        /* What arrived after the deadline does not count: the wait timed out first, whenever the time-out is noticed. */
        resume = waiting.deadline && signal.at > waiting.deadline ? { kind: "timeout" } : { kind: "event", payload: signal.payload };
      } else if (resume?.kind === "timeout" && waiting.kind !== "retry" && waiting.key !== "time") {
        /* The deadline passed, but what it waited for may have arrived in time and not been handed over yet: that wins. */
        const signal = await this.env.signals.take(waiting.key, one.id, one.startedAt, waiting.deadline);
        if (signal) {
          heldSignal = signal.id;
          resume = { kind: "event", payload: signal.payload };
        }
      }
      if (resume?.kind === "timeout" && waiting.kind === "retry") {
        wake = { retry: true };
      } else {
        wake = { ...how, ...(resume ? { resume } : {}) };
      }
      const { waiting: _waiting, ...rest } = one;
      one = await save({ ...rest, status: "running", at: waiting.node });
    }
    if (one.status !== "running") return one;

    for (;;) {
      await hold.renew();
      if (one.cancelRequested) return this.finish(one, "cancelled", "Cancelled.");
      const node = workflow.nodes.find((each) => each.id === one!.at);
      if (!node) return this.finish(one, "done");
      const variant = actionVariant(node.action);
      const executor = EXECUTORS[node.action];

      /* ── the attempt: written down before anything is done ── */
      let attempt: CaseAttempt | undefined = one.attempt?.node === node.id ? one.attempt : undefined;
      if (!attempt) {
        wake = null;
        const visits = (one.visits[node.id] ?? 0) + 1;
        if (one.steps + 1 > workflow.limits.stepsPerCase) return this.finish(one, "failed", `Stopped after ${workflow.limits.stepsPerCase} steps: the limit for one case.`);
        if (visits > workflow.limits.visitsPerStep) return this.finish(one, "failed", `Stopped: "${nodeName(node)}" was reached ${workflow.limits.visitsPerStep} times, the limit for one step.`);
        attempt = { id: `${one.id}:${node.id}:${visits}`, node: node.id, task: this.env.newId(), tries: 1, executing: false, startedAt: this.iso() };
        one = await save({ ...one, steps: one.steps + 1, visits: { ...one.visits, [node.id]: visits }, attempt });
      }
      const held = await this.env.tasks.get(attempt.task);

      /* ── recovery: a step found part-way, with nothing waking it ── */
      if (!wake && held) {
        if (FINAL_TASK_STATUSES.includes(held.status) && held.outcome !== undefined) {
          one = await this.applied(save, one, workflow, node, held);
          if (one.status !== "running") return one;
          continue;
        }
        if ((held.status === "waiting" || held.status === "waiting_approval") && held.wait) {
          return save(this.waitingOn(one, attempt, node, held));
        }
        if (held.status === "running" && attempt.executing && variant?.interrupted === "review") {
          return this.uncertain(save, one, attempt, { ...held, title: `Did it happen? ${held.title}` }, "Dash stopped while this was being done, so it may or may not have happened.");
        }
      }

      const scope = caseScope(one);
      const now = this.env.now();
      const { wait: _heldWait, ...heldRest } = held ?? ({} as Partial<Task>);
      const base: Task = held ? (heldRest as Task) : this.newTask(workflow, one, node, attempt, { status: "running", title: nodeName(node), startedAt: this.iso() });

      /* Only when: otherwise skipped, and the case goes on. */
      if (!wake && node.when && !passes(node.when, scope, now)) {
        const skipped: Task = { ...base, status: "skipped", title: `Skipped: ${nodeName(node)} (only when ${node.when})`, outcome: "next", finishedAt: this.iso() };
        await this.writeTask(skipped);
        one = await this.applied(save, one, workflow, node, skipped);
        if (one.status !== "running") return one;
        continue;
      }

      if (!variant || !executor || !variant.available) {
        const failedTask: Task = { ...base, status: "failed", title: `${nodeName(node)} cannot run here yet.`, error: `${nodeName(node)} cannot run here yet.`, outcome: "failed", finishedAt: this.iso() };
        await this.writeTask(failedTask);
        one = await this.applied(save, one, workflow, node, failedTask);
        if (one.status !== "running") return one;
        continue;
      }

      /* Settings: frozen when proposed, else filled in from the case now. */
      let settings: Record<string, unknown>;
      try {
        settings = base.pending ? { ...base.pending } : renderSettings(variant, withDefaults(variant, node.settings), scope, now);
      } catch (error) {
        const message = `${nodeName(node)}: its settings could not be filled in: ${error instanceof Error ? error.message : String(error)}`;
        const failedTask: Task = { ...base, status: "failed", error: message, outcome: "failed", finishedAt: this.iso() };
        await this.writeTask(failedTask);
        one = await this.applied(save, one, workflow, node, failedTask);
        if (one.status !== "running") return one;
        continue;
      }

      /* Declined: the case goes down `declined`, if there is such an arrow. */
      if (wake?.declined) {
        const dismissed: Task = { ...base, status: "dismissed", approvedBy: wake.declined.by.userId, title: `Declined: ${base.title}`, outcome: "declined", finishedAt: this.iso() };
        await this.writeTask(dismissed);
        wake = null;
        one = await this.applied(save, one, workflow, node, dismissed);
        if (one.status !== "running") return one;
        continue;
      }

      /* A person says an interrupted send did happen: it is not sent again. */
      if (wake?.settled) {
        const settled: Task = { ...base, status: "done", uncertain: false, approvedBy: wake.settled.by.userId, title: base.title.replace(/^Did it happen\? /, ""), reason: "Marked as done: it had happened.", outcome: "next", finishedAt: this.iso() };
        await this.writeTask(settled);
        wake = null;
        one = await this.applied(save, one, workflow, node, settled);
        if (one.status !== "running") return one;
        continue;
      }

      /* A review must be the one opened from this task for this step: anything else is not this step's approval. */
      if (wake?.approved?.pendingId) {
        const bound = base.reviews?.approve;
        if (!bound || bound.pendingId !== wake.approved.pendingId || bound.by !== wake.approved.by.userId || bound.attempt !== attempt.id) {
          return save({ ...one, status: "waiting", waiting: { node: node.id, kind: "approval", key: `task:${base.id}`, task: base.id }, attempt: { ...attempt, executing: false } });
        }
      }

      /* Approve: the step waits for a person, with its settings frozen as they will run. */
      const approval: Approval | undefined = wake?.approved ?? (attempt.approvedBy && (wake?.retry || attempt.executing) ? { by: attempt.approvedBy } : undefined);
      const mode = nodeMode(node, one.trial);
      if (mode === "approve" && !approval) {
        const wait: CaseWait = { node: node.id, kind: "approval", key: `task:${base.id}`, task: base.id };
        const proposed: Task = {
          ...base,
          status: "waiting_approval",
          title: this.proposalTitle(node, settings, workflow, one.data.row),
          pending: settings,
          wait,
          reason: one.trial && node.mode === "auto" ? `In trial: "${workflow.name}" asks before every outside step for its first cases.` : `From "${workflow.name}"${one.rowKey ? ` for ${rowLabel(one)}` : ""}.`,
        };
        await this.writeTask(proposed);
        this.env.onEvent?.({ type: "task.waiting", task: proposed.id, workflow: workflow.id, agent: proposed.agent });
        return save({ ...one, status: "waiting", waiting: wait });
      }
      if (approval && !attempt.approvedBy) attempt = { ...attempt, approvedBy: approval.by };

      /* ── act ── */
      let result: ActionResult;
      let agent: AgentSpec | null = null;
      const resume = wake?.resume;
      wake = null;
      try {
        agent = await agentNamed(this.env, (typeof settings["agentId"] === "string" && settings["agentId"]) || node.agentId || one.agent);
        const running: Task = { ...base, status: "running", tries: attempt.tries, ...(agent ? { agent: agent.id } : {}) };
        await this.writeTask(running);
        attempt = { ...attempt, executing: true };
        one = await save({ ...one, attempt });
        const parent = one;
        const ctx: ActionContext = {
          env: this.env,
          workflow,
          case: one,
          node,
          variant,
          settings,
          scope,
          actor: one.actor ?? workflow.enabledBy ?? null,
          agent,
          attempt,
          ...(approval ? { approved: approval } : {}),
          ...(resume ? { resume } : {}),
          task: running,
          startCase: (workflowId, inputs, extra) => this.startChild(workflowId, inputs, parent, extra),
        };
        result = await executor(ctx);
        /* Lost the case while acting: whoever has it now decides; nothing more is written from here. */
        hold.check();
      } catch (error) {
        if (error instanceof ParkWorkflow) {
          await this.park(workflow, error.reason);
          await this.writeTask({ ...base, status: "failed", error: error.reason, outcome: "failed", finishedAt: this.iso() });
          return this.finish(one, "failed", `Paused: ${error.reason}`);
        }
        if (error instanceof RevisionConflict || error instanceof CaseBusy) throw error;
        result = { kind: "failed", error: error instanceof Error ? error.message : String(error) };
      }

      const task: Task = { ...base, ...(agent ? { agent: agent.id } : {}), ...(approval ? { approvedBy: approval.by.userId } : {}), tries: attempt.tries };

      if (result.kind === "wait") {
        /* The agent the step acts for goes with the wait, so checks made while waiting read as that agent may. */
        const wait: CaseWait = { ...result.wait, node: node.id, task: task.id, ...(agent ? { agent: agent.id } : {}) };
        /* The wait and what the step handed on are written together on the task, and the case is put to waiting from that, as recovery does. */
        const waitingTask: Task = { ...task, ...result.task, wait, outputs: { ...(result.outputs ?? {}), task: task.id } };
        await this.writeTask(waitingTask);
        await consumed();
        one = await save(this.waitingOn(one, attempt, node, waitingTask));
        /* Whatever it waits for may already have happened. */
        if (!PERSON_WAITS.has(wait.kind) && wait.key !== "time") {
          const signal = await this.env.signals.take(wait.key, one.id, one.startedAt);
          if (signal) {
            heldSignal = signal.id;
            const { waiting: _waiting, ...rest } = one;
            one = await save({ ...rest, status: "running" });
            wake = { resume: { kind: "event", payload: signal.payload } };
            continue;
          }
        }
        return one;
      }

      if (result.kind === "failed") {
        if (result.uncertain) {
          const asked = await this.uncertain(save, one, attempt, { ...task, ...result.task }, result.error);
          await consumed();
          return asked;
        }
        const retry = node.retry;
        if (result.retryable && retry && attempt.tries <= retry.times) {
          const delay = Math.min((durationMs(retry.delay) ?? 60_000) * 2 ** (attempt.tries - 1), MAX_RETRY_DELAY_MS);
          const retryAt = this.iso(this.env.now() + delay);
          const wait: CaseWait = { node: node.id, kind: "retry", key: "time", deadline: retryAt, task: task.id };
          /* The tries made are written with the retry, so recovery restores the count with the wait and never grants an extra try. */
          const retrying: Task = { ...task, ...result.task, status: "waiting", error: result.error, retryAt, wait, tries: attempt.tries, title: `${nodeName(node)}: trying again (${attempt.tries} of ${retry.times})` };
          await this.writeTask(retrying);
          await consumed();
          return save(this.waitingOn(one, attempt, node, retrying));
        }
        const failedTask: Task = { ...task, ...result.task, status: "failed", error: result.error, outcome: "failed", finishedAt: this.iso() };
        await this.writeTask(failedTask);
        await consumed();
        one = await this.applied(save, one, workflow, node, failedTask);
        if (one.status !== "running") return one;
        continue;
      }

      let finished: Task = { ...task, ...result.task, ...(agent && !result.task.agent ? { agent: agent.id } : {}), outcome: result.outcome, outputs: result.outputs ?? {}, finishedAt: this.iso() };
      if (finished.status === "running") finished = { ...finished, status: "done" };
      const { wait: _wait, ...withoutWait } = finished;
      await this.writeTask(withoutWait);
      await consumed();
      one = await this.applied(save, one, workflow, node, withoutWait);
      if (one.status !== "running") return one;
    }
  }

  /**
   * Move a case on from a task that has finished: its outputs into the case,
   * then down the arrow its outcome names. The only way a step's result
   * reaches the case, so recovery and a normal run do the same thing.
   */
  private async applied(save: (next: WorkflowCase) => Promise<WorkflowCase>, one: WorkflowCase, workflow: WorkflowSpec, node: WorkflowNode, task: Task): Promise<WorkflowCase> {
    const outcome = task.outcome ?? "next";
    const { __vars, ...outputs } = (task.outputs ?? {}) as Record<string, unknown> & { __vars?: Record<string, unknown> };
    const { attempt: _attempt, ...rest } = one;
    const data = task.status === "done" ? { ...one.data, steps: { ...one.data.steps, [node.id]: { ...outputs, task: task.id } }, vars: { ...one.data.vars, ...(__vars ?? {}) } } : one.data;
    const moved: WorkflowCase = { ...rest, data };
    if (outcome === "failed") {
      if (node.onFailure === "continue") return this.moveOn(save, moved, workflow, node, "next");
      const next = node.onFailure === "path" ? nextNode(workflow, node.id, "failed") : undefined;
      if (next) return save({ ...moved, at: next });
      return this.finish(moved, "failed", task.error ?? `${nodeName(node)} failed.`);
    }
    return this.moveOn(save, moved, workflow, node, outcome);
  }

  private async moveOn(save: (next: WorkflowCase) => Promise<WorkflowCase>, one: WorkflowCase, workflow: WorkflowSpec, node: WorkflowNode, outcome: string): Promise<WorkflowCase> {
    const next = nextNode(workflow, node.id, outcome);
    /* The last step: its result and the case's ending in one save, so recovery never finds it half-done. */
    if (!next) return this.finish(one, outcome === "timed_out" ? "timed_out" : "done");
    return save({ ...one, at: next });
  }

  /** A case put to waiting from a task that waits: the wait, and whatever the step handed on. Used by a normal run and by recovery alike. */
  private waitingOn(one: WorkflowCase, attempt: CaseAttempt, node: WorkflowNode, task: Task): WorkflowCase {
    /* A retry's next try is one more than the tries its task records. */
    const tries = task.wait?.kind === "retry" && task.tries !== undefined ? Math.max(attempt.tries, task.tries + 1) : attempt.tries;
    return {
      ...one,
      status: "waiting",
      waiting: task.wait!,
      attempt: { ...attempt, tries, executing: false },
      ...(task.outputs ? { data: { ...one.data, steps: { ...one.data.steps, [node.id]: task.outputs } } } : {}),
    };
  }

  /** It may or may not have happened: a person says which, and nothing is done again until they do. */
  private async uncertain(save: (next: WorkflowCase) => Promise<WorkflowCase>, one: WorkflowCase, attempt: CaseAttempt, task: Task, why: string): Promise<WorkflowCase> {
    const wait: CaseWait = { node: attempt.node, kind: "uncertain", key: `task:${task.id}`, task: task.id };
    const asked: Task = { ...task, status: "waiting_approval", uncertain: true, error: why, wait, reason: `${why} Check the other system, then say whether it happened, or run it again.` };
    await this.writeTask(asked);
    this.env.onEvent?.({ type: "task.waiting", task: asked.id, workflow: one.workflow, agent: asked.agent });
    return save({ ...one, status: "waiting", waiting: wait, attempt: { ...attempt, executing: false } });
  }

  /**
   * End a case in one save (with whatever the last step put in it), then
   * announce it. The save marks it not yet announced, so an interruption
   * before the announcement is finished is picked up by `recover()`.
   */
  private async finish(one: WorkflowCase, status: "done" | "failed" | "cancelled" | "timed_out", error?: string): Promise<WorkflowCase> {
    const { waiting: _waiting, attempt: _attempt, ...rest } = one;
    const ended = await this.env.cases.put({ ...rest, status, finishedAt: this.iso(), updatedAt: this.iso(), announced: false, ...(error ? { error } : {}) }, one.revision);
    this.env.onEvent?.({ type: "case.finished", workflow: ended.workflow, case: ended.id, status });
    return this.announce(ended);
  }

  /**
   * What follows a case's ending: its trial counted down, and whatever waits
   * on it told. Counting is one write that records which case it counted, so
   * announcing again never counts it twice; each signal has an id of its own
   * making, so telling twice tells once.
   */
  private async announce(ended: WorkflowCase): Promise<WorkflowCase> {
    const one = ended;
    if (one.trial) {
      const workflow = await this.env.store.get(one.workflow);
      if (workflow && workflow.trial > 0 && !workflow.trialCases.includes(one.id)) {
        await this.env.store.put({ ...workflow, trial: workflow.trial - 1, trialCases: [...workflow.trialCases, one.id].slice(-TRIAL_LEDGER) });
      }
    }
    /* A step in another case may be waiting for this one, or for all of its group. */
    await this.emit(`case-done:${one.id}`, { status: one.status, case: one.id }, `case-done:${one.id}`);
    const { parentCase, group, groupSize } = one.start;
    if (parentCase && group) {
      const siblings = (await this.env.cases.children(parentCase)).filter((child) => child.start.group === group);
      /* Done only when the whole group exists and has ended: a child that ends while others are still being started does not count for them. */
      if (siblings.length >= (groupSize ?? siblings.length) && siblings.every((child) => FINISHED.has(child.status))) {
        await this.emit(`group-done:${group}`, { statuses: Object.fromEntries(siblings.map((child) => [child.id, child.status])) }, `group-done:${group}`);
      }
    }
    return this.env.cases.put({ ...one, announced: true }, one.revision);
  }

  private async park(workflow: WorkflowSpec, reason: string): Promise<void> {
    const held = await this.env.store.get(workflow.id);
    if (held) await this.env.store.put({ ...held, parked: { reason, at: this.iso() } });
    this.env.onEvent?.({ type: "workflow.parked", workflow: workflow.id, reason });
  }

  /**
   * Start another workflow's case from a step. The child's id comes from the
   * step's attempt, so starting it twice opens it once. A workflow may not
   * start itself, however far down, and calls go no deeper than
   * `MAX_CALL_DEPTH`.
   */
  private async startChild(
    workflowId: string,
    inputs: Record<string, unknown>,
    parent: WorkflowCase,
    extra: { readonly key: string; readonly group?: string | undefined; readonly groupSize?: number | undefined },
  ): Promise<{ id: string; status: string }> {
    const workflow = await this.env.store.get(workflowId);
    if (!workflow) throw new Error(`There is no workflow "${workflowId}".`);
    if (workflowReads(workflow)) throw new Error(`"${workflow.name}" reads its own records, so it cannot be started by another workflow.`);
    const chain = [...parent.chain, parent.workflow];
    if (chain.includes(workflow.id)) throw new Error(`"${workflow.name}" is already running further up this chain of workflows, so starting it again would go round for ever.`);
    if (chain.length >= MAX_CALL_DEPTH) throw new Error(`Workflows can start workflows only ${MAX_CALL_DEPTH} deep.`);
    if (workflow.trigger.kind === "agent") {
      const missing = workflow.trigger.inputs.filter((one) => one.required && (inputs[one.name] === undefined || inputs[one.name] === null || inputs[one.name] === ""));
      if (missing.length > 0) throw new Error(`"${workflow.name}" needs ${missing.map((one) => one.name).join(", ")}.`);
    }
    const child = await this.open(workflow, {
      id: `${parent.id.slice(0, 24)}-${shortHash(extra.key)}`,
      inputs,
      start: { kind: "workflow", parentCase: parent.id, ...(extra.group ? { group: extra.group, ...(extra.groupSize ? { groupSize: extra.groupSize } : {}) } : {}), ...(parent.agent ? { agentId: parent.agent } : {}) },
      actor: parent.actor ?? null,
      chain,
    });
    return { id: child.id, status: child.status };
  }

  /* ── tasks ───────────────────────────────────────────────────────── */

  private newTask(workflow: WorkflowSpec, one: WorkflowCase, node: WorkflowNode, attempt: CaseAttempt, fields: Partial<Task>): Task {
    const variant = actionVariant(node.action);
    return {
      id: attempt.task,
      workflow: workflow.id,
      workflowName: workflow.name,
      case: one.id,
      node: node.id,
      attempt: attempt.id,
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

  private async dismissStale(id: string, why: string): Promise<void> {
    const task = await this.env.tasks.get(id);
    if (task && (task.status === "waiting_approval" || task.status === "waiting")) await this.env.tasks.put({ ...task, status: "dismissed", error: why, finishedAt: this.iso() });
  }

  /** One line for what an approval will do: "Text +1 555 0100 from Maintenance agent: …". */
  private proposalTitle(node: WorkflowNode, settings: Record<string, unknown>, workflow: WorkflowSpec, row: Readonly<Record<string, unknown>> = {}): string {
    const variant = actionVariant(node.action);
    if (variant && RECORD_CHANGE_VARIANTS.has(variant.id)) {
      const intent = intentFor(variant, settings, workflowReads(workflow)?.connection);
      if (intent) {
        const fields = Object.keys(intent.values ?? {});
        const verb = { create: "Create", update: "Update", delete: "Delete", action: `Run ${intent.action ?? "an action"} on` }[intent.kind];
        return `${verb} ${intent.entity}${intent.id ? ` ${intent.id}` : ""} on ${this.env.connectionTitle?.(intent.connection) ?? intent.connection}${fields.length > 0 ? `: ${fields.join(", ")}` : ""}`;
      }
    }
    if (variant?.id === "outreach.inform") {
      const who = text((row["contact"] as Record<string, unknown> | undefined)?.["name"]).trim() || text(settings["to"]).trim() || "them";
      return `Tell ${who} what was decided${typeof row["title"] === "string" ? `: ${row["title"]}` : ""}`;
    }
    if (variant?.base === "outreach") return `${variant.label} ${text(settings["to"])}: ${text(settings["purpose"]).slice(0, 80)}`;
    if (variant?.id === "send.webhook") return `Send to ${text(settings["url"])}`;
    return nodeName(node);
  }

  /** One case's trouble in a pass over many: told, and the pass goes on to the others. It is picked up again next pass. */
  private trouble(caseId: string, error: unknown): void {
    this.env.onEvent?.({ type: "case.error", case: caseId, message: error instanceof Error ? error.message : String(error) });
  }

  /* ── waking ──────────────────────────────────────────────────────── */

  /**
   * Something happened. It is kept first, so a case that starts waiting for
   * it later still hears it; then each case waiting for it now is woken, and
   * the first to take it has it. A case busy right now is left for the next
   * delivery (`deliverPending`), never skipped.
   */
  async emit(key: string, payload: Readonly<Record<string, unknown>> = {}, id?: string): Promise<number> {
    await this.env.signals.put({ id: id ?? this.env.newId(), key, at: this.iso(), payload });
    const woken = await this.deliver(key);
    if (woken === 0 && key.startsWith("task:")) {
      const task = await this.env.tasks.get(key.slice(5));
      if (task && FINAL_TASK_STATUSES.includes(task.status) && task.case && !(await this.env.cases.waitingOn(key)).length) {
        await this.env.tasks.put({ ...task, late: [...(task.late ?? []), { at: this.iso(), what: JSON.stringify(payload).slice(0, 500) }] });
      }
    }
    return woken;
  }

  private async deliver(key: string): Promise<number> {
    let woken = 0;
    for (const one of await this.env.cases.waitingOn(key)) {
      try {
        const after = await this.advance(one.id, { resume: { kind: "event" } });
        if (after.status !== "waiting" || after.waiting?.key !== key) woken++;
      } catch (error) {
        if (!(error instanceof CaseBusy || error instanceof RevisionConflict)) this.trouble(one.id, error);
      }
    }
    return woken;
  }

  /** Signals still untaken that a case is waiting for: delivered again. */
  async deliverPending(): Promise<number> {
    let woken = 0;
    for (const key of await this.env.signals.untaken(this.iso(this.env.now() - SIGNAL_KEEP_MS))) woken += await this.deliver(key);
    return woken;
  }

  /** Cases whose deadline has passed go down their time-out path, or try again. */
  async timeouts(): Promise<number> {
    let woken = 0;
    for (const one of await this.env.cases.overdue(this.iso())) {
      try {
        await this.advance(one.id, one.waiting?.kind === "retry" ? { retry: true } : { resume: { kind: "timeout" } });
        woken++;
      } catch (error) {
        if (!(error instanceof CaseBusy || error instanceof RevisionConflict)) this.trouble(one.id, error);
      }
    }
    return woken;
  }

  /** Cases left running by a call that stopped, or ended but not yet announced: carried on from what was written down. */
  async recover(): Promise<number> {
    let recovered = 0;
    const before = this.iso(this.env.now() - STALL_MS);
    for (const one of await this.env.cases.unannounced(before)) {
      if (this.active.has(one.id)) continue;
      try {
        await this.leased(one.id, async () => {
          const held = await this.env.cases.get(one.id);
          if (held?.announced === false) await this.announce(held);
        });
        recovered++;
      } catch (error) {
        if (!(error instanceof CaseBusy || error instanceof RevisionConflict)) this.trouble(one.id, error);
      }
    }
    for (const one of await this.env.cases.stalled(before)) {
      if (this.active.has(one.id)) continue;
      try {
        await this.advance(one.id);
        recovered++;
      } catch (error) {
        if (!(error instanceof CaseBusy || error instanceof RevisionConflict)) this.trouble(one.id, error);
      }
    }
    return recovered;
  }

  /** Waiting cases that watch a record: each read as the case may read, inside its lease. */
  async pollRecords(): Promise<number> {
    let woken = 0;
    for (const one of await this.env.cases.watchingRecords()) {
      try {
        const after = await this.advance(one.id, { poll: true });
        if (after.status !== "waiting") woken++;
      } catch (error) {
        if (!(error instanceof CaseBusy || error instanceof RevisionConflict)) this.trouble(one.id, error);
      }
    }
    return woken;
  }

  /**
   * Read the record a waiting case watches. Its condition holds: the record.
   * Not yet, or not reached: still waiting. Access gone: the workflow is
   * paused, the case ends, and nothing is read.
   */
  private async pollRecord(one: WorkflowCase, workflow: WorkflowSpec): Promise<Record<string, unknown> | "waiting" | "parked"> {
    const match = one.waiting?.match as { connection?: string; entity?: string; id?: string; condition?: string } | undefined;
    if (one.waiting?.kind !== "record_change" || !match?.connection || !match.entity || !match.id) return "waiting";
    try {
      const agent = await agentNamed(this.env, one.waiting?.agent ?? one.agent);
      const { record } = await readRecordAs(this.env, { actor: one.actor ?? workflow.enabledBy ?? null, agent }, { connection: match.connection, entity: match.entity, id: match.id });
      if (record && (!match.condition || passes(match.condition, record, this.env.now()))) return record;
      return "waiting";
    } catch (error) {
      if (!(error instanceof ParkWorkflow)) throw error;
      await this.park(workflow, error.reason);
      if (one.waiting?.task) await this.dismissStale(one.waiting.task, error.reason);
      await this.finish(one, "failed", `Paused: ${error.reason}`);
      return "parked";
    }
  }

  /**
   * Stop a case and the cases it started: sticky, even across a restart.
   *
   * The case is marked first, in its own save, and only then are its children
   * cancelled: a child's ending wakes this case, and the mark makes that
   * wake end it rather than carry it on. A waiting case then ends now; a
   * running one ends at its next step, whoever is running it.
   */
  async cancel(caseId: string): Promise<WorkflowCase> {
    let one: WorkflowCase | null = null;
    for (let tries = 0; tries < 10; tries++) {
      one = await this.env.cases.get(caseId);
      if (!one) throw new Error(`There is no case "${caseId}".`);
      if (FINISHED.has(one.status) || one.cancelRequested) break;
      try {
        one = await this.env.cases.put({ ...one, cancelRequested: true, updatedAt: this.iso() }, one.revision);
        break;
      } catch (error) {
        if (!(error instanceof RevisionConflict)) throw error;
      }
    }
    if (!one || FINISHED.has(one.status)) return one!;
    if (!one.cancelRequested) throw new CaseBusy(caseId);
    for (const child of await this.env.cases.children(one.id)) {
      if (!FINISHED.has(child.status)) await this.cancel(child.id).catch(() => undefined);
    }
    /* Waiting: ended now, under its lease. Busy: whoever has it ends it at its next step. */
    try {
      return await this.leased(caseId, async () => {
        const now = (await this.env.cases.get(caseId))!;
        if (now.status !== "waiting") return now;
        if (now.waiting?.task) await this.dismissStale(now.waiting.task, "The case was cancelled.");
        return this.finish(now, "cancelled", "Cancelled.");
      });
    } catch (error) {
      if (error instanceof CaseBusy) return (await this.env.cases.get(caseId))!;
      throw error;
    }
  }
}

const text = (value: unknown): string => (value === undefined || value === null ? "" : typeof value === "string" ? value : String(value));

export type { AgentSpec };
