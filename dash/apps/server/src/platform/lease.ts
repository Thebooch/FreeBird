import { sql } from "kysely";
import type { DashDb } from "./db.js";

/**
 * Who may do a piece of background work right now (plan, track G).
 *
 * One server has one keeper, and nothing to decide. Several servers sharing
 * one database — a hosted fleet — would each refresh every connection, and
 * ask every API several times over. A lease settles it: the keeper takes the
 * lease on a connection before refreshing it, and only the server holding it
 * does the work. A lease lapses by itself, so a server that stops mid-pass
 * holds nothing for long.
 */
export interface LeaseLock {
  /** Take the lease, or renew one this holder already has. False when another holder has it. */
  acquire(key: string, holder: string, ttlMs: number): Promise<boolean>;
  release(key: string, holder: string): Promise<void>;
}

/** One process: every lease is this process's to take. */
export class MemoryLeaseLock implements LeaseLock {
  private readonly held = new Map<string, { holder: string; until: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async acquire(key: string, holder: string, ttlMs: number): Promise<boolean> {
    const current = this.held.get(key);
    if (current && current.holder !== holder && current.until > this.now()) return false;
    this.held.set(key, { holder, until: this.now() + ttlMs });
    return true;
  }

  async release(key: string, holder: string): Promise<void> {
    if (this.held.get(key)?.holder === holder) this.held.delete(key);
  }
}

/** Every server sharing Dash's database, through one row per lease. */
export class DbLeaseLock implements LeaseLock {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async acquire(key: string, holder: string, ttlMs: number): Promise<boolean> {
    const until = new Date(Date.now() + ttlMs).toISOString();
    const now = new Date().toISOString();
    /* Taken if free, lapsed, or already this holder's: one statement, so two servers cannot both win. */
    const result = await sql<{ holder: string }>`
      INSERT INTO dash_leases (workspace, key, holder, until) VALUES (${this.workspace}, ${key}, ${holder}, ${until})
      ON CONFLICT (workspace, key) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until
        WHERE dash_leases.holder = EXCLUDED.holder OR dash_leases.until < ${now}
      RETURNING holder
    `.execute(this.db.kysely);
    return result.rows.length > 0 && result.rows[0]!.holder === holder;
  }

  async release(key: string, holder: string): Promise<void> {
    await sql`DELETE FROM dash_leases WHERE workspace = ${this.workspace} AND key = ${key} AND holder = ${holder}`.execute(this.db.kysely);
  }
}
