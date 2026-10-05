import { sql } from "kysely";
import type { ConnectDb } from "./db.js";
import type { AcceptedShape, Drift } from "@freebirdai/connect/drift/detect";
import type { OpenDrift, ShapeStore } from "@freebirdai/connect/drift/store";

const parsed = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;


export class DbShapeStore implements ShapeStore {
  constructor(
    private readonly db: ConnectDb,
    private readonly workspace = "local",
  ) {}

  async accepted(connection: string, op: string): Promise<AcceptedShape | null> {
    const result = await sql<{ accepted: unknown }>`
      SELECT accepted FROM connect_shapes
      WHERE workspace = ${this.workspace} AND connection = ${connection} AND op = ${op}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? parsed<AcceptedShape>(row.accepted) : null;
  }

  async accept(connection: string, op: string, shape: AcceptedShape): Promise<void> {
    await sql`
      INSERT INTO connect_shapes (workspace, connection, op, accepted, drift, since)
      VALUES (${this.workspace}, ${connection}, ${op}, ${JSON.stringify(shape)}::jsonb, NULL, NULL)
      ON CONFLICT (workspace, connection, op)
      DO UPDATE SET accepted = EXCLUDED.accepted, drift = NULL, since = NULL
    `.execute(this.db.kysely);
  }

  async open(connection: string): Promise<readonly OpenDrift[]> {
    const result = await sql<{ op: string; accepted: unknown; drift: unknown; since: string | Date }>`
      SELECT op, accepted, drift, since FROM connect_shapes
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
      UPDATE connect_shapes
      SET drift = ${JSON.stringify(drift)}::jsonb, since = COALESCE(since, ${at})
      WHERE workspace = ${this.workspace} AND connection = ${connection} AND op = ${op}
    `.execute(this.db.kysely);
  }

  async close(connection: string, op: string): Promise<void> {
    await sql`
      UPDATE connect_shapes SET drift = NULL, since = NULL
      WHERE workspace = ${this.workspace} AND connection = ${connection} AND op = ${op}
    `.execute(this.db.kysely);
  }

  async forget(connection: string): Promise<void> {
    await sql`
      DELETE FROM connect_shapes WHERE workspace = ${this.workspace} AND connection = ${connection}
    `.execute(this.db.kysely);
  }
}
