import {
  AdapterError,
  type AdapterRegistry,
  type FetchMeta,
  parseRetryAfter,
} from "@freebirdai/dash-adapters";
/*
 * Re-exported, not re-implemented. The server caches on the same identity,
 * and a second copy that drifted would serve one widget the rows of another.
 */
import { queryKeyPrefix, type QueryParams, type ResolvedParams } from "@freebirdai/dash-spec";
import { RequestQueue, Wave } from "./queue.js";
export { queryKey } from "@freebirdai/dash-spec";
export type { QueryParams } from "@freebirdai/dash-spec";

export type QueryStatus = "idle" | "loading" | "ok" | "error";

export interface QueryEntry {
  readonly status: QueryStatus;
  readonly body?: unknown;
  readonly meta?: FetchMeta;
  readonly error?: {
    readonly message: string;
    readonly userMessage: string;
    /**
     * The HTTP status, where the failure had one.
     *
     * Carried because 401, 403 and an empty 200 are three different things to
     * tell somebody and were previously one. A 403 in particular is *proof the
     * key works* — you cannot be forbidden without first being identified — so
     * showing it as "the connection may be down" sends people to re-enter a
     * credential that was never the problem.
     */
    readonly status?: number;
    /**
     * When it is worth asking again, from the upstream's `Retry-After`.
     *
     * The tile counts down to this and keeps its Retry button disabled until
     * it passes: before then a retry is guaranteed to meet the same cooldown,
     * and offering the one action that cannot work is how somebody learns to
     * distrust the button. Absent when nothing said how long to wait.
     */
    readonly retryAt?: number;
  };
  readonly fetchedAt: number;
  readonly startedAt: number;
  /**
   * What produced this entry, so it can be run again without being asked.
   *
   * Kept because "Refresh all" has to replay a query it is not currently
   * rendering, and reconstructing the request from the key is not possible —
   * the key is a one-way digest of the params, not the params.
   */
  readonly request?: QueryRequest;
}

/** Everything `ensure` needs besides the key itself. */
interface QueryRequest {
  readonly connection: string;
  readonly op: string;
  readonly params: QueryParams;
  readonly resolved: ResolvedParams;
  readonly maxAgeMs?: number;
  readonly wave?: Wave;
}

/** How long to wait when a refusal did not say. Mirrors the server's default. */
const DEFAULT_RETRY_MS = 60_000;


/**
 * A tiny request cache keyed on connection + op + resolved params.
 *
 * The deduplication is the point: three widgets reading the same endpoint at
 * the same time cause one request, not three. A hand-built dashboard almost
 * never does this, and it is why they hammer rate limits.
 */
export class QueryClient {
  private readonly entries = new Map<string, QueryEntry>();
  /**
   * What to ask for first when more is wanted than the board should ask at once.
   *
   * Constructor-injected so a test can run without one and see the old
   * behaviour — every request starting the moment it is asked for.
   */
  private readonly queue: RequestQueue;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private registry: AdapterRegistry,
    queue?: RequestQueue,
  ) {
    this.queue = queue ?? new RequestQueue();
  }

  /**
   * Point at a newly built registry.
   *
   * The provider creates this client once and keeps it for the life of a
   * board, but the host rebuilds its registry whenever a connection spec
   * changes. Without this the client kept fetching through the registry it was
   * born with, so an edited connection — a new base URL, a new op — silently
   * never reached the request path.
   */
  setRegistry(registry: AdapterRegistry): void {
    this.registry = registry;
  }

  /**
   * Called with every response, so something else can index what arrived.
   *
   * A hook rather than a dependency: this class knows about requests and
   * nothing about record types, and giving it an entity map to keep in step
   * would make the cache the wrong place to change when the map changes. The
   * provider owns that map and does the indexing.
   */
  onFetched?: (input: {
    connection: string;
    op: string;
    body: unknown;
    /** What it was asked with — a scoped list's parent id is among these. */
    params: QueryParams;
  }) => void;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  get(key: string): QueryEntry | undefined {
    return this.entries.get(key);
  }

  private set(key: string, entry: QueryEntry): void {
    this.entries.set(key, entry);
    this.emit();
  }

  invalidate(key?: string): void {
    if (key) this.entries.delete(key);
    else this.entries.clear();
    this.emit();
  }

  /**
   * Drop everything belonging to one connection.
   *
   * The counterpart to the server's scoped invalidation, and now a
   * requirement rather than a nicety: bodies survive a failed refresh, so a
   * credential change has to reach this cache too. Without it the server
   * correctly forgets the old account's rows and the browser goes on
   * displaying them.
   */
  invalidateConnection(connection: string): void {
    const prefix = queryKeyPrefix(connection);
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    this.emit();
  }

  /**
   * Re-run every known query, keeping the rows on screen while they land.
   *
   * "Refresh all" used to `invalidate()` first, which blanked the whole board
   * and then, if the refresh was refused, left it blank. `ensure`'s loading
   * path already carries the previous body forward — this just stops throwing
   * it away before asking. Replayed from each entry's own recorded request, so
   * it needs nothing from the caller and cannot re-run a query under different
   * params than it was made with.
   */
  refreshAll(now: number): void {
    for (const [key, entry] of [...this.entries]) {
      if (!entry.request) continue;
      void this.ensure({ ...entry.request, key, now, force: true });
    }
  }

  /**
   * Ensure a query has been run. Concurrent callers for the same key await the
   * same promise; a completed query is not re-run unless `force` is set.
   */
  ensure(input: {
    key: string;
    connection: string;
    op: string;
    params: QueryParams;
    resolved: ResolvedParams;
    now: number;
    force?: boolean;
    /**
     * How old an answer the caller will accept, handed to the server's cache.
     *
     * A forced refresh sends zero regardless: somebody who pressed Refresh is
     * asking for a new answer, not for the one they already have.
     */
    maxAgeMs?: number;
    /**
     * Which wave this belongs to, when the board wants more at once than it
     * should ask for. Defaults to `Widget`: something visible is waiting.
     */
    wave?: Wave;
    /**
     * Whether a forced ensure asks the API or only the server.
     *
     * `refresh` — the default for a forced call — is somebody pressing
     * Refresh: the server revalidates upstream. `view` re-reads what the
     * server already holds, which is what a poll wants: the keeper keeps that
     * current, so reading it costs nobody's API anything, however many tabs
     * are open. Unforced calls are always `view`.
     */
    mode?: "view" | "refresh";
  }): Promise<void> {
    const { key, connection, op, params, resolved, now, force, maxAgeMs } = input;
    const mode = input.mode ?? (force ? "refresh" : "view");
    const asking = force === true && mode === "refresh";
    // A forced refresh jumps the queue: somebody pressed a button and is
    // watching for it to answer. A re-read does not — nobody pressed anything.
    const wave = asking ? Wave.Forced : (input.wave ?? Wave.Widget);
    const request: QueryRequest = {
      connection,
      op,
      params,
      resolved,
      ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
      wave,
    };

    const existing = this.entries.get(key);
    if (!force && existing && existing.status !== "idle") {
      return this.inFlight.get(key) ?? Promise.resolve();
    }
    const pending = this.inFlight.get(key);
    if (pending && !force) return pending;

    this.set(key, {
      status: "loading",
      request,
      startedAt: now,
      fetchedAt: existing?.fetchedAt ?? 0,
      // Keep the previous body so a refresh does not blank the widget.
      ...(existing?.body !== undefined ? { body: existing.body } : {}),
      ...(existing?.meta ? { meta: existing.meta } : {}),
    });

    const run = this.queue
      .run(connection, wave, () =>
        this.registry.fetch(connection, op, params, {
          params: resolved,
          now,
          maxAgeMs: asking ? 0 : (maxAgeMs ?? 0),
          /*
           * Looking is not asking.
           *
           * Everything that is not an explicit refresh is somebody opening a
           * board, switching a tab or reloading a page — and none of those are
           * a reason to call an API. The server answers those from what it
           * holds, however old, and says how old; keeping it fresh is the
           * keeper's job. This is what makes navigation free.
           */
          mode,
        }),
      )
      .then((result) => {
        this.set(key, {
          status: "ok",
          request,
          body: result.body,
          meta: result.meta,
          startedAt: now,
          fetchedAt: result.meta.fetchedAt,
        });
        // After the entry lands, so anything the hook triggers sees a
        // consistent cache rather than a half-applied one.
        this.onFetched?.({ connection, op, body: result.body, params });
      })
      .catch((error: unknown) => {
        const adapterError = error instanceof AdapterError ? error : null;
        /*
         * A credential or a permission is not something waiting fixes.
         *
         * 401 and 403 are settled answers: the key is wrong, or this account
         * cannot read this. Scheduling a retry for either would ask the same
         * question every minute for as long as the tab is open — spending the
         * rate limit that everything else needs, to be told the same thing.
         * No `retryAt` means no countdown and no automatic retry, which is
         * also the answer `describeFailure` already gives these two.
         */
        const permanent = adapterError?.status === 401 || adapterError?.status === 403;
        const waitMs = adapterError
          ? (parseRetryAfter(adapterError.retryAfter, now) ?? DEFAULT_RETRY_MS)
          : DEFAULT_RETRY_MS;
        this.set(key, {
          status: "error",
          request,
          startedAt: now,
          /*
           * What we already had, kept.
           *
           * The server's cache makes the same promise in its own docblock — a
           * refresh that 429s leaves the previous rows on screen, labelled —
           * and this was the one layer that broke it. Dropping the body here
           * meant a rate limit turned a working widget into an empty one, and
           * an empty widget tells the reader strictly less than old numbers
           * with a date on them. The failure is still reported; it is reported
           * *over* the rows rather than instead of them.
           */
          ...(existing?.body !== undefined ? { body: existing.body } : {}),
          ...(existing?.meta ? { meta: existing.meta } : {}),
          /*
           * Not `now`: nothing was fetched. Claiming otherwise would put
           * "updated just now" over hour-old rows and defeat the stale badge,
           * which is the one signal saying how much to trust them.
           */
          fetchedAt: existing?.fetchedAt ?? 0,
          error: {
            message: error instanceof Error ? error.message : String(error),
            userMessage:
              adapterError?.userMessage ??
              "That request did not come back. The connection may be down or the key may have expired.",
            ...(adapterError?.status ? { status: adapterError.status } : {}),
            ...(permanent ? {} : { retryAt: now + waitMs }),
          },
        });
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, run);
    return run;
  }

  /** Snapshot for the inspector and for tests. */
  entriesSnapshot(): ReadonlyMap<string, QueryEntry> {
    return new Map(this.entries);
  }
}
