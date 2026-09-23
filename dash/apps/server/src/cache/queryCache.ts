import { AdapterError, type FetchResult } from "@freebirdai/dash-adapters";
import { queryKeyPrefix } from "@freebirdai/dash-spec";
import { RequestAccounting } from "./accounting.js";
import { ConnectionCooldown, coolingMessage, retryAfterSeconds } from "./cooldown.js";
import { ConnectionGate, Priority } from "./gate.js";
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
  /**
   * Why a stale copy was served instead of a fresh one, when something refused.
   *
   * A reader is handed the old rows either way, which is right for a person
   * looking at a board. The keeper is not a person: it has to tell "the API
   * said no, and will keep saying no" (401, 403) from "the API asked us to
   * wait" (429) from "nothing refused, the copy was just old". Without this
   * every one of those read as a successful refresh.
   */
  readonly error?: {
    readonly status?: number | undefined;
    readonly retryAfter?: string | undefined;
  };
}

/** A caller cannot ask us to hold something *fresh* for longer than this. */
const MAX_ACCEPTABLE_AGE_MS = 60 * 60_000;

/**
 * What `sweep()` would drop, if anything called it.
 *
 * Nothing does, and that is a decision rather than an oversight. This number
 * bounds *freshness*, and freshness is already stated per request through
 * `maxAgeMs` — a cached copy past this age is never served as current. What it
 * is still good for is the fallback: when the upstream refuses us, a copy from
 * two hours ago shown with "Showing data from 2 hours ago" is far better than
 * an empty tile, and sweeping on age would delete exactly those copies just
 * when they are most needed. The real bound is the store's size budget, which
 * is a memory limit and belongs there.
 */
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
  /** How many requests one connection gets at once. Unlimited when absent. */
  readonly gate?: ConnectionGate;
  readonly accounting?: RequestAccounting;
  /** Injected so tests do not depend on the wall clock. */
  readonly now?: () => number;
}

export class QueryCache {
  readonly store: CacheStore;
  readonly cooldown: ConnectionCooldown;
  readonly accounting: RequestAccounting;
  readonly gate: ConnectionGate;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<FetchResult>>();
  private readonly generations = new Map<string, number>();
  private globalGeneration = 0;
  private readonly invalidated = new Set<(connection: string | undefined) => void>();

  /**
   * What identifies "the era this connection's data belongs to".
   *
   * A composite so that a global wipe and a single connection's wipe cannot
   * produce the same token by arithmetic coincidence — an in-flight read that
   * compared equal across an invalidation would write the old account's rows
   * back into the cache after they were meant to be gone.
   */
  private generationOf(connection: string): string {
    return `${this.globalGeneration}:${this.generations.get(connection) ?? 0}`;
  }

  /**
   * Drop cached data, for one connection or for all of them.
   *
   * Scoped by default at every call site that can name a connection. The
   * unscoped form wipes every connection's data, which is correct only when
   * the caller genuinely cannot say which one changed: everything else it
   * deletes is a widget that will refetch cold, all at once, and collect its
   * own rate limit for nothing.
   *
   * Scoping is safe because `queryKey` leads with `${connection}.` and ids
   * cannot contain a dot, so the prefix cannot reach another connection's
   * keys. A credential change therefore still drops precisely that account's
   * data — in-flight reads for it included.
   */
  invalidate(connection?: string): void {
    if (connection === undefined) {
      this.globalGeneration++;
      this.generations.clear();
      this.store.clear();
      this.inFlight.clear();
    } else {
      this.generations.set(connection, (this.generations.get(connection) ?? 0) + 1);
      const prefix = queryKeyPrefix(connection);
      this.store.clear(prefix);
      for (const key of [...this.inFlight.keys()]) {
        if (key.startsWith(prefix)) this.inFlight.delete(key);
      }
    }
    for (const listener of this.invalidated) listener(connection);
  }

  /**
   * Be told when a connection's data is dropped.
   *
   * Every credential change goes through `invalidate`, which makes it the one
   * place anything holding a conclusion about an account — "this key is
   * refused" above all — can learn that the account changed underneath it.
   * Returns the unsubscribe.
   */
  onInvalidate(listener: (connection: string | undefined) => void): () => void {
    this.invalidated.add(listener);
    return () => {
      this.invalidated.delete(listener);
    };
  }

  /** When the copy under this key was stored, or null when there is none. */
  storedAt(key: string): number | null {
    return this.store.get(key)?.storedAt ?? null;
  }

  /** When the upstream will take requests again, or null when it will now. */
  coolingUntil(connection: string): number | null {
    return this.cooldown.check(connection, this.now())?.until ?? null;
  }

  constructor(options: QueryCacheOptions = {}) {
    this.store = options.store ?? new MemoryCacheStore();
    this.cooldown = options.cooldown ?? new ConnectionCooldown();
    this.accounting = options.accounting ?? new RequestAccounting();
    this.gate = options.gate ?? new ConnectionGate();
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
     * Where this sits in the queue when the connection is busy.
     *
     * Defaults to `Widget`, because everything that reaches this path today is
     * something on screen waiting to draw. Callers with nobody watching — the
     * chat harness, setup — pass `Background` so they cannot get in front of a
     * tile a person is looking at.
     */
    priority?: Priority;
    /**
     * Whether somebody is *looking* or somebody *asked*.
     *
     * The distinction this whole caching layer turned out to need. Every
     * upstream call used to be triggered by a person looking at something —
     * opening a board, switching tabs, reloading — so traffic was at its
     * burstiest exactly when somebody was waiting, and on a metered API that
     * is the shape that gets an account throttled.
     *
     * - `view` answers from the cache at **any** age, labelled, and goes
     *   upstream only when there is nothing at all to show. Freshness is the
     *   keeper's job, not the reader's.
     * - `refresh` is today's behaviour, and what the Refresh buttons and the
     *   keeper send: revalidate, paced.
     *
     * Defaults to `refresh` so every existing caller — the chat harness,
     * setup, the tests — keeps the behaviour it was written against.
     */
    mode?: "view" | "refresh";
    /**
     * How old a copy may be before a *view* calls it stale.
     *
     * Only the label. A view serves what it holds at any age either way; this
     * decides whether the tile says so. Passed by a caller that knows how often
     * the keeper refreshes this endpoint — a copy refreshed daily is not stale
     * at twenty minutes old, and a badge on every such tile teaches people to
     * ignore the badge. Never shorter than `maxAgeMs`.
     */
    freshForMs?: number;
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
    const {
      key,
      connection,
      maxAgeMs,
      fetcher,
      priority = Priority.Widget,
      mode = "refresh",
    } = input;
    const freshForMs = Math.max(maxAgeMs, input.freshForMs ?? 0);
    const generation = this.generationOf(connection);
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
     * A view never fetches.
     *
     * Age is not a reason to call somebody's API while they are reading; it is
     * a reason to say how old this is. So a view hands back whatever is held,
     * at any age, with the age attached — and only when there is nothing at
     * all does it fall through and fetch, which is the first sight of a widget
     * the keeper has not reached yet.
     *
     * Deliberately above the cooldown check: a cooling connection with a
     * cached copy takes this path too, and reaches the same answer without the
     * cooldown's message, because nothing was refused — nothing was asked.
     */
    if (mode === "view" && cached) {
      this.accounting.hit(connection);
      return {
        body: cached.body,
        meta: cached.meta,
        outcome: age <= freshForMs ? "hit" : "stale",
        ...(age > freshForMs
          ? { staleReason: "Showing the copy we already have; nothing was asked of the API." }
          : {}),
        ageMs: age,
      };
    }

    const cooling = this.cooldown.check(connection, now);

    /*
     * A view of something nothing has warmed yet, while the API is asking us
     * to wait.
     *
     * Reporting the rate limit here is true and useless: the reader has not
     * been refused anything, because a view asks for nothing. What is actually
     * happening is that this query has not been warmed yet and the keeper —
     * which the view itself just marked this connection as wanted for — will
     * fetch it within a tick. Saying *that* is the difference between "the
     * product is broken" and "one more moment".
     */
    if (mode === "view" && cooling) {
      throw new AdapterError(`not warmed yet for ${connection}`, {
        status: cooling.status,
        userMessage:
          "This has not been loaded yet, and the API has asked us to wait. It will appear shortly.",
        retryAfter: retryAfterSeconds(cooling.until, now),
      });
    }

    /*
     * The upstream has told us to stop. Serving what we have — clearly
     * labelled — beats both hammering it and showing an empty widget.
     */
    if (cooling) {
      const reason = coolingMessage(cooling, now);
      if (cached && generation === this.generationOf(connection)) {
        this.accounting.stale(connection);
        return {
          body: cached.body,
          meta: cached.meta,
          outcome: "stale",
          staleReason: reason,
          ageMs: age,
          error: { status: cooling.status, retryAfter: retryAfterSeconds(cooling.until, now) },
        };
      }
      /*
       * `retryAfter` rides along so the tile can count down rather than
       * offering a Retry button that is guaranteed to fail. Without it the
       * browser knows only that it was refused, and the obvious thing for
       * somebody to do — press the button again — is the one thing that
       * cannot work.
       */
      throw new AdapterError(`cooling down for ${connection}`, {
        status: cooling.status,
        userMessage: reason,
        retryAfter: retryAfterSeconds(cooling.until, now),
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
      void this.revalidate(key, connection, fetcher, priority);
      return {
        body: cached.body,
        meta: cached.meta,
        outcome: "revalidating",
        ageMs: age,
      };
    }

    try {
      const result = await this.fetchOnce(key, connection, fetcher, priority);
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
      if (cached && generation === this.generationOf(connection)) {
        this.accounting.stale(connection);
        const reason =
          error instanceof AdapterError
            ? error.userMessage
            : "That request did not come back, so this is the last copy we have.";
        return {
          body: cached.body,
          meta: cached.meta,
          outcome: "stale",
          staleReason: reason,
          ageMs: age,
          error:
            error instanceof AdapterError
              ? { status: error.status, retryAfter: error.retryAfter }
              : {},
        };
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
    priority: Priority,
  ): Promise<FetchResult> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const generation = this.generationOf(connection);

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
        const result = await this.gate.run(connection, priority, async () => {
          /*
           * Re-checked after the slot, not only before the queue.
           *
           * This is what turns a burst into one refusal. Twelve widgets open
           * together, the first few go upstream, one comes back 429 and sets
           * the cooldown — and the nine still queued behind it now find that
           * cooldown here and stop, instead of each collecting a refusal of
           * its own. `read`'s own catch then hands each of them the cached
           * copy with a label, so they show rows rather than errors.
           */
          const cooling = this.cooldown.check(connection, this.now());
          if (cooling)
            throw new AdapterError(`cooling down for ${connection}`, {
              status: cooling.status,
              userMessage: coolingMessage(cooling, this.now()),
              retryAfter: retryAfterSeconds(cooling.until, this.now()),
            });

          try {
            return await fetcher(validators);
          } catch (error) {
            /*
             * Recorded here, still holding the slot, and this placement is the
             * whole point.
             *
             * The obvious spot is the outer catch below — but `gate.run`
             * releases the slot in its own `finally`, which runs *before* that
             * catch. The next queued read would start, find no cooldown yet,
             * and collect a second refusal; with a queue of twelve that is
             * twelve refusals for one rate limit, which is the behaviour the
             * gate exists to prevent. Recording inside the task means the
             * cooldown is in force before anything else is let through.
             */
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
          }
        });
        if (generation !== this.generationOf(connection))
          throw new AdapterError(
            "The connection changed while data was loading. Refresh the preview.",
            { status: 409 },
          );

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
      } finally {
        /*
         * No 429 handling here on purpose — it happens inside the gated task
         * above, while the slot is still held. Doing it here would also catch
         * the cooldown's *own* refusal and extend the wait every time somebody
         * was turned away by it, so a busy board could never come back.
         */
        if (generation === this.generationOf(connection)) this.inFlight.delete(key);
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
    priority: Priority,
  ): Promise<void> {
    try {
      await this.fetchOnce(key, connection, fetcher, priority);
    } catch {
      /* the cached entry stands */
    }
  }

  sweep(): number {
    return this.store.sweep(CACHE_SWEEP_AGE_MS, this.now());
  }
}
