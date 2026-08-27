/**
 * What each connection has actually cost.
 *
 * The product tells people that refreshing spends their API's rate limit.
 * Until this existed that was advice; now it is a number they can look at.
 * It is also the honest half of the caching work — a cache that quietly
 * changes how much you spend should be able to say how much it saved.
 *
 * In memory alongside the cooldown, and reset with the process. Nothing here
 * is a record of *what* was read, only how often — so it carries none of the
 * customer's data and none of the retention questions that come with it.
 */

export interface ConnectionCost {
  /** Requests that actually left this machine. */
  upstreamCalls: number;
  /** Served from cache without asking the upstream at all. */
  cacheHits: number;
  /** Served stale while a refresh ran behind it. */
  revalidations: number;
  /** Revalidations the upstream answered with "unchanged". */
  notModified: number;
  /** Times the upstream refused us. */
  rateLimited: number;
  /** Times a cached copy stood in for a failed call. */
  servedStale: number;
  /** Roughly how much was transferred, for the ones that left. */
  bytesFetched: number;
  lastCallAt: number | null;
}

const empty = (): ConnectionCost => ({
  upstreamCalls: 0,
  cacheHits: 0,
  revalidations: 0,
  notModified: 0,
  rateLimited: 0,
  servedStale: 0,
  bytesFetched: 0,
  lastCallAt: null,
});

export class RequestAccounting {
  private readonly byConnection = new Map<string, ConnectionCost>();

  private entry(connection: string): ConnectionCost {
    const existing = this.byConnection.get(connection);
    if (existing) return existing;
    const created = empty();
    this.byConnection.set(connection, created);
    return created;
  }

  upstream(connection: string, bytes: number, now: number): void {
    const entry = this.entry(connection);
    entry.upstreamCalls++;
    entry.bytesFetched += Math.round(bytes);
    entry.lastCallAt = now;
  }

  hit(connection: string): void {
    this.entry(connection).cacheHits++;
  }

  revalidated(connection: string): void {
    this.entry(connection).revalidations++;
  }

  notModified(connection: string): void {
    this.entry(connection).notModified++;
  }

  refused(connection: string): void {
    this.entry(connection).rateLimited++;
  }

  stale(connection: string): void {
    this.entry(connection).servedStale++;
  }

  get(connection: string): ConnectionCost {
    return { ...this.entry(connection) };
  }

  all(): Record<string, ConnectionCost> {
    return Object.fromEntries([...this.byConnection].map(([id, cost]) => [id, { ...cost }]));
  }

  clear(): void {
    this.byConnection.clear();
  }
}

/**
 * The share of reads that never reached the upstream.
 *
 * Null rather than zero when nothing has been read yet: "no requests" and
 * "every request went upstream" are different facts and a panel that shows 0%
 * for both is telling somebody the cache is broken.
 */
export const savedShare = (cost: ConnectionCost): number | null => {
  const served = cost.cacheHits + cost.upstreamCalls + cost.servedStale;
  if (served === 0) return null;
  return (cost.cacheHits + cost.servedStale) / served;
};
