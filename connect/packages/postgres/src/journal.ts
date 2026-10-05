import { sql } from "kysely";
import type { ConnectDb } from "./db.js";
import type { ReadEvent, WriteEvent, WriteJournal } from "@freebirdai/connect/host";

/**
 * The journal, kept: every change made to a connected account, and every
 * read that might not have been one, in Dash's own database.
 *
 * Append-only. A failure to keep an event is thrown to the caller, which
 * decides what losing it costs — the write service reports it; a read goes
 * on, since what it read is not in doubt.
 */
export class DbWriteJournal implements WriteJournal {
  constructor(
    private readonly db: ConnectDb,
    private readonly workspace = "local",
  ) {}

  async record(event: WriteEvent): Promise<void> {
    await sql`
      INSERT INTO connect_journal (id, workspace, connection, at, kind, status, event)
      VALUES (${event.id}, ${event.actor.workspaceId || this.workspace}, ${event.connection}, ${event.at},
              ${event.kind}, ${event.status}, ${JSON.stringify(event)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `.execute(this.db.kysely);
  }

  async recordRead(event: ReadEvent): Promise<void> {
    await sql`
      INSERT INTO connect_journal (id, workspace, connection, at, kind, status, event)
      VALUES (${event.id}, ${this.workspace}, ${event.connection}, ${event.at},
              'read', ${event.status}, ${JSON.stringify(event)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `.execute(this.db.kysely);
  }

  /** The newest events first: every connection, or one. */
  async list(options: { connection?: string; limit?: number } = {}): Promise<Array<WriteEvent | ReadEvent>> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const result = options.connection
      ? await sql<{ event: unknown }>`
          SELECT event FROM connect_journal WHERE workspace = ${this.workspace} AND connection = ${options.connection}
          ORDER BY at DESC LIMIT ${limit}
        `.execute(this.db.kysely)
      : await sql<{ event: unknown }>`
          SELECT event FROM connect_journal WHERE workspace = ${this.workspace}
          ORDER BY at DESC LIMIT ${limit}
        `.execute(this.db.kysely);
    return result.rows.map(
      (row) => (typeof row.event === "string" ? JSON.parse(row.event) : row.event) as WriteEvent | ReadEvent,
    );
  }
}
