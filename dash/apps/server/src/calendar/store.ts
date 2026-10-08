import {
  calendarEventSchema,
  calendarOverlaps,
  calendarSortKey,
  ownerKey,
  type CalendarEvent,
  type CalendarKind,
  type CalendarStatus,
} from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * Where a workspace's calendar entries are kept.
 *
 * Plug-in point like the other stores: memory for tests and embedders, Dash's
 * database in the open-source build. One store answers for one workspace.
 *
 * An entry is one JSON record. The columns beside it are only what a query
 * needs: the start and end as sortable instants, and the dedupe key, whose
 * unique index is what lets a workflow move its entry instead of making a
 * second one.
 */

export interface CalendarListOptions {
  /** ISO instants: entries overlapping [from, to). All-day entries are padded a day either side; the reader trims to its own days. */
  readonly from?: string;
  readonly to?: string;
  /** `agent:<id>` / `member:<id>`. Absent: everyone's. */
  readonly owners?: readonly string[];
  readonly kinds?: readonly CalendarKind[];
  readonly statuses?: readonly CalendarStatus[];
  /** One workflow's entries, and within it one record's. */
  readonly workflow?: string;
  readonly rowKey?: string;
  readonly limit?: number;
}

export interface CalendarStore {
  get(id: string): Promise<CalendarEvent | null>;
  put(event: CalendarEvent): Promise<void>;
  delete(id: string): Promise<void>;
  /** In time order. */
  list(options?: CalendarListOptions): Promise<CalendarEvent[]>;
  /**
   * Write an entry by its `dedupeKey`: the first write inserts it; a later one
   * with the same key replaces it in place, keeping the first entry's id and
   * when it was made. A pinned entry is left as it is. Returns what is stored.
   */
  upsertByKey(event: CalendarEvent & { readonly dedupeKey: string }): Promise<CalendarEvent>;
}

const limitOf = (limit: number | undefined, fallback = 500): number => Math.min(Math.max(limit ?? fallback, 1), 5000);

const byTime = (a: CalendarEvent, b: CalendarEvent): number =>
  calendarSortKey(a.at).localeCompare(calendarSortKey(b.at)) || a.id.localeCompare(b.id);

/** The filters that are not about time, applied to entries already in the range. */
const keep = (one: CalendarEvent, options: CalendarListOptions): boolean =>
  (!options.owners || options.owners.length === 0 || options.owners.includes(ownerKey(one.owner) ?? "")) &&
  (!options.kinds || options.kinds.length === 0 || options.kinds.includes(one.kind)) &&
  (!options.statuses || options.statuses.length === 0 || options.statuses.includes(one.status)) &&
  (options.workflow === undefined || one.workflow === options.workflow) &&
  (options.rowKey === undefined || one.rowKey === options.rowKey);

/* ── memory ────────────────────────────────────────────────────────────── */

export class MemoryCalendarStore implements CalendarStore {
  private readonly rows = new Map<string, CalendarEvent>();
  async get(id: string): Promise<CalendarEvent | null> {
    return this.rows.get(id) ?? null;
  }
  async put(event: CalendarEvent): Promise<void> {
    const one = calendarEventSchema.parse(event);
    if (one.dedupeKey) {
      const clash = [...this.rows.values()].find((row) => row.dedupeKey === one.dedupeKey && row.id !== one.id);
      if (clash) throw new Error(`Another entry (${clash.id}) already has the key ${one.dedupeKey}.`);
    }
    this.rows.set(one.id, one);
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async list(options: CalendarListOptions = {}): Promise<CalendarEvent[]> {
    return [...this.rows.values()]
      .filter((one) => calendarOverlaps(one, options.from, options.to) && keep(one, options))
      .sort(byTime)
      .slice(0, limitOf(options.limit));
  }
  async upsertByKey(event: CalendarEvent & { readonly dedupeKey: string }): Promise<CalendarEvent> {
    const one = calendarEventSchema.parse(event);
    const held = [...this.rows.values()].find((row) => row.dedupeKey === event.dedupeKey);
    if (!held) {
      this.rows.set(one.id, one);
      return one;
    }
    if (held.pinned) return held;
    const next = { ...one, id: held.id, createdAt: held.createdAt };
    this.rows.set(held.id, next);
    return next;
  }
}

/* ── Dash's database ───────────────────────────────────────────────────── */

const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

const columns = (one: CalendarEvent) => ({
  at: calendarSortKey(one.at),
  endsAt: calendarSortKey(one.end?.trim() ? one.end : one.at),
});

const DAY = 86_400_000;
const shift = (iso: string | undefined, ms: number): string | null => (iso ? new Date(Date.parse(iso) + ms).toISOString() : null);

export class DbCalendarStore implements CalendarStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}
  async get(id: string): Promise<CalendarEvent | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_calendar_events WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? calendarEventSchema.parse(parsed(row.record)) : null;
  }
  async put(event: CalendarEvent): Promise<void> {
    const one = calendarEventSchema.parse(event);
    const { at, endsAt } = columns(one);
    await sql`
      INSERT INTO dash_calendar_events (workspace, id, at, ends_at, dedupe_key, record)
      VALUES (${this.workspace}, ${one.id}, ${at}, ${endsAt}, ${one.dedupeKey ?? null}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET at = EXCLUDED.at, ends_at = EXCLUDED.ends_at, dedupe_key = EXCLUDED.dedupe_key, record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async delete(id: string): Promise<void> {
    await sql`DELETE FROM dash_calendar_events WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
  }
  async list(options: CalendarListOptions = {}): Promise<CalendarEvent[]> {
    /* The range a day wider each side, so every all-day entry that might be in it is read; the exact test is below. */
    const from = shift(options.from, -DAY);
    const to = shift(options.to, DAY);
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_calendar_events
      WHERE workspace = ${this.workspace}
        AND (${to}::text IS NULL OR at < ${to})
        AND (${from}::text IS NULL OR COALESCE(ends_at, at) >= ${from})
        AND (${options.workflow ?? null}::text IS NULL OR record->>'workflow' = ${options.workflow ?? null})
        AND (${options.rowKey ?? null}::text IS NULL OR record->>'rowKey' = ${options.rowKey ?? null})
      ORDER BY at, id LIMIT 5000
    `.execute(this.db.kysely);
    return result.rows
      .map((row) => calendarEventSchema.parse(parsed(row.record)))
      .filter((one) => calendarOverlaps(one, options.from, options.to) && keep(one, options))
      .sort(byTime)
      .slice(0, limitOf(options.limit));
  }
  async upsertByKey(event: CalendarEvent & { readonly dedupeKey: string }): Promise<CalendarEvent> {
    const one = calendarEventSchema.parse(event);
    const { at, endsAt } = columns(one);
    /*
     * One statement, so two runs writing the same key at once make one entry.
     * A repeat keeps the first entry's id and creation time, and leaves a pinned
     * entry exactly as the person left it.
     */
    const result = await sql<{ record: unknown }>`
      INSERT INTO dash_calendar_events (workspace, id, at, ends_at, dedupe_key, record)
      VALUES (${this.workspace}, ${one.id}, ${at}, ${endsAt}, ${event.dedupeKey}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
        at = EXCLUDED.at,
        ends_at = EXCLUDED.ends_at,
        record = EXCLUDED.record || jsonb_build_object('id', dash_calendar_events.id, 'createdAt', dash_calendar_events.record->'createdAt')
      WHERE NOT COALESCE((dash_calendar_events.record->>'pinned')::boolean, false)
      RETURNING record
    `.execute(this.db.kysely);
    const row = result.rows[0];
    if (row) return calendarEventSchema.parse(parsed(row.record));
    const held = await sql<{ record: unknown }>`
      SELECT record FROM dash_calendar_events WHERE workspace = ${this.workspace} AND dedupe_key = ${event.dedupeKey}
    `.execute(this.db.kysely);
    return calendarEventSchema.parse(parsed(held.rows[0]?.record));
  }
}
