import type { FetchMeta } from "@freebirdai/dash-adapters";

/**
 * Where cached responses live.
 *
 * A boundary rather than a concrete store, for the same reason `SourceAdapter`,
 * `PartLayer` and `DbAdapter` are boundaries: a hosted deployment needs a cache
 * shared across instances, and it should be able to supply one without editing
 * the query path.
 *
 * The shipped implementation is memory-only and deliberately so. A response
 * cache holds a customer's own records, and keeping them in a process that
 * forgets everything when it stops is what makes "we read your API, we do not
 * keep it" literally true for a self-hoster. Anything that writes them to disk
 * is a decision somebody should make on purpose.
 */

export interface CacheEntry {
  readonly key: string;
  /** The upstream response, already paginated and combined. */
  readonly body: unknown;
  readonly meta: FetchMeta;
  readonly storedAt: number;
  /** Roughly how much memory this holds, for the byte budget. */
  readonly bytes: number;
  /** Validators for a conditional revalidation, when the upstream sent them. */
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  set(entry: CacheEntry): void;
  delete(key: string): void;
  /** Drop anything older than `maxAgeMs`. Called on a timer, not per request. */
  sweep(maxAgeMs: number, now: number): number;
  /** For the accounting panel and for tests. */
  stats(): { entries: number; bytes: number };
  clear(): void;
}

/**
 * A cheap size estimate.
 *
 * `JSON.stringify` on every store would cost more than the cache saves on a
 * large body, so this walks the structure and counts. It only has to be good
 * enough to keep a budget honest — being out by a factor of two on a 4MB
 * response still stops the process from holding a gigabyte.
 */
export const estimateBytes = (value: unknown, depth = 0): number => {
  if (value === null || value === undefined) return 4;
  if (depth > 6) return 32;

  switch (typeof value) {
    case "string":
      // Two bytes per char is the pessimistic case and the safe direction.
      return value.length * 2;
    case "number":
      return 8;
    case "boolean":
      return 4;
    case "object": {
      if (Array.isArray(value)) {
        // Long arrays are sampled: a 50,000-row response would otherwise cost
        // more to measure than to hold.
        const sampled = value.length > 200 ? value.slice(0, 200) : value;
        const measured = sampled.reduce<number>(
          (total, item) => total + estimateBytes(item, depth + 1),
          0,
        );
        return value.length > 200 ? (measured / sampled.length) * value.length : measured;
      }
      let total = 0;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        total += key.length * 2 + estimateBytes(item, depth + 1);
      }
      return total;
    }
    default:
      return 16;
  }
};
