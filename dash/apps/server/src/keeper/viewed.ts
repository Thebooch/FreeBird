import type { ResolvedParams } from "@freebirdai/dash-spec";

/**
 * What boards have actually asked for, so the keeper refreshes that and not a
 * prediction of it.
 *
 * The keeper used to work out its targets from the boards alone — each
 * widget's source, at the board's default filters and a window resolved
 * against the server's clock. Anything else a person looked at was a key the
 * keeper never touched: a filter they changed, a range they picked, a window
 * anchored to when they opened the page. And because a view never fetches
 * what it already holds, those widgets showed their first answer forever.
 *
 * Recording the request itself — key, query string, path inputs, window —
 * means the keeper asks the API exactly what the reader will read. Nothing is
 * inferred, so nothing can disagree.
 *
 * Bounded twice: by count, least recently viewed first out, and by age, so a
 * board nobody has opened since yesterday stops costing anything. The count
 * matches the cache's own entry budget; warming more than the cache can hold
 * would be paying for rows it then evicts.
 */

export interface ViewedRequest {
  readonly key: string;
  readonly connection: string;
  readonly op: string;
  /** Query-string values, exactly as `/api/query` sent them upstream. */
  readonly overrides: Readonly<Record<string, string | number | boolean>>;
  /** The window, and the filters with any path inputs folded in. */
  readonly resolved: ResolvedParams;
  /**
   * The names of the parameters the caller supplied, sorted.
   *
   * What tells a widget's own read apart from a per-record lookup against the
   * same endpoint: a table of vendors asks `vendors` with the parameters its
   * source declares, a name lookup asks `vendors?vendorId=123`. Only the first
   * is worth keeping warm — see `KeeperTargets`.
   */
  readonly shape: string;
}

/** How many requests are remembered. The cache holds 500 entries. */
export const VIEWED_MAX = 500;

/** How long a request stays worth refreshing after anybody last asked. */
export const VIEWED_KEEP_MS = 24 * 60 * 60_000;

/** A parameter bag's shape: which names it carries, not what they hold. */
export const paramShape = (params: Readonly<Record<string, unknown>>): string =>
  Object.keys(params).sort().join("&");

export class ViewedRequests {
  private readonly entries = new Map<string, ViewedRequest & { at: number }>();

  constructor(
    private readonly max = VIEWED_MAX,
    private readonly keepMs = VIEWED_KEEP_MS,
  ) {}

  record(request: ViewedRequest, now: number): void {
    /* Re-inserted, so iteration order is least recently viewed first. */
    this.entries.delete(request.key);
    this.entries.set(request.key, { ...request, at: now });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Everything viewed recently enough to be worth refreshing. */
  recent(now: number): ViewedRequest[] {
    const kept: ViewedRequest[] = [];
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.at > this.keepMs) {
        this.entries.delete(key);
        continue;
      }
      const { at: _at, ...request } = entry;
      kept.push(request);
    }
    return kept;
  }

  get size(): number {
    return this.entries.size;
  }
}
