import { evalRunSchema, scenarioSchema, type EvalRun, type Scenario } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import { z } from "zod";
import type { DashDb } from "../platform/db.js";
import type { Calibration } from "./judge.js";

/** Finished scenario runs, newest first: the Evals tab, the Test button's history and the graduation rule read them. */
export interface EvalRunStore {
  put(run: EvalRun): Promise<void>;
  get(id: string): Promise<EvalRun | null>;
  list(options?: { readonly workflow?: string; readonly limit?: number }): Promise<EvalRun[]>;
  /** How a judge's rubric agrees with the team, by the rubric's hash. */
  calibration(rubric: string): Promise<Calibration | null>;
  putCalibration(calibration: Calibration): Promise<void>;
  settings(): Promise<EvalSettings>;
  putSettings(settings: EvalSettings): Promise<void>;
  /** Scenarios saved from the workspace's own tasks, redacted. */
  scenarios(): Promise<Scenario[]>;
  putScenario(scenario: Scenario): Promise<void>;
  deleteScenario(id: string): Promise<void>;
}

/** The weekly eval summary: on or off, who gets it (nobody named: the whole team), and when it last went. */
export const evalSettingsSchema = z.object({
  weekly: z.object({ enabled: z.boolean().default(false), to: z.array(z.string().email()).max(50).default([]) }).default({}),
  lastSentAt: z.string().optional(),
});
export type EvalSettings = z.infer<typeof evalSettingsSchema>;

const calibrationSchema = z.object({ rubric: z.string(), agreement: z.number(), examples: z.number().int(), at: z.string() });

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
  private readonly calibrations = new Map<string, Calibration>();
  private held: EvalSettings = evalSettingsSchema.parse({});
  async calibration(rubric: string): Promise<Calibration | null> {
    return this.calibrations.get(rubric) ?? null;
  }
  async putCalibration(calibration: Calibration): Promise<void> {
    this.calibrations.set(calibration.rubric, calibrationSchema.parse(calibration));
  }
  async settings(): Promise<EvalSettings> {
    return this.held;
  }
  async putSettings(settings: EvalSettings): Promise<void> {
    this.held = evalSettingsSchema.parse(settings);
  }
  private readonly saved = new Map<string, Scenario>();
  async scenarios(): Promise<Scenario[]> {
    return [...this.saved.values()];
  }
  async putScenario(scenario: Scenario): Promise<void> {
    this.saved.set(scenario.id, scenarioSchema.parse(scenario));
  }
  async deleteScenario(id: string): Promise<void> {
    this.saved.delete(id);
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
  async calibration(rubric: string): Promise<Calibration | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_eval_meta WHERE workspace = ${this.workspace} AND key = ${`calibration:${rubric}`}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? calibrationSchema.parse(parsed(row.record)) : null;
  }
  async putCalibration(calibration: Calibration): Promise<void> {
    await this.putMeta(`calibration:${calibration.rubric}`, calibrationSchema.parse(calibration));
  }
  async settings(): Promise<EvalSettings> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_eval_meta WHERE workspace = ${this.workspace} AND key = ${"settings"}`.execute(this.db.kysely);
    const row = result.rows[0];
    return evalSettingsSchema.parse(row ? parsed(row.record) : {});
  }
  async putSettings(settings: EvalSettings): Promise<void> {
    await this.putMeta("settings", evalSettingsSchema.parse(settings));
  }
  async scenarios(): Promise<Scenario[]> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_eval_meta WHERE workspace = ${this.workspace} AND key LIKE ${"scenario:%"}`.execute(this.db.kysely);
    return result.rows.map((row) => scenarioSchema.parse(parsed(row.record)));
  }
  async putScenario(scenario: Scenario): Promise<void> {
    await this.putMeta(`scenario:${scenario.id}`, scenarioSchema.parse(scenario));
  }
  async deleteScenario(id: string): Promise<void> {
    await sql`DELETE FROM dash_eval_meta WHERE workspace = ${this.workspace} AND key = ${`scenario:${id}`}`.execute(this.db.kysely);
  }
  private async putMeta(key: string, value: unknown): Promise<void> {
    await sql`
      INSERT INTO dash_eval_meta (workspace, key, record) VALUES (${this.workspace}, ${key}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (workspace, key) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
}
