import {
  calendarEventSchema,
  proposalSchema,
  workflowRunSchema,
  workflowSchema,
  type CalendarEvent,
  type Proposal,
  type ProposalStatus,
  type WorkflowRun,
  type WorkflowSpec,
} from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * Where a workspace's workflows, their runs and what each has already acted
 * on are kept (`@freebirdai/dash-spec` `workflow.ts`); and, beside them, what
 * waits for a person (proposals) and the calendar entries steps make.
 *
 * Plug-in points like the others: memory for tests and embedders, Dash's
 * database in the open-source build. One store answers for one workspace.
 */

/**
 * The key a workflow's first look at an API is marked done under. A real row
 * never has an empty key — a row without one is skipped — so it cannot clash.
 */
export const SEEDED_KEY = "";

export interface WorkflowStore {
  /** Every workflow, in the order they were made. */
  list(): Promise<WorkflowSpec[]>;
  get(id: string): Promise<WorkflowSpec | null>;
  put(workflow: WorkflowSpec): Promise<void>;
  /** Removes the workflow and what it had acted on. Its runs stay, as history. */
  delete(id: string): Promise<void>;

  putRun(run: WorkflowRun): Promise<void>;
  /** Newest first: every workflow's, or one's. */
  runs(options?: { readonly workflow?: string; readonly limit?: number }): Promise<WorkflowRun[]>;

  /**
   * What a workflow has already seen or acted on, by row key, with each row's
   * fingerprint. An API trigger keeps every row it has seen, to tell new rows
   * and changed ones from the rest; `once: "per-row"` keeps the rows it acted on.
   */
  fired(workflow: string): Promise<Map<string, string>>;
  markFired(workflow: string, rows: ReadonlyArray<{ readonly key: string; readonly fingerprint: string }>, at: string): Promise<void>;
  unfire(workflow: string, keys: readonly string[]): Promise<void>;
  /** Forget everything it has seen: its trigger or what it reads changed. */
  clearFired(workflow: string): Promise<void>;
}

export interface ProposalStore {
  put(proposal: Proposal): Promise<void>;
  get(id: string): Promise<Proposal | null>;
  /** Newest first. */
  list(options?: { readonly status?: ProposalStatus; readonly workflow?: string; readonly limit?: number }): Promise<Proposal[]>;
}

export interface CalendarStore {
  put(event: CalendarEvent): Promise<void>;
  /** In time order. */
  list(options?: { readonly from?: string; readonly to?: string; readonly limit?: number }): Promise<CalendarEvent[]>;
}

const byCreation = (a: WorkflowSpec, b: WorkflowSpec): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const limitOf = (limit: number | undefined, fallback = 50): number => Math.min(Math.max(limit ?? fallback, 1), 500);

/* ── memory ────────────────────────────────────────────────────────────── */

export class MemoryWorkflowStore implements WorkflowStore {
  private readonly rows = new Map<string, WorkflowSpec>();
  private readonly runRows = new Map<string, WorkflowRun>();
  private readonly seen = new Map<string, Map<string, string>>();

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
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
      .slice(0, limitOf(options.limit));
  }
  async fired(workflow: string): Promise<Map<string, string>> {
    return new Map(this.seen.get(workflow) ?? []);
  }
  async markFired(workflow: string, rows: ReadonlyArray<{ key: string; fingerprint: string }>, _at?: string): Promise<void> {
    const held = this.seen.get(workflow) ?? new Map<string, string>();
    for (const row of rows) held.set(row.key, row.fingerprint);
    this.seen.set(workflow, held);
  }
  async unfire(workflow: string, keys: readonly string[]): Promise<void> {
    const held = this.seen.get(workflow);
    for (const key of keys) held?.delete(key);
  }
  async clearFired(workflow: string): Promise<void> {
    this.seen.delete(workflow);
  }
}

export class MemoryProposalStore implements ProposalStore {
  private readonly rows = new Map<string, Proposal>();
  async put(proposal: Proposal): Promise<void> {
    this.rows.set(proposal.id, proposalSchema.parse(proposal));
  }
  async get(id: string): Promise<Proposal | null> {
    return this.rows.get(id) ?? null;
  }
  async list(options: { status?: ProposalStatus; workflow?: string; limit?: number } = {}): Promise<Proposal[]> {
    return [...this.rows.values()]
      .filter((one) => (options.status === undefined || one.status === options.status) && (options.workflow === undefined || one.workflow === options.workflow))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limitOf(options.limit));
  }
}

export class MemoryCalendarStore implements CalendarStore {
  private readonly rows = new Map<string, CalendarEvent>();
  async put(event: CalendarEvent): Promise<void> {
    this.rows.set(event.id, calendarEventSchema.parse(event));
  }
  async list(options: { from?: string; to?: string; limit?: number } = {}): Promise<CalendarEvent[]> {
    return [...this.rows.values()]
      .filter((one) => (options.from === undefined || one.at >= options.from) && (options.to === undefined || one.at < options.to))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .slice(0, limitOf(options.limit, 200));
  }
}

/* ── Dash's database ───────────────────────────────────────────────────── */

const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

export class DbWorkflowStore implements WorkflowStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async list(): Promise<WorkflowSpec[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflows WHERE workspace = ${this.workspace}
    `.execute(this.db.kysely);
    return result.rows.map((row) => workflowSchema.parse(parsed(row.record))).sort(byCreation);
  }

  async get(id: string): Promise<WorkflowSpec | null> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_workflows WHERE workspace = ${this.workspace} AND id = ${id}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? workflowSchema.parse(parsed(row.record)) : null;
  }

  async put(workflow: WorkflowSpec): Promise<void> {
    const one = workflowSchema.parse(workflow);
    await sql`
      INSERT INTO dash_workflows (workspace, id, record) VALUES (${this.workspace}, ${one.id}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }

  async delete(id: string): Promise<void> {
    await sql`DELETE FROM dash_workflows WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    await this.clearFired(id);
  }

  async putRun(run: WorkflowRun): Promise<void> {
    const one = workflowRunSchema.parse(run);
    await sql`
      INSERT INTO dash_workflow_runs
        (workspace, id, workflow, agent, trigger_kind, started_at, finished_at, status, matched, summary, outputs, error, record)
      VALUES (${this.workspace}, ${one.id}, ${one.workflow}, ${one.agent ?? null}, ${one.start.kind}, ${one.startedAt},
              ${one.finishedAt ?? null}, ${one.status}, ${one.matched}, ${one.summary}, ${JSON.stringify(one.outputs)}::jsonb,
              ${one.error ?? null}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET
        agent = EXCLUDED.agent, finished_at = EXCLUDED.finished_at, status = EXCLUDED.status, matched = EXCLUDED.matched,
        summary = EXCLUDED.summary, outputs = EXCLUDED.outputs, error = EXCLUDED.error, record = EXCLUDED.record
    `.execute(this.db.kysely);
  }

  async runs(options: { workflow?: string; limit?: number } = {}): Promise<WorkflowRun[]> {
    const limit = limitOf(options.limit);
    const result = options.workflow
      ? await sql<{ record: unknown }>`
          SELECT record FROM dash_workflow_runs WHERE workspace = ${this.workspace} AND workflow = ${options.workflow}
          ORDER BY started_at DESC, id DESC LIMIT ${limit}
        `.execute(this.db.kysely)
      : await sql<{ record: unknown }>`
          SELECT record FROM dash_workflow_runs WHERE workspace = ${this.workspace}
          ORDER BY started_at DESC, id DESC LIMIT ${limit}
        `.execute(this.db.kysely);
    return result.rows.map((row) => workflowRunSchema.parse(parsed(row.record)));
  }

  async fired(workflow: string): Promise<Map<string, string>> {
    const result = await sql<{ row_key: string; fingerprint: string }>`
      SELECT row_key, fingerprint FROM dash_workflow_fired WHERE workspace = ${this.workspace} AND workflow = ${workflow}
    `.execute(this.db.kysely);
    return new Map(result.rows.map((row) => [row.row_key, row.fingerprint]));
  }

  async markFired(workflow: string, rows: ReadonlyArray<{ key: string; fingerprint: string }>, at: string): Promise<void> {
    for (const row of rows) {
      await sql`
        INSERT INTO dash_workflow_fired (workspace, workflow, row_key, fingerprint, fired_at)
        VALUES (${this.workspace}, ${workflow}, ${row.key}, ${row.fingerprint}, ${at})
        ON CONFLICT (workspace, workflow, row_key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, fired_at = EXCLUDED.fired_at
      `.execute(this.db.kysely);
    }
  }

  async unfire(workflow: string, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await sql`
        DELETE FROM dash_workflow_fired WHERE workspace = ${this.workspace} AND workflow = ${workflow} AND row_key = ${key}
      `.execute(this.db.kysely);
    }
  }

  async clearFired(workflow: string): Promise<void> {
    await sql`DELETE FROM dash_workflow_fired WHERE workspace = ${this.workspace} AND workflow = ${workflow}`.execute(this.db.kysely);
  }
}

export class DbProposalStore implements ProposalStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async put(proposal: Proposal): Promise<void> {
    const one = proposalSchema.parse(proposal);
    await sql`
      INSERT INTO dash_proposals
        (workspace, id, kind, agent, workflow, run, conversation, intent, reason, status, created_at, decided_at, decided_by, journal_id, record)
      VALUES (${this.workspace}, ${one.id}, ${one.kind}, ${one.agent ?? null}, ${one.workflow ?? null}, ${one.run ?? null},
              ${one.conversation ?? null}, ${JSON.stringify(one.intent)}::jsonb, ${one.reason}, ${one.status}, ${one.createdAt},
              ${one.decidedAt ?? null}, ${one.decidedBy ?? null}, ${one.journalId ?? null}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET
        status = EXCLUDED.status, decided_at = EXCLUDED.decided_at, decided_by = EXCLUDED.decided_by,
        journal_id = EXCLUDED.journal_id, record = EXCLUDED.record
    `.execute(this.db.kysely);
  }

  async get(id: string): Promise<Proposal | null> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_proposals WHERE workspace = ${this.workspace} AND id = ${id}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? proposalSchema.parse(parsed(row.record)) : null;
  }

  async list(options: { status?: ProposalStatus; workflow?: string; limit?: number } = {}): Promise<Proposal[]> {
    const limit = limitOf(options.limit);
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_proposals
      WHERE workspace = ${this.workspace}
        AND (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
        AND (${options.workflow ?? null}::text IS NULL OR workflow = ${options.workflow ?? null})
      ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `.execute(this.db.kysely);
    return result.rows.map((row) => proposalSchema.parse(parsed(row.record)));
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

  async list(options: { from?: string; to?: string; limit?: number } = {}): Promise<CalendarEvent[]> {
    const limit = limitOf(options.limit, 200);
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_calendar_events
      WHERE workspace = ${this.workspace}
        AND (${options.from ?? null}::text IS NULL OR at >= ${options.from ?? null})
        AND (${options.to ?? null}::text IS NULL OR at < ${options.to ?? null})
      ORDER BY at, id LIMIT ${limit}
    `.execute(this.db.kysely);
    return result.rows.map((row) => calendarEventSchema.parse(parsed(row.record)));
  }
}
