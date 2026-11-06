import { inboundSettingsSchema, requesterRuleSchema, screenRecordSchema, type InboundSettings, type RequesterRule, type ScreenRecord, type ScreenStatus } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * What the inbound screen keeps: each email it screened (sender and verdict,
 * never the message, which stays sealed in Communications), the rules people
 * set per sender, and its settings.
 */
export interface InboundStore {
  putScreen(record: ScreenRecord): Promise<void>;
  screen(id: string): Promise<ScreenRecord | null>;
  /** Newest first. */
  screens(filter?: { readonly status?: ScreenStatus; readonly requester?: string; readonly since?: string; readonly limit?: number }): Promise<ScreenRecord[]>;
  rules(): Promise<RequesterRule[]>;
  putRule(rule: RequesterRule): Promise<void>;
  deleteRule(key: string): Promise<void>;
  settings(): Promise<InboundSettings>;
  putSettings(settings: InboundSettings): Promise<void>;
}

const limitOf = (limit: number | undefined): number => Math.min(Math.max(limit ?? 100, 1), 1000);
const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

export class MemoryInboundStore implements InboundStore {
  private readonly rows = new Map<string, ScreenRecord>();
  private readonly ruleRows = new Map<string, RequesterRule>();
  private held: InboundSettings = inboundSettingsSchema.parse({});
  async putScreen(record: ScreenRecord): Promise<void> {
    this.rows.set(record.id, screenRecordSchema.parse(record));
  }
  async screen(id: string): Promise<ScreenRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async screens(filter: { status?: ScreenStatus; requester?: string; since?: string; limit?: number } = {}): Promise<ScreenRecord[]> {
    return [...this.rows.values()]
      .filter((one) => (filter.status === undefined || one.status === filter.status) && (filter.requester === undefined || one.requester.key === filter.requester || `address:${one.from}` === filter.requester) && (filter.since === undefined || one.at >= filter.since))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .slice(0, limitOf(filter.limit));
  }
  async rules(): Promise<RequesterRule[]> {
    return [...this.ruleRows.values()];
  }
  async putRule(rule: RequesterRule): Promise<void> {
    this.ruleRows.set(rule.key, requesterRuleSchema.parse(rule));
  }
  async deleteRule(key: string): Promise<void> {
    this.ruleRows.delete(key);
  }
  async settings(): Promise<InboundSettings> {
    return this.held;
  }
  async putSettings(settings: InboundSettings): Promise<void> {
    this.held = inboundSettingsSchema.parse(settings);
  }
}

export class DbInboundStore implements InboundStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}
  async putScreen(record: ScreenRecord): Promise<void> {
    const one = screenRecordSchema.parse(record);
    await sql`
      INSERT INTO dash_inbound_screens (workspace, id, sender, status, at, record)
      VALUES (${this.workspace}, ${one.id}, ${`address:${one.from.toLowerCase()}`}, ${one.status}, ${one.at}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET status = EXCLUDED.status, record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async screen(id: string): Promise<ScreenRecord | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_inbound_screens WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? screenRecordSchema.parse(parsed(row.record)) : null;
  }
  async screens(filter: { status?: ScreenStatus; requester?: string; since?: string; limit?: number } = {}): Promise<ScreenRecord[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_inbound_screens
      WHERE workspace = ${this.workspace}
        AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
        AND (${filter.requester ?? null}::text IS NULL OR sender = ${filter.requester ?? null})
        AND (${filter.since ?? null}::text IS NULL OR at >= ${filter.since ?? null})
      ORDER BY at DESC, id DESC LIMIT ${limitOf(filter.limit)}
    `.execute(this.db.kysely);
    return result.rows.map((row) => screenRecordSchema.parse(parsed(row.record)));
  }
  async rules(): Promise<RequesterRule[]> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_inbound_rules WHERE workspace = ${this.workspace}`.execute(this.db.kysely);
    return result.rows.map((row) => requesterRuleSchema.parse(parsed(row.record)));
  }
  async putRule(rule: RequesterRule): Promise<void> {
    const one = requesterRuleSchema.parse(rule);
    await sql`
      INSERT INTO dash_inbound_rules (workspace, key, record) VALUES (${this.workspace}, ${one.key}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, key) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async deleteRule(key: string): Promise<void> {
    await sql`DELETE FROM dash_inbound_rules WHERE workspace = ${this.workspace} AND key = ${key}`.execute(this.db.kysely);
  }
  async settings(): Promise<InboundSettings> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_inbound_settings WHERE workspace = ${this.workspace}`.execute(this.db.kysely);
    const row = result.rows[0];
    return inboundSettingsSchema.parse(row ? parsed(row.record) : {});
  }
  async putSettings(settings: InboundSettings): Promise<void> {
    const one = inboundSettingsSchema.parse(settings);
    await sql`
      INSERT INTO dash_inbound_settings (workspace, record) VALUES (${this.workspace}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
}
