import {
  calendarEventSchema,
  taskSchema,
  workflowCaseSchema,
  workflowRunSchema,
  workflowSchema,
  workflowTemplateSchema,
  type CalendarEvent,
  type CaseStatus,
  type Task,
  type TaskStatus,
  type WorkflowCase,
  type WorkflowRun,
  type WorkflowSpec,
  type WorkflowTemplate,
} from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * Where a workspace's workflows are kept, with everything they make: runs,
 * cases (one record's way through a workflow), tasks (one record per action),
 * calendar entries and templates.
 *
 * Plug-in points like the others: memory for tests and embedders, Dash's
 * database in the open-source build. One store answers for one workspace.
 */

/** The key a workflow's first look at an API is marked done under. A real row never has an empty key. */
export const SEEDED_KEY = "";

/** Everything needed to open a claimed record's case, kept with the claim until the case exists. */
export interface PendingOpen {
  readonly caseId: string;
  readonly row: Record<string, unknown>;
  readonly inputs: Record<string, unknown>;
  readonly start: Record<string, unknown>;
  readonly run?: string | undefined;
  readonly actor?: Record<string, unknown> | undefined;
  readonly at: string;
}

/**
 * What a workflow has seen of one record: its fingerprint, how many cases it
 * has opened in all (never reset while the trigger stays the same, so each
 * occurrence has its own number), and when last. `pending` is a claim whose
 * case has not been opened yet.
 */
export interface FiredRow {
  readonly fingerprint: string;
  readonly count: number;
  readonly lastAt?: string | undefined;
  readonly pending?: PendingOpen | undefined;
}

export interface WorkflowStore {
  list(): Promise<WorkflowSpec[]>;
  get(id: string): Promise<WorkflowSpec | null>;
  put(workflow: WorkflowSpec): Promise<void>;
  delete(id: string): Promise<void>;

  putRun(run: WorkflowRun): Promise<void>;
  /** Newest first. */
  runs(options?: { readonly workflow?: string; readonly limit?: number }): Promise<WorkflowRun[]>;

  fired(workflow: string): Promise<Map<string, FiredRow>>;
  markFired(workflow: string, rows: ReadonlyArray<{ readonly key: string } & FiredRow>): Promise<void>;
  /**
   * Claim one record for a case: write `next` only if what is stored is still
   * `before` (absent: nothing stored). False when another run claimed it first,
   * so two runs never open a case for the same record.
   */
  claimFired(workflow: string, key: string, before: FiredRow | undefined, next: FiredRow): Promise<boolean>;
  /** The claim's case is open: clear its pending open, if it is still that one. */
  settleClaim(workflow: string, key: string, caseId: string): Promise<void>;
  /** Claims whose case was never opened, made before `before`, in every workflow. */
  pendingClaims(before: string): Promise<Array<{ readonly workflow: string; readonly key: string; readonly pending: PendingOpen }>>;
  unfire(workflow: string, keys: readonly string[]): Promise<void>;
  clearFired(workflow: string): Promise<void>;
}

/** A write whose revision is not the stored one: somebody else moved the case on first. */
export class RevisionConflict extends Error {
  constructor(readonly caseId: string) {
    super(`Case ${caseId} changed underneath this write.`);
    this.name = "RevisionConflict";
  }
}

export interface CaseStore {
  get(id: string): Promise<WorkflowCase | null>;
  /**
   * Save a case. `expected` is the revision it was read at (absent for a new
   * one); the stored revision must match or the write is refused. The saved
   * case comes back with its revision moved on.
   */
  put(one: WorkflowCase, expected?: number): Promise<WorkflowCase>;
  /** Newest first. */
  list(options?: { readonly workflow?: string; readonly status?: CaseStatus; readonly limit?: number }): Promise<WorkflowCase[]>;
  /** Cases waiting on this key. */
  waitingOn(key: string): Promise<WorkflowCase[]>;
  /** Waiting cases whose deadline has passed. */
  overdue(now: string): Promise<WorkflowCase[]>;
  /** Waiting cases that watch a record for a change. */
  watchingRecords(): Promise<WorkflowCase[]>;
  /** Running cases nobody has moved on since `before`: interrupted, to be recovered. */
  stalled(before: string): Promise<WorkflowCase[]>;
  /** Cases another case started. */
  children(parent: string): Promise<WorkflowCase[]>;
  /** Ended cases whose ending was not yet announced, ended before `before`. */
  unannounced(before: string): Promise<WorkflowCase[]>;
}

/** Something that happened that a case may wait for: kept until one case takes it. */
export interface WorkflowSignal {
  readonly id: string;
  /** What a waiting case's `waiting.key` must be to take it. */
  readonly key: string;
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly takenBy?: string | undefined;
  readonly acked?: boolean | undefined;
}

/**
 * The inbox of things that happened: a reply, an answer, a webhook call, a
 * case ending. Kept whether or not a case is waiting yet, so one that starts
 * waiting later still hears it.
 *
 * Taking is in two parts. `take` claims a signal for one case; the case may
 * take it again (after an interruption) until it `ack`s it, which it does
 * only once what the signal caused is saved. No other case can take it in
 * between. Putting a signal whose id is already kept does nothing.
 */
export interface SignalStore {
  put(signal: WorkflowSignal): Promise<void>;
  /** The oldest signal for this key since `since` that nobody else holds and nobody has acknowledged, claimed for this case; null when there is none. Atomic. */
  take(key: string, by: string, since: string): Promise<WorkflowSignal | null>;
  /** What the signal caused is saved: it is done with. */
  ack(id: string): Promise<void>;
  /** Keys with signals not yet acknowledged since `since`. */
  untaken(since: string): Promise<string[]>;
}

export interface TaskStore {
  put(task: Task): Promise<void>;
  get(id: string): Promise<Task | null>;
  /** Newest first. */
  list(options?: { readonly status?: TaskStatus; readonly workflow?: string; readonly case?: string; readonly limit?: number }): Promise<Task[]>;
}

export interface CalendarStore {
  put(event: CalendarEvent): Promise<void>;
  delete(id: string): Promise<void>;
  /** In time order. */
  list(options?: { readonly from?: string; readonly to?: string; readonly limit?: number }): Promise<CalendarEvent[]>;
}

export interface TemplateStore {
  list(): Promise<WorkflowTemplate[]>;
  get(id: string): Promise<WorkflowTemplate | null>;
  put(template: WorkflowTemplate): Promise<void>;
  delete(id: string): Promise<void>;
}

const byCreation = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const limitOf = (limit: number | undefined, fallback = 50): number => Math.min(Math.max(limit ?? fallback, 1), 1000);
const newestFirst = <T extends { id: string }>(at: (one: T) => string) => (a: T, b: T) => at(b).localeCompare(at(a)) || b.id.localeCompare(a.id);

/* ── memory ────────────────────────────────────────────────────────────── */

export class MemoryWorkflowStore implements WorkflowStore {
  private readonly rows = new Map<string, WorkflowSpec>();
  private readonly runRows = new Map<string, WorkflowRun>();
  private readonly seen = new Map<string, Map<string, FiredRow>>();

  async list(): Promise<WorkflowSpec[]> {
    return [...this.rows.values()].sort(byCreation);
  }
  async get(id: string): Promise<WorkflowSpec | null> {
    return this.rows.get(id) ?? null;
  }
  async put(workflow: WorkflowSpec): Promise<void> {
    this.rows.set(workflow.id, workflowSchema.parse(workflow));
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
    this.seen.delete(id);
  }
  async putRun(run: WorkflowRun): Promise<void> {
    this.runRows.set(run.id, workflowRunSchema.parse(run));
  }
  async runs(options: { workflow?: string; limit?: number } = {}): Promise<WorkflowRun[]> {
    return [...this.runRows.values()]
      .filter((run) => options.workflow === undefined || run.workflow === options.workflow)
      .sort(newestFirst((run) => run.startedAt))
      .slice(0, limitOf(options.limit));
  }
  async fired(workflow: string): Promise<Map<string, FiredRow>> {
    return new Map(this.seen.get(workflow) ?? []);
  }
  async markFired(workflow: string, rows: ReadonlyArray<{ key: string } & FiredRow>): Promise<void> {
    const held = this.seen.get(workflow) ?? new Map<string, FiredRow>();
    for (const { key, ...row } of rows) held.set(key, row);
    this.seen.set(workflow, held);
  }
  async claimFired(workflow: string, key: string, before: FiredRow | undefined, next: FiredRow): Promise<boolean> {
    const held = this.seen.get(workflow) ?? new Map<string, FiredRow>();
    const now = held.get(key);
    if (before === undefined ? now !== undefined : now === undefined || now.fingerprint !== before.fingerprint || now.count !== before.count) return false;
    held.set(key, next);
    this.seen.set(workflow, held);
    return true;
  }
  async unfire(workflow: string, keys: readonly string[]): Promise<void> {
    const held = this.seen.get(workflow);
    for (const key of keys) held?.delete(key);
  }
  async settleClaim(workflow: string, key: string, caseId: string): Promise<void> {
    const held = this.seen.get(workflow);
    const row = held?.get(key);
    if (row?.pending?.caseId === caseId) {
      const { pending: _pending, ...rest } = row;
      held!.set(key, rest);
    }
  }
  async pendingClaims(before: string): Promise<Array<{ workflow: string; key: string; pending: PendingOpen }>> {
    const out: Array<{ workflow: string; key: string; pending: PendingOpen }> = [];
    for (const [workflow, rows] of this.seen) for (const [key, row] of rows) if (row.pending && row.pending.at <= before) out.push({ workflow, key, pending: row.pending });
    return out;
  }
  async clearFired(workflow: string): Promise<void> {
    this.seen.delete(workflow);
  }
}

export class MemoryCaseStore implements CaseStore {
  private readonly rows = new Map<string, WorkflowCase>();
  async get(id: string): Promise<WorkflowCase | null> {
    return this.rows.get(id) ?? null;
  }
  async put(one: WorkflowCase, expected?: number): Promise<WorkflowCase> {
    const held = this.rows.get(one.id);
    if (held && held.revision !== expected) throw new RevisionConflict(one.id);
    if (!held && expected !== undefined) throw new RevisionConflict(one.id);
    const next = workflowCaseSchema.parse({ ...one, revision: (held?.revision ?? -1) + 1 });
    this.rows.set(one.id, next);
    return next;
  }
  async list(options: { workflow?: string; status?: CaseStatus; limit?: number } = {}): Promise<WorkflowCase[]> {
    return [...this.rows.values()]
      .filter((one) => (options.workflow === undefined || one.workflow === options.workflow) && (options.status === undefined || one.status === options.status))
      .sort(newestFirst((one) => one.startedAt))
      .slice(0, limitOf(options.limit, 200));
  }
  async waitingOn(key: string): Promise<WorkflowCase[]> {
    return [...this.rows.values()].filter((one) => one.status === "waiting" && one.waiting?.key === key);
  }
  async overdue(now: string): Promise<WorkflowCase[]> {
    return [...this.rows.values()].filter((one) => one.status === "waiting" && one.waiting?.deadline !== undefined && one.waiting.deadline <= now);
  }
  async watchingRecords(): Promise<WorkflowCase[]> {
    return [...this.rows.values()].filter((one) => one.status === "waiting" && one.waiting?.kind === "record_change");
  }
  async stalled(before: string): Promise<WorkflowCase[]> {
    return [...this.rows.values()].filter((one) => one.status === "running" && one.updatedAt <= before);
  }
  async children(parent: string): Promise<WorkflowCase[]> {
    return [...this.rows.values()].filter((one) => one.start.parentCase === parent);
  }
  async unannounced(before: string): Promise<WorkflowCase[]> {
    return [...this.rows.values()].filter((one) => one.announced === false && (one.finishedAt ?? one.updatedAt) <= before);
  }
}

export class MemorySignalStore implements SignalStore {
  private readonly rows: WorkflowSignal[] = [];
  async put(signal: WorkflowSignal): Promise<void> {
    if (!this.rows.some((one) => one.id === signal.id)) this.rows.push({ ...signal });
  }
  async take(key: string, by: string, since: string): Promise<WorkflowSignal | null> {
    const index = this.rows.findIndex((one) => one.key === key && !one.acked && (one.takenBy === undefined || one.takenBy === by) && one.at >= since);
    if (index < 0) return null;
    const taken = { ...this.rows[index]!, takenBy: by };
    this.rows[index] = taken;
    return taken;
  }
  async ack(id: string): Promise<void> {
    const index = this.rows.findIndex((one) => one.id === id);
    if (index >= 0) this.rows[index] = { ...this.rows[index]!, acked: true };
  }
  async untaken(since: string): Promise<string[]> {
    return [...new Set(this.rows.filter((one) => !one.acked && one.at >= since).map((one) => one.key))];
  }
}

export class MemoryTaskStore implements TaskStore {
  private readonly rows = new Map<string, Task>();
  async put(task: Task): Promise<void> {
    this.rows.set(task.id, taskSchema.parse(task));
  }
  async get(id: string): Promise<Task | null> {
    return this.rows.get(id) ?? null;
  }
  async list(options: { status?: TaskStatus; workflow?: string; case?: string; limit?: number } = {}): Promise<Task[]> {
    return [...this.rows.values()]
      .filter(
        (one) =>
          (options.status === undefined || one.status === options.status) &&
          (options.workflow === undefined || one.workflow === options.workflow) &&
          (options.case === undefined || one.case === options.case),
      )
      .sort(newestFirst((one) => one.finishedAt ?? one.createdAt))
      .slice(0, limitOf(options.limit, 200));
  }
}

export class MemoryCalendarStore implements CalendarStore {
  private readonly rows = new Map<string, CalendarEvent>();
  async put(event: CalendarEvent): Promise<void> {
    this.rows.set(event.id, calendarEventSchema.parse(event));
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async list(options: { from?: string; to?: string; limit?: number } = {}): Promise<CalendarEvent[]> {
    return [...this.rows.values()]
      .filter((one) => (options.from === undefined || one.at >= options.from) && (options.to === undefined || one.at < options.to))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .slice(0, limitOf(options.limit, 200));
  }
}

export class MemoryTemplateStore implements TemplateStore {
  private readonly rows = new Map<string, WorkflowTemplate>();
  async list(): Promise<WorkflowTemplate[]> {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async get(id: string): Promise<WorkflowTemplate | null> {
    return this.rows.get(id) ?? null;
  }
  async put(template: WorkflowTemplate): Promise<void> {
    this.rows.set(template.id, workflowTemplateSchema.parse(template));
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

/* ── Dash's database ───────────────────────────────────────────────────── */

const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

/** One JSON record per row, by workspace and id: workflows and templates. */
class DbRecords<T extends { id: string }> {
  constructor(
    private readonly db: DashDb,
    private readonly workspace: string,
    private readonly table: "dash_workflows" | "dash_workflow_templates",
    private readonly parse: (value: unknown) => T,
  ) {}
  async list(): Promise<T[]> {
    const result = await sql<{ record: unknown }>`SELECT record FROM ${sql.table(this.table)} WHERE workspace = ${this.workspace}`.execute(this.db.kysely);
    return result.rows.map((row) => this.parse(parsed(row.record)));
  }
  async get(id: string): Promise<T | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM ${sql.table(this.table)} WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? this.parse(parsed(row.record)) : null;
  }
  async put(one: T): Promise<void> {
    await sql`
      INSERT INTO ${sql.table(this.table)} (workspace, id, record) VALUES (${this.workspace}, ${one.id}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async delete(id: string): Promise<void> {
    await sql`DELETE FROM ${sql.table(this.table)} WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
  }
}

export class DbWorkflowStore implements WorkflowStore {
  private readonly records: DbRecords<WorkflowSpec>;
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {
    this.records = new DbRecords(db, workspace, "dash_workflows", (value) => workflowSchema.parse(value));
  }
  async list(): Promise<WorkflowSpec[]> {
    return (await this.records.list()).sort(byCreation);
  }
  get(id: string): Promise<WorkflowSpec | null> {
    return this.records.get(id);
  }
  put(workflow: WorkflowSpec): Promise<void> {
    return this.records.put(workflowSchema.parse(workflow));
  }
  async delete(id: string): Promise<void> {
    await this.records.delete(id);
    await this.clearFired(id);
  }
  async putRun(run: WorkflowRun): Promise<void> {
    const one = workflowRunSchema.parse(run);
    await sql`
      INSERT INTO dash_workflow_runs (workspace, id, workflow, started_at, status, record)
      VALUES (${this.workspace}, ${one.id}, ${one.workflow}, ${one.startedAt}, ${one.status}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET status = EXCLUDED.status, record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async runs(options: { workflow?: string; limit?: number } = {}): Promise<WorkflowRun[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflow_runs
      WHERE workspace = ${this.workspace} AND (${options.workflow ?? null}::text IS NULL OR workflow = ${options.workflow ?? null})
      ORDER BY started_at DESC, id DESC LIMIT ${limitOf(options.limit)}
    `.execute(this.db.kysely);
    return result.rows.map((row) => workflowRunSchema.parse(parsed(row.record)));
  }
  async fired(workflow: string): Promise<Map<string, FiredRow>> {
    const result = await sql<{ row_key: string; fingerprint: string; fire_count: number; last_at: string | null; pending: unknown }>`
      SELECT row_key, fingerprint, fire_count, last_at, pending FROM dash_workflow_fired WHERE workspace = ${this.workspace} AND workflow = ${workflow}
    `.execute(this.db.kysely);
    return new Map(
      result.rows.map((row) => [
        row.row_key,
        { fingerprint: row.fingerprint, count: Number(row.fire_count), ...(row.last_at ? { lastAt: row.last_at } : {}), ...(row.pending ? { pending: parsed(row.pending) as PendingOpen } : {}) },
      ]),
    );
  }
  async markFired(workflow: string, rows: ReadonlyArray<{ key: string } & FiredRow>): Promise<void> {
    for (const row of rows) {
      await sql`
        INSERT INTO dash_workflow_fired (workspace, workflow, row_key, fingerprint, fire_count, last_at, pending)
        VALUES (${this.workspace}, ${workflow}, ${row.key}, ${row.fingerprint}, ${row.count}, ${row.lastAt ?? null}, ${row.pending ? JSON.stringify(row.pending) : null}::jsonb)
        ON CONFLICT (workspace, workflow, row_key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, fire_count = EXCLUDED.fire_count, last_at = EXCLUDED.last_at, pending = EXCLUDED.pending
      `.execute(this.db.kysely);
    }
  }
  async claimFired(workflow: string, key: string, before: FiredRow | undefined, next: FiredRow): Promise<boolean> {
    const result =
      before === undefined
        ? await sql`
            INSERT INTO dash_workflow_fired (workspace, workflow, row_key, fingerprint, fire_count, last_at, pending)
            VALUES (${this.workspace}, ${workflow}, ${key}, ${next.fingerprint}, ${next.count}, ${next.lastAt ?? null}, ${next.pending ? JSON.stringify(next.pending) : null}::jsonb)
            ON CONFLICT (workspace, workflow, row_key) DO NOTHING
          `.execute(this.db.kysely)
        : await sql`
            UPDATE dash_workflow_fired SET fingerprint = ${next.fingerprint}, fire_count = ${next.count}, last_at = ${next.lastAt ?? null}, pending = ${next.pending ? JSON.stringify(next.pending) : null}::jsonb
            WHERE workspace = ${this.workspace} AND workflow = ${workflow} AND row_key = ${key}
              AND fingerprint = ${before.fingerprint} AND fire_count = ${before.count}
          `.execute(this.db.kysely);
    return Number(result.numAffectedRows ?? 0) > 0;
  }
  async unfire(workflow: string, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await sql`DELETE FROM dash_workflow_fired WHERE workspace = ${this.workspace} AND workflow = ${workflow} AND row_key = ${key}`.execute(this.db.kysely);
    }
  }
  async settleClaim(workflow: string, key: string, caseId: string): Promise<void> {
    await sql`
      UPDATE dash_workflow_fired SET pending = NULL
      WHERE workspace = ${this.workspace} AND workflow = ${workflow} AND row_key = ${key} AND (pending->>'caseId') = ${caseId}
    `.execute(this.db.kysely);
  }
  async pendingClaims(before: string): Promise<Array<{ workflow: string; key: string; pending: PendingOpen }>> {
    const result = await sql<{ workflow: string; row_key: string; pending: unknown }>`
      SELECT workflow, row_key, pending FROM dash_workflow_fired
      WHERE workspace = ${this.workspace} AND pending IS NOT NULL AND (pending->>'at') <= ${before}
    `.execute(this.db.kysely);
    return result.rows.map((row) => ({ workflow: row.workflow, key: row.row_key, pending: parsed(row.pending) as PendingOpen }));
  }
  async clearFired(workflow: string): Promise<void> {
    await sql`DELETE FROM dash_workflow_fired WHERE workspace = ${this.workspace} AND workflow = ${workflow}`.execute(this.db.kysely);
  }
}

export class DbCaseStore implements CaseStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}
  private parse(rows: Array<{ record: unknown }>): WorkflowCase[] {
    return rows.map((row) => workflowCaseSchema.parse(parsed(row.record)));
  }
  async get(id: string): Promise<WorkflowCase | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_workflow_cases WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    return this.parse(result.rows)[0] ?? null;
  }
  async put(one: WorkflowCase, expected?: number): Promise<WorkflowCase> {
    const next = workflowCaseSchema.parse({ ...one, revision: expected === undefined ? 0 : expected + 1 });
    const columns = {
      status: next.status,
      waitKey: next.status === "waiting" ? (next.waiting?.key ?? null) : null,
      waitKind: next.status === "waiting" ? (next.waiting?.kind ?? null) : null,
      deadline: next.status === "waiting" ? (next.waiting?.deadline ?? null) : null,
    };
    if (expected === undefined) {
      const result = await sql`
        INSERT INTO dash_workflow_cases (workspace, id, workflow, status, wait_key, wait_kind, deadline, started_at, revision, record)
        VALUES (${this.workspace}, ${next.id}, ${next.workflow}, ${columns.status}, ${columns.waitKey}, ${columns.waitKind}, ${columns.deadline},
                ${next.startedAt}, ${next.revision}, ${JSON.stringify(next)}::jsonb)
        ON CONFLICT (workspace, id) DO NOTHING
      `.execute(this.db.kysely);
      if (Number(result.numAffectedRows ?? 1) === 0) throw new RevisionConflict(next.id);
      return next;
    }
    const result = await sql`
      UPDATE dash_workflow_cases SET status = ${columns.status}, wait_key = ${columns.waitKey}, wait_kind = ${columns.waitKind},
        deadline = ${columns.deadline}, revision = ${next.revision}, record = ${JSON.stringify(next)}::jsonb
      WHERE workspace = ${this.workspace} AND id = ${next.id} AND revision = ${expected}
    `.execute(this.db.kysely);
    if (Number(result.numAffectedRows ?? 0) === 0) throw new RevisionConflict(next.id);
    return next;
  }
  async list(options: { workflow?: string; status?: CaseStatus; limit?: number } = {}): Promise<WorkflowCase[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflow_cases
      WHERE workspace = ${this.workspace}
        AND (${options.workflow ?? null}::text IS NULL OR workflow = ${options.workflow ?? null})
        AND (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
      ORDER BY started_at DESC, id DESC LIMIT ${limitOf(options.limit, 200)}
    `.execute(this.db.kysely);
    return this.parse(result.rows);
  }
  async waitingOn(key: string): Promise<WorkflowCase[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflow_cases WHERE workspace = ${this.workspace} AND status = 'waiting' AND wait_key = ${key}
    `.execute(this.db.kysely);
    return this.parse(result.rows);
  }
  async overdue(now: string): Promise<WorkflowCase[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflow_cases WHERE workspace = ${this.workspace} AND status = 'waiting' AND deadline IS NOT NULL AND deadline <= ${now}
    `.execute(this.db.kysely);
    return this.parse(result.rows);
  }
  async watchingRecords(): Promise<WorkflowCase[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflow_cases WHERE workspace = ${this.workspace} AND status = 'waiting' AND wait_kind = 'record_change'
    `.execute(this.db.kysely);
    return this.parse(result.rows);
  }
  async stalled(before: string): Promise<WorkflowCase[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflow_cases WHERE workspace = ${this.workspace} AND status = 'running' AND (record->>'updatedAt') <= ${before}
    `.execute(this.db.kysely);
    return this.parse(result.rows);
  }
  async children(parent: string): Promise<WorkflowCase[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflow_cases WHERE workspace = ${this.workspace} AND (record->'start'->>'parentCase') = ${parent}
    `.execute(this.db.kysely);
    return this.parse(result.rows);
  }
  async unannounced(before: string): Promise<WorkflowCase[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflow_cases
      WHERE workspace = ${this.workspace} AND (record->>'announced') = 'false' AND COALESCE(record->>'finishedAt', record->>'updatedAt') <= ${before}
    `.execute(this.db.kysely);
    return this.parse(result.rows);
  }
}

export class DbSignalStore implements SignalStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}
  async put(signal: WorkflowSignal): Promise<void> {
    await sql`
      INSERT INTO dash_workflow_signals (workspace, id, key, at, payload) VALUES (${this.workspace}, ${signal.id}, ${signal.key}, ${signal.at}, ${JSON.stringify(signal.payload)}::jsonb)
      ON CONFLICT (workspace, id) DO NOTHING
    `.execute(this.db.kysely);
  }
  async take(key: string, by: string, since: string): Promise<WorkflowSignal | null> {
    /* One statement: the oldest row free to this case is claimed, or none is, whoever else is taking. */
    const result = await sql<{ id: string; key: string; at: string; payload: unknown }>`
      UPDATE dash_workflow_signals SET taken_by = ${by}
      WHERE workspace = ${this.workspace} AND id = (
        SELECT id FROM dash_workflow_signals
        WHERE workspace = ${this.workspace} AND key = ${key} AND NOT acked AND (taken_by IS NULL OR taken_by = ${by}) AND at >= ${since}
        ORDER BY at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) AND NOT acked AND (taken_by IS NULL OR taken_by = ${by})
      RETURNING id, key, at, payload
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? { id: row.id, key: row.key, at: row.at, payload: parsed(row.payload) as Record<string, unknown>, takenBy: by } : null;
  }
  async ack(id: string): Promise<void> {
    await sql`UPDATE dash_workflow_signals SET acked = true WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
  }
  async untaken(since: string): Promise<string[]> {
    const result = await sql<{ key: string }>`
      SELECT DISTINCT key FROM dash_workflow_signals WHERE workspace = ${this.workspace} AND NOT acked AND at >= ${since}
    `.execute(this.db.kysely);
    return result.rows.map((row) => row.key);
  }
}

export class DbTaskStore implements TaskStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}
  async put(task: Task): Promise<void> {
    const one = taskSchema.parse(task);
    await sql`
      INSERT INTO dash_tasks (workspace, id, workflow, case_id, status, at, record)
      VALUES (${this.workspace}, ${one.id}, ${one.workflow ?? null}, ${one.case ?? null}, ${one.status}, ${one.finishedAt ?? one.createdAt}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET status = EXCLUDED.status, at = EXCLUDED.at, record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async get(id: string): Promise<Task | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_tasks WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? taskSchema.parse(parsed(row.record)) : null;
  }
  async list(options: { status?: TaskStatus; workflow?: string; case?: string; limit?: number } = {}): Promise<Task[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_tasks
      WHERE workspace = ${this.workspace}
        AND (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
        AND (${options.workflow ?? null}::text IS NULL OR workflow = ${options.workflow ?? null})
        AND (${options.case ?? null}::text IS NULL OR case_id = ${options.case ?? null})
      ORDER BY at DESC, id DESC LIMIT ${limitOf(options.limit, 200)}
    `.execute(this.db.kysely);
    return result.rows.map((row) => taskSchema.parse(parsed(row.record)));
  }
}

export class DbCalendarStore implements CalendarStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}
  async put(event: CalendarEvent): Promise<void> {
    const one = calendarEventSchema.parse(event);
    await sql`
      INSERT INTO dash_calendar_events (workspace, id, at, record) VALUES (${this.workspace}, ${one.id}, ${one.at}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET at = EXCLUDED.at, record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async delete(id: string): Promise<void> {
    await sql`DELETE FROM dash_calendar_events WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
  }
  async list(options: { from?: string; to?: string; limit?: number } = {}): Promise<CalendarEvent[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_calendar_events
      WHERE workspace = ${this.workspace}
        AND (${options.from ?? null}::text IS NULL OR at >= ${options.from ?? null})
        AND (${options.to ?? null}::text IS NULL OR at < ${options.to ?? null})
      ORDER BY at, id LIMIT ${limitOf(options.limit, 200)}
    `.execute(this.db.kysely);
    return result.rows.map((row) => calendarEventSchema.parse(parsed(row.record)));
  }
}

export class DbTemplateStore implements TemplateStore {
  private readonly records: DbRecords<WorkflowTemplate>;
  constructor(db: DashDb, workspace = "local") {
    this.records = new DbRecords(db, workspace, "dash_workflow_templates", (value) => workflowTemplateSchema.parse(value));
  }
  async list(): Promise<WorkflowTemplate[]> {
    return (await this.records.list()).sort((a, b) => a.name.localeCompare(b.name));
  }
  get(id: string): Promise<WorkflowTemplate | null> {
    return this.records.get(id);
  }
  put(template: WorkflowTemplate): Promise<void> {
    return this.records.put(workflowTemplateSchema.parse(template));
  }
  delete(id: string): Promise<void> {
    return this.records.delete(id);
  }
}
