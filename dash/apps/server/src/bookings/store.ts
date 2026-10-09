import { bookingEventSchema, bookingSchema, dueAt, holdsOf, type Booking, type BookingEvent, type BookingStatus } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * Where bookings and their events are kept.
 *
 * Everything that changes a booking runs inside `withHosts`: the hosts'
 * locks are taken (always in the same order, so two changes never wait on
 * each other), the time they hold is read fresh, and the booking and its
 * event are written in one transaction. Two people asking for a host's last
 * free time at once: one is written, the other reads it and is told the time
 * is taken.
 *
 * A booking's held time is kept beside it (`holdsOf`): its own time, a move
 * waiting for approval, each suggested time. `holding` reads those, so a
 * suggestion on another host's calendar keeps that host busy too.
 */

export class BookingConflict extends Error {
  constructor() {
    super("The booking changed while this was being saved.");
    this.name = "BookingConflict";
  }
}

export interface BookingQuery {
  readonly from?: number;
  readonly to?: number;
  readonly host?: string;
  readonly contact?: string;
  readonly statuses?: readonly BookingStatus[];
  readonly limit?: number;
}

/** What a change sees and writes, inside the hosts' locks. */
export interface BookingTx {
  get(id: string): Promise<Booking | null>;
  /** Bookings holding any of a host's time in a range. */
  holding(host: string, from: number, to: number): Promise<Booking[]>;
  /** Saves a booking; `expect` is the revision it was read at, none for a new one. */
  put(booking: Booking, expect?: number): Promise<void>;
  event(event: BookingEvent): Promise<void>;
}

export interface BookingStore {
  get(id: string): Promise<Booking | null>;
  list(query?: BookingQuery): Promise<Booking[]>;
  holding(host: string, from: number, to: number): Promise<Booking[]>;
  /** Runs `work` holding these hosts' locks, as one transaction: nothing it wrote stays when it throws. */
  withHosts<T>(hosts: readonly string[], work: (tx: BookingTx) => Promise<T>): Promise<T>;
  /** Events not yet delivered, oldest first. */
  undelivered(limit: number): Promise<BookingEvent[]>;
  markDelivered(id: string): Promise<void>;
  /** Bookings with something falling due by `now` (`dueAt`). */
  due(now: number, limit: number): Promise<Booking[]>;
}

const overlaps = (booking: Booking, host: string, from: number, to: number): boolean => holdsOf(booking).some((hold) => hold.host === host && hold.start < to && hold.end > from);

const inQuery = (booking: Booking, query: BookingQuery): boolean => {
  if (query.host && booking.host !== query.host) return false;
  if (query.contact && booking.contact !== query.contact) return false;
  if (query.statuses && !query.statuses.includes(booking.status)) return false;
  const start = Date.parse(booking.start);
  const end = Date.parse(booking.end);
  if (query.from !== undefined && end <= query.from) return false;
  if (query.to !== undefined && start >= query.to) return false;
  return true;
};

/* ── memory ────────────────────────────────────────────────────────────── */

export class MemoryBookingStore implements BookingStore {
  private readonly bookings = new Map<string, Booking>();
  private readonly events: Array<BookingEvent & { delivered: boolean }> = [];
  private readonly locks = new Map<string, Promise<void>>();

  async get(id: string): Promise<Booking | null> {
    return this.bookings.get(id) ?? null;
  }
  async list(query: BookingQuery = {}): Promise<Booking[]> {
    return [...this.bookings.values()]
      .filter((one) => inQuery(one, query))
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, query.limit ?? 500);
  }
  async holding(host: string, from: number, to: number): Promise<Booking[]> {
    return [...this.bookings.values()].filter((one) => overlaps(one, host, from, to));
  }

  /** One host at a time, in name order: each lock is a promise the next change waits on. */
  async withHosts<T>(hosts: readonly string[], work: (tx: BookingTx) => Promise<T>): Promise<T> {
    const order = [...new Set(hosts)].sort();
    const releases: Array<() => void> = [];
    for (const host of order) {
      const before = this.locks.get(host) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      this.locks.set(host, before.then(() => mine));
      await before;
      releases.push(release);
    }
    const staged = new Map<string, Booking>();
    const events: BookingEvent[] = [];
    const tx: BookingTx = {
      get: async (id) => staged.get(id) ?? this.bookings.get(id) ?? null,
      holding: async (host, from, to) => {
        const all = new Map(this.bookings);
        for (const [id, one] of staged) all.set(id, one);
        return [...all.values()].filter((one) => overlaps(one, host, from, to));
      },
      put: async (booking, expect) => {
        const held = staged.get(booking.id) ?? this.bookings.get(booking.id);
        if ((held?.revision ?? undefined) !== expect) throw new BookingConflict();
        staged.set(booking.id, bookingSchema.parse(booking));
      },
      event: async (event) => {
        events.push(bookingEventSchema.parse(event));
      },
    };
    try {
      const result = await work(tx);
      for (const [id, one] of staged) this.bookings.set(id, one);
      for (const event of events) if (!this.events.some((held) => held.id === event.id)) this.events.push({ ...event, delivered: false });
      return result;
    } finally {
      for (const release of releases) release();
    }
  }

  async undelivered(limit: number): Promise<BookingEvent[]> {
    return this.events
      .filter((one) => !one.delivered)
      .slice(0, limit)
      .map(({ delivered: _delivered, ...event }) => event);
  }
  async markDelivered(id: string): Promise<void> {
    const event = this.events.find((one) => one.id === id);
    if (event) event.delivered = true;
  }
  async due(now: number, limit: number): Promise<Booking[]> {
    return [...this.bookings.values()]
      .filter((one) => {
        const at = dueAt(one);
        return at !== undefined && Date.parse(at) <= now;
      })
      .slice(0, limit);
  }
}

/* ── database ──────────────────────────────────────────────────────────── */

const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Bookings in `dash_bookings`, their held time in `dash_booking_holds`, and
 * the outbox in `dash_booking_events`. A host's lock is a transaction-scoped
 * advisory lock on the workspace and host, so it works the same on PGlite
 * and on a hosted Postgres with many servers.
 */
export class DbBookingStore implements BookingStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async get(id: string): Promise<Booking | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_bookings WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? bookingSchema.parse(parsed(row.record)) : null;
  }

  async list(query: BookingQuery = {}): Promise<Booking[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_bookings
      WHERE workspace = ${this.workspace}
        ${query.host ? sql`AND host = ${query.host}` : sql``}
        ${query.contact ? sql`AND contact = ${query.contact}` : sql``}
        ${query.statuses && query.statuses.length > 0 ? sql`AND status IN (${sql.join(query.statuses.map((status) => sql`${status}`))})` : sql``}
        ${query.from !== undefined ? sql`AND end_at > ${iso(query.from)}` : sql``}
        ${query.to !== undefined ? sql`AND start_at < ${iso(query.to)}` : sql``}
      ORDER BY start_at, id
      LIMIT ${Math.min(query.limit ?? 500, 2000)}
    `.execute(this.db.kysely);
    return result.rows.map((row) => bookingSchema.parse(parsed(row.record)));
  }

  private async holdingIn(executor: DashDb["kysely"], host: string, from: number, to: number): Promise<Booking[]> {
    const result = await sql<{ record: unknown }>`
      SELECT b.record FROM dash_bookings b
      WHERE b.workspace = ${this.workspace} AND b.id IN (
        SELECT booking FROM dash_booking_holds
        WHERE workspace = ${this.workspace} AND host = ${host} AND start_at < ${iso(to)} AND end_at > ${iso(from)}
      )
    `.execute(executor);
    return result.rows.map((row) => bookingSchema.parse(parsed(row.record)));
  }

  async holding(host: string, from: number, to: number): Promise<Booking[]> {
    return this.holdingIn(this.db.kysely, host, from, to);
  }

  async withHosts<T>(hosts: readonly string[], work: (tx: BookingTx) => Promise<T>): Promise<T> {
    const workspace = this.workspace;
    return this.db.kysely.transaction().execute(async (trx) => {
      for (const host of [...new Set(hosts)].sort()) await sql`SELECT pg_advisory_xact_lock(hashtext(${`dash-booking:${workspace}:${host}`}))`.execute(trx);
      const tx: BookingTx = {
        get: async (id) => {
          const result = await sql<{ record: unknown }>`SELECT record FROM dash_bookings WHERE workspace = ${workspace} AND id = ${id}`.execute(trx);
          const row = result.rows[0];
          return row ? bookingSchema.parse(parsed(row.record)) : null;
        },
        holding: (host, from, to) => this.holdingIn(trx as unknown as DashDb["kysely"], host, from, to),
        put: async (booking, expect) => {
          const one = bookingSchema.parse(booking);
          const due = dueAt(one) ?? null;
          if (expect === undefined) {
            const inserted = await sql`
              INSERT INTO dash_bookings (workspace, id, host, contact, status, start_at, end_at, due_at, revision, record)
              VALUES (${workspace}, ${one.id}, ${one.host}, ${one.contact}, ${one.status}, ${iso(Date.parse(one.start))}, ${iso(Date.parse(one.end))}, ${due ? iso(Date.parse(due)) : null}, ${one.revision}, ${JSON.stringify(one)}::jsonb)
              ON CONFLICT (workspace, id) DO NOTHING
            `.execute(trx);
            if (Number(inserted.numAffectedRows ?? 0) === 0) throw new BookingConflict();
          } else {
            const updated = await sql`
              UPDATE dash_bookings SET host = ${one.host}, contact = ${one.contact}, status = ${one.status}, start_at = ${iso(Date.parse(one.start))}, end_at = ${iso(Date.parse(one.end))},
                due_at = ${due ? iso(Date.parse(due)) : null}, revision = ${one.revision}, record = ${JSON.stringify(one)}::jsonb
              WHERE workspace = ${workspace} AND id = ${one.id} AND revision = ${expect}
            `.execute(trx);
            if (Number(updated.numAffectedRows ?? 0) === 0) throw new BookingConflict();
          }
          await sql`DELETE FROM dash_booking_holds WHERE workspace = ${workspace} AND booking = ${one.id}`.execute(trx);
          for (const hold of holdsOf(one)) {
            await sql`
              INSERT INTO dash_booking_holds (workspace, booking, host, start_at, end_at) VALUES (${workspace}, ${one.id}, ${hold.host}, ${iso(hold.start)}, ${iso(hold.end)})
            `.execute(trx);
          }
        },
        event: async (event) => {
          const one = bookingEventSchema.parse(event);
          await sql`
            INSERT INTO dash_booking_events (workspace, id, booking, kind, at, record, delivered)
            VALUES (${workspace}, ${one.id}, ${one.booking}, ${one.kind}, ${one.at}, ${JSON.stringify(one)}::jsonb, false)
            ON CONFLICT (workspace, id) DO NOTHING
          `.execute(trx);
        },
      };
      return work(tx);
    });
  }

  async undelivered(limit: number): Promise<BookingEvent[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_booking_events WHERE workspace = ${this.workspace} AND NOT delivered ORDER BY at, id LIMIT ${limit}
    `.execute(this.db.kysely);
    return result.rows.map((row) => bookingEventSchema.parse(parsed(row.record)));
  }

  async markDelivered(id: string): Promise<void> {
    await sql`UPDATE dash_booking_events SET delivered = true WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
  }

  async due(now: number, limit: number): Promise<Booking[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_bookings WHERE workspace = ${this.workspace} AND due_at IS NOT NULL AND due_at <= ${iso(now)} ORDER BY due_at LIMIT ${limit}
    `.execute(this.db.kysely);
    return result.rows.map((row) => bookingSchema.parse(parsed(row.record)));
  }
}

