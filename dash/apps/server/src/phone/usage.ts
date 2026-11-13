import type { PhoneDeliveryStatus } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * What each phone line has sent and dialled: one row per send key, so a key
 * is handed to a provider at most once, and the day's count of texts and call
 * minutes, so a line's ceilings are enforced before a send or a dial, here
 * and never in the adapter. Usage bills to the business's own account.
 *
 * Days are UTC (`YYYY-MM-DD`). A row claims its key in the same statement
 * that checks the ceiling, so two sends racing for the last text of the day
 * cannot both go.
 */

export type PhoneUseKind = "text" | "call";

export interface PhoneSendRecord {
  readonly line: string;
  readonly key: string;
  readonly kind: PhoneUseKind;
  readonly day: string;
  readonly to: string;
  readonly at: string;
  /** Not yet known while the provider is being asked. */
  readonly providerId?: string | undefined;
  /** `not_sent` until the provider took it; then the provider's word. */
  readonly status: PhoneDeliveryStatus | "not_sent";
  readonly errorCode?: string | undefined;
  readonly detail?: string | undefined;
  /** A call's minutes, once it ended. */
  readonly minutes: number;
  /** The workflow task it was sent for: delivery updates fill its `delivery`. */
  readonly task?: string | undefined;
}

export type PhoneClaim =
  | { readonly claimed: true }
  /** The key was claimed before: it is not sent again. */
  | { readonly claimed: false; readonly existing: PhoneSendRecord }
  /** The line is at its ceiling for the day. */
  | { readonly claimed: false; readonly over: { readonly used: number; readonly ceiling: number } };

export interface PhoneUsageStore {
  /**
   * Claims a send key, if the line is still under its ceiling for the day:
   * texts counted by rows, calls by minutes used (a call is allowed while any
   * minute is left).
   */
  claim(record: Omit<PhoneSendRecord, "status" | "minutes">, ceiling: number): Promise<PhoneClaim>;
  /** What the provider answered, or a later delivery update. */
  settle(line: string, key: string, update: { readonly providerId?: string; readonly status: PhoneSendRecord["status"]; readonly errorCode?: string; readonly detail?: string; readonly minutes?: number }): Promise<PhoneSendRecord | null>;
  byProvider(line: string, providerId: string): Promise<PhoneSendRecord | null>;
  /** Texts sent, or call minutes used, on one line on one day. */
  used(line: string, day: string, kind: PhoneUseKind): Promise<number>;
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class MemoryPhoneUsageStore implements PhoneUsageStore {
  /** By `line\u0000key`. */
  readonly rows = new Map<string, PhoneSendRecord>();

  async claim(record: Omit<PhoneSendRecord, "status" | "minutes">, ceiling: number): Promise<PhoneClaim> {
    const id = `${record.line}\u0000${record.key}`;
    const existing = this.rows.get(id);
    if (existing) return { claimed: false, existing };
    const used = await this.used(record.line, record.day, record.kind);
    if (used >= ceiling) return { claimed: false, over: { used, ceiling } };
    this.rows.set(id, { ...record, status: "not_sent", minutes: 0 });
    return { claimed: true };
  }

  async settle(line: string, key: string, update: Parameters<PhoneUsageStore["settle"]>[2]): Promise<PhoneSendRecord | null> {
    const id = `${line}\u0000${key}`;
    const held = this.rows.get(id);
    if (!held) return null;
    const next: PhoneSendRecord = { ...held, ...update, minutes: update.minutes ?? held.minutes };
    this.rows.set(id, next);
    return next;
  }

  async byProvider(line: string, providerId: string): Promise<PhoneSendRecord | null> {
    return [...this.rows.values()].find((one) => one.line === line && one.providerId === providerId) ?? null;
  }

  async used(line: string, day: string, kind: PhoneUseKind): Promise<number> {
    let total = 0;
    for (const one of this.rows.values()) if (one.line === line && one.day === day && one.kind === kind) total += kind === "text" ? 1 : one.minutes;
    return total;
  }
}

interface Row {
  line: string;
  key: string;
  kind: string;
  day: string;
  recipient: string;
  at: string;
  provider_id: string | null;
  status: string;
  error_code: string | null;
  detail: string | null;
  minutes: number;
  task: string | null;
}

const recordOf = (row: Row): PhoneSendRecord => ({
  line: row.line,
  key: row.key,
  kind: row.kind as PhoneUseKind,
  day: row.day,
  to: row.recipient,
  at: row.at,
  ...(row.provider_id ? { providerId: row.provider_id } : {}),
  status: row.status as PhoneSendRecord["status"],
  ...(row.error_code ? { errorCode: row.error_code } : {}),
  ...(row.detail ? { detail: row.detail } : {}),
  minutes: Number(row.minutes),
  ...(row.task ? { task: row.task } : {}),
});

export class DbPhoneUsageStore implements PhoneUsageStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async claim(record: Omit<PhoneSendRecord, "status" | "minutes">, ceiling: number): Promise<PhoneClaim> {
    const measure = record.kind === "text" ? sql`count(*)` : sql`coalesce(sum(minutes), 0)`;
    const inserted = await sql<{ key: string }>`
      INSERT INTO dash_phone_sends (workspace, line, key, kind, day, recipient, at, status, minutes, task)
      SELECT ${this.workspace}, ${record.line}, ${record.key}, ${record.kind}, ${record.day}, ${record.to}, ${record.at}, 'not_sent', 0, ${record.task ?? null}
      WHERE (SELECT ${measure} FROM dash_phone_sends WHERE workspace = ${this.workspace} AND line = ${record.line} AND day = ${record.day} AND kind = ${record.kind}) < ${ceiling}
      ON CONFLICT (workspace, line, key) DO NOTHING
      RETURNING key
    `.execute(this.db.kysely);
    if (inserted.rows.length > 0) return { claimed: true };
    const existing = await this.row(record.line, record.key);
    if (existing) return { claimed: false, existing };
    return { claimed: false, over: { used: await this.used(record.line, record.day, record.kind), ceiling } };
  }

  async settle(line: string, key: string, update: Parameters<PhoneUsageStore["settle"]>[2]): Promise<PhoneSendRecord | null> {
    await sql`
      UPDATE dash_phone_sends SET
        status = ${update.status},
        provider_id = coalesce(${update.providerId ?? null}, provider_id),
        error_code = coalesce(${update.errorCode ?? null}, error_code),
        detail = coalesce(${update.detail ?? null}, detail),
        minutes = coalesce(${update.minutes ?? null}, minutes)
      WHERE workspace = ${this.workspace} AND line = ${line} AND key = ${key}
    `.execute(this.db.kysely);
    return this.row(line, key);
  }

  async byProvider(line: string, providerId: string): Promise<PhoneSendRecord | null> {
    const result = await sql<Row>`SELECT * FROM dash_phone_sends WHERE workspace = ${this.workspace} AND line = ${line} AND provider_id = ${providerId} LIMIT 1`.execute(this.db.kysely);
    return result.rows[0] ? recordOf(result.rows[0]) : null;
  }

  async used(line: string, day: string, kind: PhoneUseKind): Promise<number> {
    const measure = kind === "text" ? sql`count(*)` : sql`coalesce(sum(minutes), 0)`;
    const result = await sql<{ used: number | string }>`SELECT ${measure} AS used FROM dash_phone_sends WHERE workspace = ${this.workspace} AND line = ${line} AND day = ${day} AND kind = ${kind}`.execute(this.db.kysely);
    return Number(result.rows[0]?.used ?? 0);
  }

  private async row(line: string, key: string): Promise<PhoneSendRecord | null> {
    const result = await sql<Row>`SELECT * FROM dash_phone_sends WHERE workspace = ${this.workspace} AND line = ${line} AND key = ${key}`.execute(this.db.kysely);
    return result.rows[0] ? recordOf(result.rows[0]) : null;
  }
}
