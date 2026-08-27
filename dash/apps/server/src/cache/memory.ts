import { type CacheEntry, type CacheStore } from "./store.js";

/**
 * The shipped cache: in this process, and gone when it stops.
 *
 * Bounded by **both** a count and a byte budget. An entry cap alone is not a
 * bound at all here — a single response may be up to `MAX_BODY_BYTES` (8MB),
 * so a hundred entries is eight hundred megabytes of a server that is supposed
 * to be a thin proxy.
 *
 * Eviction is least-recently-*used*, tracked on read as well as write, because
 * the endpoint everybody's dashboard opens on is the one worth keeping and it
 * may not be the one written most recently.
 */
export class MemoryCacheStore implements CacheStore {
  /** Insertion order is the LRU order; a read re-inserts. */
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 500,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-insert to move it to the young end of the Map's iteration order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(entry: CacheEntry): void {
    const existing = this.entries.get(entry.key);
    if (existing) this.bytes -= existing.bytes;

    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
    this.bytes += entry.bytes;

    /*
     * One response larger than the whole budget would otherwise evict
     * everything and then sit there alone. Refusing it keeps the cache useful
     * for the many small responses it is actually for.
     */
    if (entry.bytes > this.maxBytes) {
      this.delete(entry.key);
      return;
    }

    this.evict();
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.bytes -= existing.bytes;
    this.entries.delete(key);
  }

  sweep(maxAgeMs: number, now: number): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt <= maxAgeMs) continue;
      this.delete(key);
      dropped++;
    }
    return dropped;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: Math.round(this.bytes) };
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      // The Map's first key is the least recently used.
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }
}
