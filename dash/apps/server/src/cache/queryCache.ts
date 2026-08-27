import { AdapterError, type FetchResult } from "@freebirdai/dash-adapters";
import { RequestAccounting } from "./accounting.js";
import { ConnectionCooldown, waitPhrase } from "./cooldown.js";
import { MemoryCacheStore } from "./memory.js";
import { type CacheStore, estimateBytes } from "./store.js";

/**
 * The cache in front of every widget's request.
 *
 * Three things it has to get right, in order of how badly they hurt:
 *
 * 1. **Never serve data staler than the caller asked for.** Freshness is
 *    stated per request rather than configured here, because one endpoint is
 *    read by several widgets that legitimately disagree about how current they
 *    need to be.
 * 2. **One upstream call for concurrent identical reads.** This is where the
 *    multi-user win lands: twenty people opening a board is one request.
 * 3. **Failing must not lose what we already had.** A refresh that 429s should
 *    leave the previous rows on screen, labelled, not blank the widget.
 */

export type CacheOutcome = "hit" | "miss" | "revalidating" | "stale";

export interface QueryOutcome extends FetchResult {
  readonly outcome: CacheOutcome;
  /** Set whenever the body is older than the caller wanted. */
  readonly staleReason?: string;
  readonly ageMs: number;
}

/** A caller cannot ask us to hold something forever. */
const MAX_ACCEPTABLE_AGE_MS = 60 * 60_000;
/** How long an unread entry may sit before the sweep drops it. */
export const CACHE_SWEEP_AGE_MS = 60 * 60_000;

/**
 * Clamp the freshness a caller asked for.
 *
 * `maxAgeMs` arrives from the browser, so it is attacker-controlled in the
 * ordinary sense. It is a *ceiling* on age, never a floor, so the worst a
 * hostile value can do is force more upstream calls — which is why it is
 * clamped at the bottom too, not only at the top.
 */
export const clampMaxAge = (value: unknown): number => {
  const asNumber = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(0, asNumber), MAX_ACCEPTABLE_AGE_MS);
};

export interface QueryCacheOptions {
  readonly store?: CacheStore;
  readonly cooldown?: ConnectionCooldown;
  readonly accounting?: RequestAccounting;
  /** Injected so tests do not depend on the wall clock. */
  readonly now?: () => number;
}

export class QueryCache {
  readonly store: CacheStore;
  readonly cooldown: ConnectionCooldown;
  readonly accounting: RequestAccounting;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<FetchResult>>();

  constructor(options: QueryCacheOptions = {}) {
    this.store = options.store ?? new MemoryCacheStore();
    this.cooldown = options.cooldown ?? new ConnectionCooldown();
    this.accounting = options.accounting ?? new RequestAccounting();
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Read through the cache.
   *
   * `fetcher` is only ever called when this decides an upstream call is
   * warranted, which is what makes the accounting trustworthy.
   */
  async read(input: {
    key: string;
    connection: string;
    maxAgeMs: number;
    /**
     * Called only when this decides an upstream call is warranted, which is
     * what makes the accounting trustworthy. Receives the cached copy's
     * validators so it can ask conditionally.
     */
    fetcher: (validators?: {
      readonly etag?: string;
      readonly lastModified?: string;
    }) => Promise<FetchResult>;
  }): Promise<QueryOutcome> {
    const { key, connection, maxAgeMs, fetcher } = input;
    const now = this.now();
    const cached = this.store.get(key);
    const age = cached ? now - cached.storedAt : Number.POSITIVE_INFINITY;

    /*
     * `maxAgeMs > 0` is not redundant. A zero tolerance means "revalidate",
     * and an entry stored in the same millisecond has an age of zero — so
     * `age <= maxAgeMs` alone hands back the very copy the caller just asked
     * us to replace. Refresh would appear to work and change nothing.
     */
    if (cached && maxAgeMs > 0 && age <= maxAgeMs) {
      this.accounting.hit(connection);
      return { body: cached.body, meta: cached.meta, outcome: "hit", ageMs: age };
    }

    /*
     * The upstream has told us to stop. Serving what we have — clearly
     * labelled — beats both hammering it and showing an empty widget.
     */
    const cooling = this.cooldown.check(connection, now);
    if (cooling) {
      const reason = `${cooling.reason} Waiting ${waitPhrase(cooling.until, now)} before trying again.`;
      if (cached) {
        this.accounting.stale(connection);
        return { body: cached.body, meta: cached.meta, outcome: "stale", staleReason: reason, ageMs: age };
      }
      throw new AdapterError(`cooling down for ${connection}`, {
        status: cooling.status,
        userMessage: reason,
      });
    }

    /*
     * Stale-while-revalidate, but only when the caller left room for it.
     * `maxAgeMs: 0` is what an explicit Refresh sends, and somebody who asked
     * for fresh data waits for fresh data rather than being handed the same
     * rows back with a promise.
     */
    if (cached && maxAgeMs > 0) {
      this.accounting.revalidated(connection);
      void this.revalidate(key, connection, fetcher);
      return {
        body: cached.body,
        meta: cached.meta,
        outcome: "revalidating",
        ageMs: age,
      };
    }

    try {
      const result = await this.fetchOnce(key, connection, fetcher);
      // A 304 means the entry we already had is current after all.
      const fresh = this.store.get(key);
      if (result.notModified && fresh) {
        return { body: fresh.body, meta: fresh.meta, outcome: "hit", ageMs: 0 };
      }
      return { ...result, outcome: "miss", ageMs: 0 };
    } catch (error) {
      /*
       * Nothing came back. If we hold anything at all, that is better than an
       * empty tile — provided it says why it is old.
       */
      if (cached) {
        this.accounting.stale(connection);
        const reason =
          error instanceof AdapterError
            ? error.userMessage
            : "That request did not come back, so this is the last copy we have.";
        return { body: cached.body, meta: cached.meta, outcome: "stale", staleReason: reason, ageMs: age };
      }
      throw error;
    }
  }

  /**
   * One upstream call per key, however many callers are waiting.
   *
   * The promise is shared rather than the result, so a second caller arriving
   * mid-flight waits on the first request instead of starting a second.
   */
  private async fetchOnce(
    key: string,
    connection: string,
    fetcher: (validators?: {
      readonly etag?: string;
      readonly lastModified?: string;
    }) => Promise<FetchResult>,
  ): Promise<FetchResult> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const run = (async () => {
      const previous = this.store.get(key);
      const validators =
        previous?.etag || previous?.lastModified
          ? {
              ...(previous.etag ? { etag: previous.etag } : {}),
              ...(previous.lastModified ? { lastModified: previous.lastModified } : {}),
            }
          : undefined;

      try {
        const result = await fetcher(validators);

        /*
         * Nothing changed. The body we already hold becomes current again for
         * the cost of a header exchange — on many APIs a 304 does not even
         * count against the rate limit.
         */
        if (result.notModified && previous) {
          this.store.set({ ...previous, storedAt: this.now(), meta: previous.meta });
          this.accounting.notModified(connection);
          this.cooldown.succeeded(connection);
          return result;
        }

        const bytes = estimateBytes(result.body);
        this.store.set({
          key,
          body: result.body,
          meta: result.meta,
          storedAt: this.now(),
          bytes,
          ...(result.validators?.etag ? { etag: result.validators.etag } : {}),
          ...(result.validators?.lastModified
            ? { lastModified: result.validators.lastModified }
            : {}),
        });
        this.accounting.upstream(connection, bytes, this.now());
        this.cooldown.succeeded(connection);
        return result;
      } catch (error) {
        if (error instanceof AdapterError && error.status === 429) {
          this.accounting.refused(connection);
          this.cooldown.refused({
            connection,
            status: 429,
            retryAfter: error.retryAfter,
            reason: error.userMessage,
            now: this.now(),
          });
        }
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, run);
    return run;
  }

  /**
   * Refresh behind a stale answer.
   *
   * Failure is swallowed on purpose: the caller has already been given usable
   * rows, and evicting them because the refresh failed would turn a working
   * widget into an empty one for no reader-visible benefit. The 429 handling
   * inside `fetchOnce` still records the cooldown, so the next read knows.
   */
  private async revalidate(
    key: string,
    connection: string,
    fetcher: (validators?: {
      readonly etag?: string;
      readonly lastModified?: string;
    }) => Promise<FetchResult>,
  ): Promise<void> {
    try {
      await this.fetchOnce(key, connection, fetcher);
    } catch {
      /* the cached entry stands */
    }
  }

  sweep(): number {
    return this.store.sweep(CACHE_SWEEP_AGE_MS, this.now());
  }
}
