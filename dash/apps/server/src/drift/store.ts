import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";
import type { AcceptedShape, Drift } from "./detect.js";

/**
 * The shape each endpoint was accepted in, and any change seen since.
 *
 * Names and kinds only, per connection and endpoint: what a later answer is
 * held against. A plug-in point: memory in tests, Dash's database in the
 * open-source build, wherever a hosted build keeps everything else. Forgotten
 * with the connection.
 */

export interface OpenDrift {
  readonly op: string;
  /** When it was first seen. */
  readonly since: string;
  readonly drift: Drift;
  /** The shape it drifted from, for the words that say so. */
  readonly accepted: AcceptedShape;
}

export interface ShapeStore {
  /** The shape an endpoint was accepted in, or null when none has been kept. */
  accepted(connection: string, op: string): Promise<AcceptedShape | null>;
  /** Accept a shape, closing any drift open against the one before it. */
  accept(connection: string, op: string, shape: AcceptedShape): Promise<void>;
  /** The changes still open on a connection. */
  open(connection: string): Promise<readonly OpenDrift[]>;
  /** A change seen: kept with the time it was first seen. */
  report(connection: string, op: string, drift: Drift, at: string): Promise<void>;
  /** The answer is back in its accepted shape. */
  close(connection: string, op: string): Promise<void>;
  forget(connection: string): Promise<void>;
}

interface Row {
  accepted: AcceptedShape;
  drift: Drift | null;
  since: string | null;
}

export class MemoryShapeStore implements ShapeStore {
  private readonly rows = new Map<string, Map<string, Row>>();

  private of(connection: string): Map<string, Row> {
    const ops = this.rows.get(connection) ?? new Map<string, Row>();
    this.rows.set(connection, ops);
    return ops;
  }

  async accepted(connection: string, op: string): Promise<AcceptedShape | null> {
    return this.rows.get(connection)?.get(op)?.accepted ?? null;
  }

  async accept(connection: string, op: string, shape: AcceptedShape): Promise<void> {
    this.of(connection).set(op, { accepted: shape, drift: null, since: null });
  }

  async open(connection: string): Promise<readonly OpenDrift[]> {
    return [...(this.rows.get(connection) ?? [])].flatMap(([op, row]) =>
      row.drift && row.since ? [{ op, since: row.since, drift: row.drift, accepted: row.accepted }] : [],
    );
  }

  async report(connection: string, op: string, drift: Drift, at: string): Promise<void> {
    const row = this.rows.get(connection)?.get(op);
    if (row) this.of(connection).set(op, { ...row, drift, since: row.since ?? at });
  }

  async close(connection: string, op: string): Promise<void> {
    const row = this.rows.get(connection)?.get(op);
    if (row) this.of(connection).set(op, { ...row, drift: null, since: null });
  }

  async forget(connection: string): Promise<void> {
    this.rows.delete(connection);
  }
}

const parsed = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

export class DbShapeStore implements ShapeStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async accepted(connection: string, op: string): Promise<AcceptedShape | null> {
    const result = await sql<{ accepted: unknown }>`
      SELECT accepted FROM dash_shapes
      WHERE workspace = ${this.workspace} AND connection = ${connection} AND op = ${op}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? parsed<AcceptedShape>(row.accepted) : null;
  }

  async accept(connection: string, op: string, shape: AcceptedShape): Promise<void> {
    await sql`
      INSERT INTO dash_shapes (workspace, connection, op, accepted, drift, since)
      VALUES (${this.workspace}, ${connection}, ${op}, ${JSON.stringify(shape)}::jsonb, NULL, NULL)
      ON CONFLICT (workspace, connection, op)
      DO UPDATE SET accepted = EXCLUDED.accepted, drift = NULL, since = NULL
    `.execute(this.db.kysely);
  }

  async open(connection: string): Promise<readonly OpenDrift[]> {
    const result = await sql<{ op: string; accepted: unknown; drift: unknown; since: string | Date }>`
      SELECT op, accepted, drift, since FROM dash_shapes
      WHERE workspace = ${this.workspace} AND connection = ${connection} AND drift IS NOT NULL
      ORDER BY since
    `.execute(this.db.kysely);
    return result.rows.map((row) => ({
      op: row.op,
      since: row.since instanceof Date ? row.since.toISOString() : new Date(row.since).toISOString(),
      drift: parsed<Drift>(row.drift),
      accepted: parsed<AcceptedShape>(row.accepted),
    }));
  }

  async report(connection: string, op: string, drift: Drift, at: string): Promise<void> {
    await sql`
      UPDATE dash_shapes
      SET drift = ${JSON.stringify(drift)}::jsonb, since = COALESCE(since, ${at})
      WHERE workspace = ${this.workspace} AND connection = ${connection} AND op = ${op}
    `.execute(this.db.kysely);
  }

  async close(connection: string, op: string): Promise<void> {
    await sql`
      UPDATE dash_shapes SET drift = NULL, since = NULL
      WHERE workspace = ${this.workspace} AND connection = ${connection} AND op = ${op}
    `.execute(this.db.kysely);
  }

  async forget(connection: string): Promise<void> {
    await sql`
      DELETE FROM dash_shapes WHERE workspace = ${this.workspace} AND connection = ${connection}
    `.execute(this.db.kysely);
  }
}
