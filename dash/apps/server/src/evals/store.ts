import { evalRunSchema, type EvalRun } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/** Finished scenario runs, newest first: the Evals tab, the Test button's history and the graduation rule read them. */
export interface EvalRunStore {
  put(run: EvalRun): Promise<void>;
  get(id: string): Promise<EvalRun | null>;
  list(options?: { readonly workflow?: string; readonly limit?: number }): Promise<EvalRun[]>;
}

const workflowOf = (run: EvalRun): string | null => ("workflow" in run.target ? run.target.workflow : null);
const limitOf = (limit: number | undefined): number => Math.min(Math.max(limit ?? 50, 1), 500);
const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

export class MemoryEvalRunStore implements EvalRunStore {
  private readonly rows = new Map<string, EvalRun>();
  async put(run: EvalRun): Promise<void> {
    this.rows.set(run.id, evalRunSchema.parse(run));
  }
  async get(id: string): Promise<EvalRun | null> {
    return this.rows.get(id) ?? null;
  }
  async list(options: { workflow?: string; limit?: number } = {}): Promise<EvalRun[]> {
    return [...this.rows.values()]
      .filter((run) => options.workflow === undefined || workflowOf(run) === options.workflow)
      .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt) || b.id.localeCompare(a.id))
      .slice(0, limitOf(options.limit));
  }
}

export class DbEvalRunStore implements EvalRunStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}
  async put(run: EvalRun): Promise<void> {
    const one = evalRunSchema.parse(run);
    await sql`
      INSERT INTO dash_eval_runs (workspace, id, workflow, at, record)
      VALUES (${this.workspace}, ${one.id}, ${workflowOf(one)}, ${one.finishedAt ?? one.startedAt}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET workflow = EXCLUDED.workflow, at = EXCLUDED.at, record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async get(id: string): Promise<EvalRun | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_eval_runs WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? evalRunSchema.parse(parsed(row.record)) : null;
  }
  async list(options: { workflow?: string; limit?: number } = {}): Promise<EvalRun[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_eval_runs
      WHERE workspace = ${this.workspace}
        AND (${options.workflow ?? null}::text IS NULL OR workflow = ${options.workflow ?? null})
      ORDER BY at DESC, id DESC LIMIT ${limitOf(options.limit)}
    `.execute(this.db.kysely);
    return result.rows.map((row) => evalRunSchema.parse(parsed(row.record)));
  }
}
