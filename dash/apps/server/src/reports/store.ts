import { reportSchema, reportSendSchema, trackedValueSchema, type Report, type ReportSend, type TrackedValue } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * Where a workspace's reports, tracked values and the log of sends are kept.
 *
 * Plug-in point like the other stores: memory for tests and embedders, Dash's
 * database in the open-source build. One store answers for one workspace.
 * A tracked value's history is not here: it is kept in the snapshot store
 * (`history/`), under `TRACKED_DASHBOARD`.
 */

export interface SendListOptions {
  readonly report?: string;
  readonly limit?: number;
}

export interface ReportStore {
  listTracked(): Promise<TrackedValue[]>;
  getTracked(id: string): Promise<TrackedValue | null>;
  putTracked(value: TrackedValue): Promise<void>;
  deleteTracked(id: string): Promise<void>;

  list(): Promise<Report[]>;
  get(id: string): Promise<Report | null>;
  put(report: Report): Promise<void>;
  /** The report and its log. */
  delete(id: string): Promise<void>;
  /**
   * Take a report's turn to be sent: set `lastAttemptAt` to `at`, only if it
   * is still `previous`. False when another server took it first.
   */
  claim(id: string, previous: string | null, at: string): Promise<boolean>;

  addSend(send: ReportSend): Promise<void>;
  /** Newest first. */
  sends(options?: SendListOptions): Promise<ReportSend[]>;
}

const limitOf = (limit: number | undefined): number => Math.min(Math.max(limit ?? 50, 1), 1000);
const byName = <T extends { readonly name: string; readonly id: string }>(a: T, b: T): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/* ── memory ────────────────────────────────────────────────────────────── */

export class MemoryReportStore implements ReportStore {
  private readonly tracked = new Map<string, TrackedValue>();
  private readonly reports = new Map<string, Report>();
  private readonly log: ReportSend[] = [];

  async listTracked(): Promise<TrackedValue[]> {
    return [...this.tracked.values()].sort(byName);
  }
  async getTracked(id: string): Promise<TrackedValue | null> {
    return this.tracked.get(id) ?? null;
  }
  async putTracked(value: TrackedValue): Promise<void> {
    const one = trackedValueSchema.parse(value);
    this.tracked.set(one.id, one);
  }
  async deleteTracked(id: string): Promise<void> {
    this.tracked.delete(id);
  }

  async list(): Promise<Report[]> {
    return [...this.reports.values()].sort(byName);
  }
  async get(id: string): Promise<Report | null> {
    return this.reports.get(id) ?? null;
  }
  async put(report: Report): Promise<void> {
    const one = reportSchema.parse(report);
    this.reports.set(one.id, one);
  }
  async delete(id: string): Promise<void> {
    this.reports.delete(id);
    for (let index = this.log.length - 1; index >= 0; index -= 1) if (this.log[index]?.report === id) this.log.splice(index, 1);
  }
  async claim(id: string, previous: string | null, at: string): Promise<boolean> {
    const held = this.reports.get(id);
    if (!held || (held.lastAttemptAt ?? null) !== previous) return false;
    this.reports.set(id, { ...held, lastAttemptAt: at });
    return true;
  }

  async addSend(send: ReportSend): Promise<void> {
    this.log.push(reportSendSchema.parse(send));
  }
  async sends(options: SendListOptions = {}): Promise<ReportSend[]> {
    return this.log
      .filter((one) => options.report === undefined || one.report === options.report)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .slice(0, limitOf(options.limit));
  }
}

/* ── Dash's database ───────────────────────────────────────────────────── */

const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

export class DbReportStore implements ReportStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async listTracked(): Promise<TrackedValue[]> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_tracked_values WHERE workspace = ${this.workspace}`.execute(this.db.kysely);
    return result.rows.map((row) => trackedValueSchema.parse(parsed(row.record))).sort(byName);
  }
  async getTracked(id: string): Promise<TrackedValue | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_tracked_values WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? trackedValueSchema.parse(parsed(row.record)) : null;
  }
  async putTracked(value: TrackedValue): Promise<void> {
    const one = trackedValueSchema.parse(value);
    await sql`
      INSERT INTO dash_tracked_values (workspace, id, record) VALUES (${this.workspace}, ${one.id}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async deleteTracked(id: string): Promise<void> {
    await sql`DELETE FROM dash_tracked_values WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
  }

  async list(): Promise<Report[]> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_reports WHERE workspace = ${this.workspace}`.execute(this.db.kysely);
    return result.rows.map((row) => reportSchema.parse(parsed(row.record))).sort(byName);
  }
  async get(id: string): Promise<Report | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_reports WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? reportSchema.parse(parsed(row.record)) : null;
  }
  async put(report: Report): Promise<void> {
    const one = reportSchema.parse(report);
    await sql`
      INSERT INTO dash_reports (workspace, id, record) VALUES (${this.workspace}, ${one.id}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async delete(id: string): Promise<void> {
    await sql`DELETE FROM dash_report_sends WHERE workspace = ${this.workspace} AND report = ${id}`.execute(this.db.kysely);
    await sql`DELETE FROM dash_reports WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
  }
  async claim(id: string, previous: string | null, at: string): Promise<boolean> {
    /* One statement: of two servers reading the same `previous`, one updates the row. */
    const result = await sql<{ id: string }>`
      UPDATE dash_reports SET record = record || jsonb_build_object('lastAttemptAt', ${at}::text)
      WHERE workspace = ${this.workspace} AND id = ${id} AND (record->>'lastAttemptAt') IS NOT DISTINCT FROM ${previous}::text
      RETURNING id
    `.execute(this.db.kysely);
    return result.rows.length > 0;
  }

  async addSend(send: ReportSend): Promise<void> {
    const one = reportSendSchema.parse(send);
    await sql`
      INSERT INTO dash_report_sends (workspace, id, report, at, record) VALUES (${this.workspace}, ${one.id}, ${one.report}, ${one.at}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async sends(options: SendListOptions = {}): Promise<ReportSend[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_report_sends
      WHERE workspace = ${this.workspace} AND (${options.report ?? null}::text IS NULL OR report = ${options.report ?? null})
      ORDER BY at DESC, id DESC LIMIT ${limitOf(options.limit)}
    `.execute(this.db.kysely);
    return result.rows.map((row) => reportSendSchema.parse(parsed(row.record)));
  }
}
