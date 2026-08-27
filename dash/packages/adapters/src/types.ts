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
  /** The URL actually requested, with secrets already redacted. */
  readonly url: string;
  readonly status: number;
  readonly fetchedAt: number;
  readonly durationMs: number;
  /** How many pages were combined into this body. */
  readonly pages: number;
  /** Set when the page cap stopped us before the data ran out. */
  readonly truncated: boolean;
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

  constructor(
    message: string,
    options: { status?: number; userMessage?: string; retryAfter?: string } = {},
  ) {
    super(message);
    this.name = "AdapterError";
    this.status = options.status ?? 502;
    this.userMessage = options.userMessage ?? message;
    if (options.retryAfter) this.retryAfter = options.retryAfter;
  }
}

export const emptyMeta = (url: string, now: number): FetchMeta => ({
  url,
  status: 200,
  fetchedAt: now,
  durationMs: 0,
  pages: 1,
  truncated: false,
  warnings: [],
});
