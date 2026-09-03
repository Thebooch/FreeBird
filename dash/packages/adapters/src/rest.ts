import {
  mergePages,
  nextPageParams,
  readPath,
  rowsAt,
  truthy,
  withRows,
} from "./paginate.js";
import type { ConnectionSpec, OpSpec, PaginationSpec } from "@freebirdai/dash-spec";
import { allowedHost, authKeyRefs, interpolate, missingInputs } from "@freebirdai/dash-spec";
import {
  AdapterError,
  type FetchContext,
  type FetchResult,
  type SourceAdapter,
} from "./types.js";

export interface HttpResponse {
  readonly status: number;
  readonly text: string;
  readonly url: string;
  header(name: string): string | null;
}

/**
 * The transport. Injected rather than imported so this package stays free of
 * Node built-ins — the server supplies an implementation wrapped in the SSRF
 * guard and the per-connection host allowlist, and tests supply a fake.
 */
export type HttpFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
  allowedHost: string | null,
) => Promise<HttpResponse>;

const base64 = (input: string): string => {
  if (typeof btoa === "function") return btoa(input);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (globalThis as any).Buffer;
  if (B) return B.from(input, "utf8").toString("base64");
  throw new AdapterError("no base64 implementation available");
};

const parseJson = (text: string, url: string): unknown => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AdapterError(`response from ${url} was not JSON`, {
      status: 502,
      userMessage:
        "That endpoint returned something other than JSON. It may be an error page, or the wrong URL.",
    });
  }
};

/** `Link: <https://…?page=2>; rel="next"` */
const nextFromLinkHeader = (header: string | null): string | null => {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part);
    if (match) return match[1] ?? null;
  }
  return null;
};

export class RestAdapter implements SourceAdapter {
  readonly kind = "rest" as const;
  /** Real APIs send no CORS headers, and a key in browser JS is a key on the wire. */
  readonly transport = "proxy" as const;

  constructor(private readonly http: HttpFetch) {}

  async fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    if (!connection.baseUrl) {
      throw new AdapterError(`connection "${connection.id}" has no base URL`, { status: 400 });
    }

    const started = ctx.now;
    const warnings: string[] = [];
    const host = allowedHost(connection);

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(op.headers)) {
      headers[name] = interpolate(value, ctx.params);
    }

    // Resolve secrets as late as possible and keep them out of everything
    // that gets reported back.
    let redactQueryParam: string | null = null;
    const secrets = new Map<string, string>();
    for (const keyRef of authKeyRefs(connection.auth)) {
      const value = (await ctx.resolveSecret?.(keyRef)) ?? null;
      if (!value) {
        throw new AdapterError(`no key stored for "${keyRef}"`, {
          status: 401,
          userMessage: `${connection.title} needs an API key before it can load anything.`,
        });
      }
      secrets.set(keyRef, value);
    }
    // The single-secret styles all read the same slot.
    const secret = connection.auth.type === "none" ? null : (secrets.get(authKeyRefs(connection.auth)[0]!) ?? null);

    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(op.query)) {
      query.set(name, interpolate(String(value), ctx.params));
    }
    for (const [name, value] of Object.entries(overrides)) {
      const resolved = typeof value === "string" ? interpolate(value, ctx.params) : String(value);
      // An empty override means "no filter", not "filter by empty string".
      if (resolved === "") query.delete(name);
      else query.set(name, resolved);
    }

    if (secret) {
      switch (connection.auth.type) {
        case "bearer":
          headers.authorization = `Bearer ${secret}`;
          break;
        case "header":
          headers[connection.auth.header.toLowerCase()] = connection.auth.template
            ? connection.auth.template.replace("{{key}}", secret)
            : secret;
          break;
        case "query":
          query.set(connection.auth.param, secret);
          redactQueryParam = connection.auth.param;
          break;
        case "basic":
          headers.authorization = `Basic ${base64(`${connection.auth.username}:${secret}`)}`;
          break;
      }
    }

    // Multi-header auth is its own loop: each part carries its own secret, so
    // there is no single `secret` for the switch above to use.
    if (connection.auth.type === "headers") {
      for (const part of connection.auth.parts) {
        const value = secrets.get(part.keyRef)!;
        headers[part.header.toLowerCase()] = part.template
          ? part.template.replace("{{key}}", value)
          : value;
      }
    }

    /*
     * What this endpoint needs before it can be called, asked of the spec
     * rather than re-derived here. `missingInputs` checks the declared
     * parameters *and* the path template — see its comment for why the path
     * case is the dangerous one.
     */
    const unresolved = missingInputs(op, ctx.params.filters);

    if (unresolved.length > 0) {
      throw new AdapterError(`unresolved path parameters: ${unresolved.join(", ")}`, {
        status: 400,
        userMessage: `"${op.title}" needs a value for ${unresolved
          .map((name) => `"${name}"`)
          .join(" and ")} before it can be called. Pick an endpoint that takes no parameters, or supply one.`,
      });
    }

    const path = interpolate(op.path, ctx.params);
    const base = connection.baseUrl.replace(/\/+$/, "");
    const first = `${base}${path.startsWith("/") ? path : `/${path}`}`;

    const pages: unknown[] = [];
    const seen = new Set<string>();
    let nextUrl: string | null = withQuery(first, query);
    let pageIndex = 0;
    let truncated = false;
    let lastUrl = nextUrl;
    let lastStatus = 0;
    let etag: string | null = null;
    let lastModified: string | null = null;

    while (nextUrl && pageIndex < op.maxPages) {
      if (seen.has(nextUrl)) {
        warnings.push("pagination repeated a page and was stopped");
        break;
      }
      seen.add(nextUrl);

      /*
       * Conditional headers ride on the first request only, and only when the
       * caller supplied validators. A cached copy that spanned several pages
       * never supplies them: a 304 on page one says that page is unchanged,
       * which is not the same as the whole set being unchanged, and treating
       * it that way would quietly serve a stale collection.
       */
      const conditional =
        pageIndex === 0 && ctx.validators
          ? {
              ...(ctx.validators.etag ? { "if-none-match": ctx.validators.etag } : {}),
              ...(ctx.validators.lastModified
                ? { "if-modified-since": ctx.validators.lastModified }
                : {}),
            }
          : {};

      const response = await this.http(
        nextUrl,
        { headers: { ...headers, ...conditional }, ...(ctx.signal ? { signal: ctx.signal } : {}) },
        host,
      );

      if (response.status === 304) {
        return {
          body: null,
          notModified: true,
          meta: {
            url: response.url,
            status: 304,
            fetchedAt: ctx.now,
            durationMs: Date.now() - started,
            pages: 0,
            truncated: false,
            warnings: [],
          },
        };
      }
      lastUrl = response.url;
      lastStatus = response.status;
      if (pageIndex === 0) {
        etag = response.header("etag");
        lastModified = response.header("last-modified");
      }

      if (response.status === 429) {
        const retryAfter = response.header("retry-after");
        throw new AdapterError(`rate limited by ${host}`, {
          status: 429,
          userMessage: `${connection.title} is rate limiting us${
            retryAfter ? ` — try again in ${retryAfter}s` : ""
          }.`,
          ...(retryAfter ? { retryAfter } : {}),
        });
      }
      /*
       * 401 and 403 are opposite answers, and saying the same thing about both
       * is how a working key gets reported as a broken one.
       *
       * A 401 means the credential was not accepted. A 403 means it *was* —
       * you cannot be forbidden without first being identified — and this
       * particular resource is off limits. Plenty of APIs scope a key per
       * module, so one endpoint refusing says nothing about the next.
       *
       * Telling somebody their key is wrong when it is provably right sends
       * them off to reissue credentials that were never the problem.
       */
      if (response.status === 401) {
        throw new AdapterError("auth rejected (401)", {
          status: 401,
          userMessage: `${connection.title} rejected the key. It may be wrong, expired, or revoked.`,
        });
      }
      if (response.status === 403) {
        throw new AdapterError("auth forbidden (403)", {
          status: 403,
          userMessage: `${connection.title} accepted the key but will not allow access to this endpoint. It is likely missing a scope, or belongs to a module this account does not have.`,
        });
      }
      if (response.status >= 400) {
        throw new AdapterError(`request failed (${response.status})`, {
          status: 502,
          userMessage: `${connection.title} returned an error (${response.status}).`,
        });
      }

      const body = parseJson(response.text, response.url);
      pages.push(body);
      pageIndex++;

      nextUrl = nextPageUrl({
        pagination: op.pagination,
        body,
        response,
        rowsPath: op.rowsPath,
        base: first,
        query,
        pageIndex,
      });

      if (nextUrl && pageIndex >= op.maxPages) {
        // Say so loudly: a silently truncated result is a chart that is
        // quietly incomplete, which is worse than an error.
        truncated = true;
        warnings.push(
          `stopped after ${op.maxPages} page(s); there is more data behind this endpoint`,
        );
      }
    }

    const merged =
      pages.length === 1
        ? pages[0]
        : mergePages(pages, op.rowsPath, warnings);

    /*
     * Offered back only for a single-page result. Quoting a page-one validator
     * against a set we assembled from several pages would let a 304 stand in
     * for "the whole collection is unchanged", which it does not mean.
     */
    const validators =
      pageIndex === 1 && (etag || lastModified)
        ? {
            ...(etag ? { etag } : {}),
            ...(lastModified ? { lastModified } : {}),
          }
        : undefined;

    return {
      body: merged,
      ...(validators ? { validators } : {}),
      meta: {
        url: redact(lastUrl, redactQueryParam),
        status: lastStatus,
        fetchedAt: started,
        durationMs: Date.now() - started,
        pages: pageIndex,
        truncated,
        warnings,
      },
    };
  }
}

const withQuery = (url: string, query: URLSearchParams): string => {
  const text = query.toString();
  if (text === "") return url;
  return `${url}${url.includes("?") ? "&" : "?"}${text}`;
};

const redact = (url: string, param: string | null): string => {
  if (!param) return url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has(param)) parsed.searchParams.set(param, "***");
    return parsed.toString();
  } catch {
    return url;
  }
};

const nextPageUrl = (input: {
  pagination: PaginationSpec;
  body: unknown;
  response: HttpResponse;
  rowsPath: string | undefined;
  base: string;
  query: URLSearchParams;
  pageIndex: number;
}): string | null => {
  const { pagination, body, response, rowsPath, base, query, pageIndex } = input;

  // The decision is shared with MCP; only turning it into a URL is not.
  const next = nextPageParams({ pagination, body, rowsPath, pageIndex });
  if (next.kind === "none") return null;
  if (next.kind === "link-header") return nextFromLinkHeader(response.header("link"));

  const params = new URLSearchParams(query);
  for (const [name, value] of Object.entries(next.params)) params.set(name, value);
  return withQuery(base, params);
};
