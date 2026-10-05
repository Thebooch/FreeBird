import { sql } from "kysely";
import type { ConnectDb } from "./db.js";
import type { LeaseLock } from "@freebirdai/connect/host";

/** Every server sharing Dash's database, through one row per lease. */
export class DbLeaseLock implements LeaseLock {
  constructor(
    private readonly db: ConnectDb,
    private readonly workspace = "local",
  ) {}

  async acquire(key: string, holder: string, ttlMs: number): Promise<boolean> {
    const until = new Date(Date.now() + ttlMs).toISOString();
    const now = new Date().toISOString();
    /* Taken if free, lapsed, or already this holder's: one statement, so two servers cannot both win. */
    const result = await sql<{ holder: string }>`
      INSERT INTO connect_leases (workspace, key, holder, until) VALUES (${this.workspace}, ${key}, ${holder}, ${until})
      ON CONFLICT (workspace, key) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until
        WHERE connect_leases.holder = EXCLUDED.holder OR connect_leases.until < ${now}
      RETURNING holder
    `.execute(this.db.kysely);
    return result.rows.length > 0 && result.rows[0]!.holder === holder;
  }

  async release(key: string, holder: string): Promise<void> {
    await sql`DELETE FROM connect_leases WHERE workspace = ${this.workspace} AND key = ${key} AND holder = ${holder}`.execute(this.db.kysely);
  }
}
