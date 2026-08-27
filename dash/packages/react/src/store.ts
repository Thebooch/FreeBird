import { AdapterError, type AdapterRegistry, type FetchMeta } from "@freebirdai/dash-adapters";
/*
 * Re-exported, not re-implemented. The server caches on the same identity,
 * and a second copy that drifted would serve one widget the rows of another.
 */
import type { QueryParams, ResolvedParams } from "@freebirdai/dash-spec";
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
  };
  readonly fetchedAt: number;
  readonly startedAt: number;
}


/**
 * A tiny request cache keyed on connection + op + resolved params.
 *
 * The deduplication is the point: three widgets reading the same endpoint at
 * the same time cause one request, not three. A hand-built dashboard almost
 * never does this, and it is why they hammer rate limits.
 */
export class QueryClient {
  private readonly entries = new Map<string, QueryEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly registry: AdapterRegistry) {}

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
  }): Promise<void> {
    const { key, connection, op, params, resolved, now, force, maxAgeMs } = input;

    const existing = this.entries.get(key);
    if (!force && existing && existing.status !== "idle") {
      return this.inFlight.get(key) ?? Promise.resolve();
    }
    const pending = this.inFlight.get(key);
    if (pending && !force) return pending;

    this.set(key, {
      status: "loading",
      startedAt: now,
      fetchedAt: existing?.fetchedAt ?? 0,
      // Keep the previous body so a refresh does not blank the widget.
      ...(existing?.body !== undefined ? { body: existing.body } : {}),
      ...(existing?.meta ? { meta: existing.meta } : {}),
    });

    const run = this.registry
      .fetch(connection, op, params, {
        params: resolved,
        now,
        maxAgeMs: force ? 0 : (maxAgeMs ?? 0),
      })
      .then((result) => {
        this.set(key, {
          status: "ok",
          body: result.body,
          meta: result.meta,
          startedAt: now,
          fetchedAt: result.meta.fetchedAt,
        });
      })
      .catch((error: unknown) => {
        const adapterError = error instanceof AdapterError ? error : null;
        this.set(key, {
          status: "error",
          startedAt: now,
          fetchedAt: now,
          error: {
            message: error instanceof Error ? error.message : String(error),
            userMessage:
              adapterError?.userMessage ??
              "That request did not come back. The connection may be down or the key may have expired.",
            ...(adapterError?.status ? { status: adapterError.status } : {}),
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
