import type { SeenSet } from "../integrate/values.js";

/**
 * The values one account's records were seen to hold, per connection and
 * endpoint (`integrate/values.ts`).
 *
 * This account's data, so never the catalog's: kept here, per workspace, and
 * forgotten with the connection. A plug-in point: memory in tests, Dash's
 * database in the open-source build, wherever a hosted build keeps it.
 */
export interface SeenValueStore {
  /** Everything seen on one connection, by endpoint. */
  get(connection: string): Promise<Readonly<Record<string, SeenSet>>>;
  /** What one read showed, in place of what an earlier read of that endpoint showed. */
  put(connection: string, op: string, seen: SeenSet): Promise<void>;
  forget(connection: string): Promise<void>;
}

export class MemorySeenValueStore implements SeenValueStore {
  private readonly rows = new Map<string, Map<string, SeenSet>>();
  async get(connection: string): Promise<Readonly<Record<string, SeenSet>>> {
    return Object.fromEntries(this.rows.get(connection) ?? []);
  }
  async put(connection: string, op: string, seen: SeenSet): Promise<void> {
    const ops = this.rows.get(connection) ?? new Map<string, SeenSet>();
    ops.set(op, seen);
    this.rows.set(connection, ops);
  }
  async forget(connection: string): Promise<void> {
    this.rows.delete(connection);
  }
}
