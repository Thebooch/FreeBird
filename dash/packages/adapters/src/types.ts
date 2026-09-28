import type { ConnectionSpec, OpSpec, ResolvedParams } from "@freebirdai/dash-spec";

/**
 * Where an adapter is allowed to run.
 *
 * `direct` adapters work in the browser with no server. `proxy` adapters must
 * run server-side — which is nearly every real API, because they send no CORS
 * headers and because a key in browser JavaScript is a key on the wire. The
 * runtime surfaces this as a clear widget state rather than a mystery network
 * error.
 */
export type Transport = "direct" | "proxy";

export interface FetchMeta {
  /** Opaque server evidence for checking a draft against this response. */
  readonly receipt?: string;
  /** The URL actually requested, with secrets already redacted. */
  readonly url: string;
  readonly status: number;
  readonly fetchedAt: number;
  readonly durationMs: number;
  /** How many pages were combined into this body. */
  readonly pages: number;
  /** Set when the page cap stopped us before the data ran out. */
  readonly truncated: boolean;
  /**
   * How many records the API says match in all, when it says — a total in
   * the response or an `X-Total-Count` header. What a read is checked
   * against, and what "read 500 of 12,431" is counted from.
   */
  readonly reportedTotal?: number;
  readonly warnings: readonly string[];
  /**
   * Whether this came from the server's cache, and how.
   *
   * Absent on a direct adapter call — only the proxied path has a cache in
   * front of it. The inspector renders this, so provenance surfaces without
   * new plumbing.
   */
  readonly cache?: "hit" | "miss" | "revalidating" | "stale";
  readonly ageMs?: number;
  /**
   * Why the reader is looking at something older than they asked for.
   *
   * Set only when that is actually true. A widget shows this prominently, so
   * an empty string here would be a banner saying nothing.
   */
  readonly staleReason?: string;
}

export interface FetchResult {
  readonly body: unknown;
  readonly meta: FetchMeta;
  /**
   * The upstream said nothing has changed since the validators we sent.
   *
   * `body` is meaningless when this is set — the caller keeps whatever it
   * already had and simply treats it as fresh again.
   */
  readonly notModified?: boolean;
  /** Validators to quote next time, when the upstream offered them. */
  readonly validators?: { readonly etag?: string; readonly lastModified?: string };
}

export interface FetchContext {
  readonly params: ResolvedParams;
  readonly now: number;
  readonly signal?: AbortSignal;
  /**
   * How stale an answer the caller will accept, in milliseconds.
   *
   * Only the proxy reads it — a direct adapter has nothing in front of it to
   * ask. Zero means revalidate.
   */
  readonly maxAgeMs?: number;
  /**
   * Whether somebody is looking, or somebody asked.
   *
   * `view` means a board is being read: serve what is held, at any age, and
   * do not call the API. `refresh` is what a Refresh button sends. Only the
   * proxy reads it — a direct adapter has no cache in front of it.
   *
   * Absent means `refresh`, which is what every caller did before this
   * existed.
   */
  readonly mode?: "view" | "refresh";
  /**
   * Validators from a previously cached copy, for a conditional request.
   *
   * Supplied only where a 304 would actually prove something — see the
   * pagination caveat in `RestAdapter`.
   */
  readonly validators?: { readonly etag?: string; readonly lastModified?: string };
  /**
   * Resolve a vault reference to a secret. Adapters never read the vault
   * themselves and never see a key they were not explicitly handed.
   */
  readonly resolveSecret?: (keyRef: string) => Promise<string | null>;
  /**
   * A new credential after a page was refused for its token — OAuth's
   * renewal. Resolves true when there is one; the refused page is then read
   * again with it, and the read carries on from there rather than starting
   * over, so a token that runs out part-way through does not cost the pages
   * already read.
   */
  readonly renew?: () => Promise<boolean>;
}

export interface SourceAdapter {
  readonly kind: ConnectionSpec["kind"];
  readonly transport: Transport;
  fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult>;
}

export class AdapterError extends Error {
  readonly status: number;
  /** Safe to show a non-technical user. Never contains a secret. */
  readonly userMessage: string;
  /**
   * The upstream's `Retry-After`, verbatim, when it sent one.
   *
   * Separate from `userMessage` because a caller needs to *act* on it — an
   * enumeration pass stops and records how long to wait — and parsing a
   * duration back out of an English sentence is not a thing to ask of anyone.
   */
  readonly retryAfter?: string;
  /**
   * The status the API itself answered with, where it answered.
   *
   * `status` is this product's reading of the failure — every error the API
   * gives that is not a refusal becomes a 502 — and that reading hides the one
   * distinction some callers need: a 404 means "there is none", which is how
   * a unit with no listing yet is told apart from a listing that failed to load.
   */
  readonly upstreamStatus?: number;
  /**
   * What the API said about a refused change, trimmed and with any secret
   * taken out. A 422 that names the field it objected to is the only way a
   * person can fix what they sent.
   */
  readonly detail?: string;
  /**
   * For a change: whether it is known that nothing was sent (`not-sent`), or
   * the request went out and the answer was lost (`unknown`). Absent when the
   * API answered, which says for itself what happened.
   */
  readonly outcome?: "not-sent" | "unknown";

  constructor(
    message: string,
    options: {
      status?: number;
      userMessage?: string;
      retryAfter?: string;
      upstreamStatus?: number;
      detail?: string;
      outcome?: "not-sent" | "unknown";
    } = {},
  ) {
    super(message);
    this.name = "AdapterError";
    this.status = options.status ?? 502;
    this.userMessage = options.userMessage ?? message;
    if (options.retryAfter) this.retryAfter = options.retryAfter;
    if (options.upstreamStatus !== undefined) this.upstreamStatus = options.upstreamStatus;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.outcome !== undefined) this.outcome = options.outcome;
  }
}

/**
 * One change to send: the endpoint, the values for its path, and the body.
 *
 * Deliberately not an `OpSpec`. A read op is resolved through pagination, row
 * paths and the time range, none of which a change has; and keeping the two
 * types apart is what stops a write from ever being handed to `fetch`.
 */
export interface WriteRequest {
  readonly op: {
    readonly id: string;
    readonly title: string;
    readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
    readonly path: string;
    readonly query: Readonly<Record<string, string | number | boolean>>;
    readonly headers: Readonly<Record<string, string>>;
    readonly auth?: import("@freebirdai/dash-spec").AuthSpec | undefined;
    readonly authRequired?: boolean | undefined;
  };
  /** Every path parameter's value, as text. Encoded when the URL is built. */
  readonly params: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly contentType?: string;
}

export interface WriteResult {
  readonly status: number;
  /** What the API answered with: the record, usually, or `null`. */
  readonly body: unknown;
  /** Where a create says the new record lives, when it says. */
  readonly location: string | null;
  /** The URL as sent, with any query-string credential masked. */
  readonly url: string;
  readonly durationMs: number;
}

export interface WriteContext {
  readonly now: number;
  readonly signal?: AbortSignal;
  readonly resolveSecret?: (keyRef: string) => Promise<string | null>;
}

/**
 * `Retry-After` as milliseconds from now, or null when there is nothing to go on.
 *
 * Beside `AdapterError.retryAfter` because that is where the verbatim header
 * is defined, and every layer that wants to *act* on it needs this same
 * reading: the server to set a cooldown, the browser to count a tile down.
 * Two implementations would disagree on the date form — and a date parsed as a
 * number comes out `NaN`, which silently disables the back-off rather than
 * failing loudly.
 */
export const parseRetryAfter = (value: string | undefined, now: number): number | null => {
  if (!value) return null;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  // The other legal form is an HTTP date.
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
};

export const emptyMeta = (url: string, now: number): FetchMeta => ({
  url,
  status: 200,
  fetchedAt: now,
  durationMs: 0,
  pages: 1,
  truncated: false,
  warnings: [],
});
