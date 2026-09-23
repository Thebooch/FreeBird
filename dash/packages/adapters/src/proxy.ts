import type { ConnectionSpec, OpSpec } from "@freebirdai/dash-spec";
import {
  AdapterError,
  type FetchContext,
  type FetchResult,
  type SourceAdapter,
} from "./types.js";

/**
 * The browser half of a server-backed connection.
 *
 * Everything real happens on the server: the key never leaves it, the SSRF
 * guard and the per-connection host allowlist run there, and CORS is a
 * non-issue because the browser only ever talks to its own origin.
 */
export class ProxyAdapter implements SourceAdapter {
  readonly transport = "proxy" as const;

  constructor(
    readonly kind: ConnectionSpec["kind"] = "rest",
    private readonly endpoint = "/api/query",
  ) {}

  async fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        body: JSON.stringify({
          connection: connection.id,
          op: op.id,
          params: overrides,
          range: {
            preset: ctx.params.range.preset,
            grain: ctx.params.range.grain,
            start: ctx.params.range.start,
            end: ctx.params.range.end,
          },
          filters: ctx.params.filters,
          /*
           * How old an answer this widget will take. Comes from its own
           * `refresh.staleAfter`, so two widgets on one endpoint each get what
           * they asked for rather than one imposing its opinion on the other.
           * Zero is what Refresh sends: revalidate and wait.
           */
          ...(ctx.maxAgeMs !== undefined ? { maxAgeMs: ctx.maxAgeMs } : {}),
          /*
           * Whether this is a read or a request. A board being looked at sends
           * `view`, which the server answers from its cache without calling
           * anybody's API; Refresh sends `refresh`.
           */
          ...(ctx.mode ? { mode: ctx.mode } : {}),
        }),
      });
    } catch {
      throw new AdapterError("could not reach the Dash server", {
        status: 503,
        userMessage: "The Dash server isn't responding. Is it running?",
      });
    }

    const payload = (await response.json().catch(() => null)) as
      | {
          body?: unknown;
          meta?: FetchResult["meta"];
          error?: string;
          userMessage?: string;
          /** The *upstream's* status, where the server flattened its own. */
          status?: number;
          retryAfter?: string;
          detail?: unknown;
        }
      | null;

    if (!response.ok) {
      /*
       * Two fields, two jobs, and they are not interchangeable.
       *
       * `error` is the technical one — "rate limited by api.example.com",
       * "cooling down for buildium" — and belongs on the Error for a
       * developer. `userMessage` is the sentence the server wrote for a
       * person, and on a 429 it is the only place the wait is stated. Reading
       * `error` into both, as this did, meant `describeFailure`'s careful
       * 401/403/429 copy was always overridden by the technical string and the
       * countdown never reached anybody. Older routes send only `error`, so it
       * stays the fallback.
       */
      throw new AdapterError(
        typeof payload?.detail === "string" ? payload.detail : (payload?.error ?? `HTTP ${response.status}`),
        {
          /*
           * The upstream's status when the server sent one, not ours.
           *
           * `/api/query` answers 502 for everything except a rate limit, so
           * reading `response.status` alone turned every 401 and 403 into an
           * anonymous failure — and `describeFailure`'s copy for those, which
           * says a 403 proves the key works and offers no pointless retry,
           * could never be reached.
           */
          status: typeof payload?.status === "number" ? payload.status : response.status,
          userMessage:
            payload?.userMessage ?? payload?.error ?? "That request could not be completed.",
          ...(payload?.retryAfter
            ? { retryAfter: payload.retryAfter }
            : (() => {
                // The header is the standard spelling; the body field is ours.
                const header = response.headers.get("retry-after");
                return header ? { retryAfter: header } : {};
              })()),
        },
      );
    }

    return {
      body: payload?.body,
      meta: payload?.meta ?? {
        url: `${this.endpoint}#${connection.id}.${op.id}`,
        status: response.status,
        fetchedAt: ctx.now,
        durationMs: 0,
        pages: 1,
        truncated: false,
        warnings: [],
      },
    };
  }
}
