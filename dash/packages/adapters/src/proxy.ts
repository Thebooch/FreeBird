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
        }),
      });
    } catch {
      throw new AdapterError("could not reach the Dash server", {
        status: 503,
        userMessage: "The Dash server isn't responding. Is it running?",
      });
    }

    const payload = (await response.json().catch(() => null)) as
      | { body?: unknown; meta?: FetchResult["meta"]; error?: string; detail?: unknown }
      | null;

    if (!response.ok) {
      throw new AdapterError(
        typeof payload?.detail === "string" ? payload.detail : (payload?.error ?? `HTTP ${response.status}`),
        {
          status: response.status,
          // The server already phrased this for a person; pass it through
          // rather than replacing it with something more generic.
          userMessage: payload?.error ?? "That request could not be completed.",
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
