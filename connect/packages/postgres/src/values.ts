import { sql } from "kysely";
import type { ConnectDb } from "./db.js";
import type { SeenSet } from "@freebirdai/connect/integrate/values";
import type { SeenValueStore } from "@freebirdai/connect/values/store";

export class DbSeenValueStore implements SeenValueStore {
  constructor(
    private readonly db: ConnectDb,
    private readonly workspace = "local",
  ) {}

  async get(connection: string): Promise<Readonly<Record<string, SeenSet>>> {
    const result = await sql<{ op: string; seen: unknown }>`
      SELECT op, seen FROM connect_seen_values WHERE workspace = ${this.workspace} AND connection = ${connection}
    `.execute(this.db.kysely);
    return Object.fromEntries(
      result.rows.map((row) => [row.op, (typeof row.seen === "string" ? JSON.parse(row.seen) : row.seen) as SeenSet]),
    );
  }

  async put(connection: string, op: string, seen: SeenSet): Promise<void> {
    await sql`
      INSERT INTO connect_seen_values (workspace, connection, op, at, seen)
      VALUES (${this.workspace}, ${connection}, ${op}, ${new Date().toISOString()}, ${JSON.stringify(seen)}::jsonb)
      ON CONFLICT (workspace, connection, op) DO UPDATE SET at = EXCLUDED.at, seen = EXCLUDED.seen
    `.execute(this.db.kysely);
  }

  async forget(connection: string): Promise<void> {
    await sql`
      DELETE FROM connect_seen_values WHERE workspace = ${this.workspace} AND connection = ${connection}
    `.execute(this.db.kysely);
  }
}
