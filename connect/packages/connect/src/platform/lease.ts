
/**
 * Who may do a piece of background work right now.
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
