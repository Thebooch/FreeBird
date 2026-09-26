import {
  mergePages,
  firstPageParams,
  nextPageParams,
  readPath,
  rowsAt,
  truthy,
  withRows,
} from "./paginate.js";
import type { AuthSpec, ConnectionSpec, OpSpec, PaginationSpec } from "@freebirdai/dash-spec";
import {
  allowedHost,
  authKeyRefs,
  connectionNeedsAddress,
  interpolate,
  missingInputs,
  pathParamNames,
} from "@freebirdai/dash-spec";
import {
  AdapterError,
  type FetchContext,
  type FetchResult,
  type SourceAdapter,
  type WriteContext,
  type WriteRequest,
  type WriteResult,
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
  init: {
    headers: Record<string, string>;
    signal?: AbortSignal;
    /** Absent for every read, which is a GET. Set only by `write`. */
    method?: string;
    body?: string;
  },
  allowedHost: string | null,
) => Promise<HttpResponse>;

/**
 * The credential, applied: headers to send, query values to add, and the
 * query parameter to mask wherever the URL is reported.
 *
 * One function for reads and writes, so a write cannot get a credential
 * slightly wrong in a way reads have already been fixed not to.
 */
interface PreparedAuth {
  readonly headers: Record<string, string>;
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly redact: string | null;
  /** Every secret resolved, so an error body quoting one can be cleaned. */
  readonly secrets: readonly string[];
}

const prepareAuth = async (
  connection: ConnectionSpec,
  auth: AuthSpec,
  resolveSecret: ((keyRef: string) => Promise<string | null>) | undefined,
): Promise<PreparedAuth> => {
  // Resolve secrets as late as possible and keep them out of everything
  // that gets reported back.
  const secrets = new Map<string, string>();
  for (const keyRef of authKeyRefs(auth)) {
    const value = (await resolveSecret?.(keyRef)) ?? null;
    if (!value) {
      throw new AdapterError(`no key stored for "${keyRef}"`, {
        status: 401,
        userMessage: `${connection.title} needs an API key before it can load anything.`,
      });
    }
    secrets.set(keyRef, value);
  }
  // The single-secret styles read their own slot by name, never "the first
  // one": a Basic username is a secret too, and it comes first.
  const secret =
    auth.type === "none" || auth.type === "headers" ? null : (secrets.get(auth.keyRef) ?? null);

  const headers: Record<string, string> = {};
  const query: Array<readonly [string, string]> = [];
  let redact: string | null = null;
  if (secret) {
    switch (auth.type) {
      case "bearer":
        headers.authorization = `Bearer ${secret}`;
        break;
      case "header":
        headers[auth.header.toLowerCase()] = auth.template
          ? auth.template.replace("{{key}}", secret)
          : secret;
        break;
      case "query":
        query.push([auth.param, secret]);
        redact = auth.param;
        break;
      case "basic": {
        const username = auth.usernameRef
          ? (secrets.get(auth.usernameRef) ?? "")
          : (auth.username ?? "");
        headers.authorization = `Basic ${base64(`${username}:${secret}`)}`;
        break;
      }
    }
  }

  // Multi-header auth is its own loop: each part carries its own secret, so
  // there is no single `secret` for the switch above to use.
  if (auth.type === "headers") {
    for (const part of auth.parts) {
      const value = secrets.get(part.keyRef)!;
      headers[part.header.toLowerCase()] = part.template
        ? part.template.replace("{{key}}", value)
        : value;
    }
  }
  return { headers, query, redact, secrets: [...secrets.values()] };
};

/** An endpoint whose own authentication is still unconfigured cannot be called. */
const assertAuthConfigured = (
  connection: ConnectionSpec,
  op: { readonly auth?: AuthSpec | undefined; readonly authRequired?: boolean | undefined },
  auth: AuthSpec,
): void => {
  if (
    op.authRequired ||
    (op.auth === undefined && connection.authRequired && auth.type === "none")
  ) {
    throw new AdapterError(
      "This endpoint needs its authentication configured before it can be read.",
      { status: 400 },
    );
  }
};

/** What the API said about a refused change: short, one line, no secret in it. */
const errorDetail = (text: string, secrets: readonly string[]): string | undefined => {
  let clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") return undefined;
  for (const secret of secrets) {
    if (secret.length >= 4) clean = clean.split(secret).join("***");
  }
  return clean.length > 2000 ? `${clean.slice(0, 1999)}…` : clean;
};

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
    /*
     * An address nobody has confirmed is a guess — the host the docs were
     * served from, or a template filled with its documented placeholder.
     * Sending a key there is sending it to somebody else.
     */
    if (connectionNeedsAddress(connection)) {
      throw new AdapterError(`connection "${connection.id}" has no confirmed address`, {
        status: 400,
        userMessage: `${connection.title} needs its address before it can load anything — say which account it is under Connections.`,
      });
    }

    const auth = op.auth ?? connection.auth;
    assertAuthConfigured(connection, op, auth);
    const started = ctx.now;
    const warnings: string[] = [];
    if (connection.paginationPending && op.pagination.kind === "none")
      warnings.push(
        "Pagination has not been confirmed for this API; this response may contain only the first page.",
      );
    const host = allowedHost(connection);

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(op.headers)) {
      headers[name] = interpolate(value, ctx.params);
    }

    const prepared = await prepareAuth(connection, auth, ctx.resolveSecret);
    const redactQueryParam = prepared.redact;

    const query = new URLSearchParams(firstPageParams(op.pagination));
    for (const [name, value] of Object.entries(op.query)) {
      query.set(name, interpolate(String(value), ctx.params));
    }
    for (const [name, value] of Object.entries(overrides)) {
      const resolved = typeof value === "string" ? interpolate(value, ctx.params) : String(value);
      // An empty override means "no filter", not "filter by empty string".
      if (resolved === "") query.delete(name);
      else query.set(name, resolved);
    }

    for (const [name, value] of Object.entries(firstPageParams(op.pagination))) {
      if (query.get(name) !== value)
        throw new AdapterError(
          `Pagination input ${name} conflicts with this endpoint's pagination settings. Update the endpoint settings before loading it.`,
          { status: 400 },
        );
    }

    Object.assign(headers, prepared.headers);
    for (const [name, value] of prepared.query) query.set(name, value);

    /*
     * What this endpoint needs before it can be called, asked of the spec
     * rather than re-derived here. `missingInputs` checks the declared
     * parameters *and* the path template — see its comment for why the path
     * case is the dangerous one.
     */
    const supplied = { ...Object.fromEntries(query), ...ctx.params.filters };
    // Query values are validated where they are sent; path values come only
    // from path inputs, so a query parameter cannot satisfy a missing path id.
    for (const param of op.params) {
      if (param.in === "query") supplied[param.name] = query.get(param.name) ?? "";
    }
    const unresolved = missingInputs(op, supplied);
    for (const name of pathParamNames(op.path)) {
      if (
        (ctx.params.filters[name] === undefined || ctx.params.filters[name] === "") &&
        !unresolved.includes(name)
      )
        unresolved.push(name);
    }

    if (unresolved.length > 0) {
      throw new AdapterError(`unresolved path parameters: ${unresolved.join(", ")}`, {
        status: 400,
        userMessage: `"${op.title}" needs a value for ${unresolved
          .map((name) => `"${name}"`)
          .join(
            " and ",
          )} before it can be called. Pick an endpoint that takes no parameters, or supply one.`,
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
        truncated = true;
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

      refusal(connection, host, response);

      const body = parseJson(response.text, response.url);
      pages.push(body);
      pageIndex++;
      if (op.pagination.kind !== "none" && rowsAt(body, op.rowsPath) === null) {
        truncated = true;
        warnings.push(
          "The declared row list was not found; pagination completeness could not be checked.",
        );
        break;
      }

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

    const merged = pages.length === 1 ? pages[0] : mergePages(pages, op.rowsPath, warnings);

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

  /**
   * Send one change, once.
   *
   * Nothing here retries, and nothing here follows a redirect: a change sent
   * twice is two changes. A failure is reported with what is known about it
   * — the API refused it (with its reason), it was never sent, or it was sent
   * and the answer was lost — because those three need different things
   * from the person who asked for it.
   */
  async write(
    connection: ConnectionSpec,
    request: WriteRequest,
    ctx: WriteContext,
  ): Promise<WriteResult> {
    const { op } = request;
    if (!connection.baseUrl) {
      throw new AdapterError(`connection "${connection.id}" has no base URL`, {
        status: 400,
        outcome: "not-sent",
      });
    }
    if (connectionNeedsAddress(connection)) {
      throw new AdapterError(`connection "${connection.id}" has no confirmed address`, {
        status: 400,
        userMessage: `${connection.title} needs its address before anything can be changed.`,
        outcome: "not-sent",
      });
    }
    const auth = op.auth ?? connection.auth;
    assertAuthConfigured(connection, op, auth);
    const prepared = await prepareAuth(connection, auth, ctx.resolveSecret);
    const host = allowedHost(connection);

    const missing = pathParamNames(op.path).filter((name) => !request.params[name]);
    if (missing.length > 0) {
      throw new AdapterError(`unresolved path parameters: ${missing.join(", ")}`, {
        status: 400,
        userMessage: `"${op.title}" needs a value for ${missing.map((name) => `"${name}"`).join(" and ")}.`,
        outcome: "not-sent",
      });
    }
    // Encoded, unlike a read's path: a value with a slash in it must not become two segments.
    const path = op.path.replace(/\{\{\s*param\.([A-Za-z0-9_]+)[^}]*\}\}/g, (_token, name: string) =>
      encodeURIComponent(request.params[name] ?? ""),
    );
    const base = connection.baseUrl.replace(/\/+$/, "");
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(op.query)) query.set(name, String(value));
    for (const [name, value] of prepared.query) query.set(name, value);
    const url = withQuery(`${base}${path.startsWith("/") ? path : `/${path}`}`, query);

    const headers: Record<string, string> = { ...op.headers, ...prepared.headers };
    const sending = request.body !== undefined && op.method !== "DELETE";
    if (sending) headers["content-type"] = request.contentType ?? "application/json";

    const started = Date.now();
    let response: HttpResponse;
    try {
      response = await this.http(
        url,
        {
          headers,
          method: op.method,
          ...(sending ? { body: JSON.stringify(request.body) } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        host,
      );
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      const known = (error as { notSent?: unknown } | null)?.notSent === true;
      throw new AdapterError(`change not confirmed: ${(error as Error)?.message ?? error}`, {
        status: known ? 502 : 504,
        userMessage: known
          ? `${connection.title} could not be reached, so nothing was sent.`
          : `The request to ${connection.title} was sent but no answer came back. The change may or may not have been made — check before trying again.`,
        outcome: known ? "not-sent" : "unknown",
      });
    }

    if (response.status >= 300 && response.status < 400) {
      throw new AdapterError(`change answered with a redirect (${response.status})`, {
        status: 502,
        upstreamStatus: response.status,
        userMessage: `${connection.title} answered with a redirect (${response.status}). Nothing was sent again — check whether the change was made.`,
        outcome: "unknown",
      });
    }
    refusal(connection, host, response, errorDetail(response.text, prepared.secrets));

    let body: unknown = null;
    try {
      body = parseJson(response.text, response.url);
    } catch {
      // Accepted, with an answer that is not JSON. The change happened; the answer is just unreadable.
      body = null;
    }
    return {
      status: response.status,
      body,
      location: response.header("location"),
      url: redact(response.url, prepared.redact),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * The API said no. Refusals are told apart, because each needs something
 * different: wait (429), a key (401), permission (403), or the reason the
 * API gave (everything else, where `detail` carries it for a change).
 */
const refusal = (
  connection: ConnectionSpec,
  host: string | null,
  response: HttpResponse,
  detail?: string,
): void => {
  if (response.status === 429) {
    const retryAfter = response.header("retry-after");
    throw new AdapterError(`rate limited by ${host}`, {
      status: 429,
      upstreamStatus: 429,
      userMessage: `${connection.title} is rate limiting us${
        retryAfter ? ` — try again in ${retryAfter}s` : ""
      }.`,
      ...(retryAfter ? { retryAfter } : {}),
    });
  }
  /*
   * Keep authentication rejection distinct from denied access. Providers
   * use 403 for several reasons; it cannot prove the key was accepted.
   */
  if (response.status === 401) {
    throw new AdapterError("auth rejected (401)", {
      status: 401,
      upstreamStatus: 401,
      userMessage: `${connection.title} rejected the key. It may be wrong, expired, or revoked.`,
    });
  }
  if (response.status === 403) {
    throw new AdapterError("auth forbidden (403)", {
      status: 403,
      upstreamStatus: 403,
      userMessage: `${connection.title} denied access to this endpoint. Check the credential and its permissions; this response alone does not prove the key was accepted.`,
      ...(detail ? { detail } : {}),
    });
  }
  if (response.status >= 400) {
    throw new AdapterError(`request failed (${response.status})`, {
      status: 502,
      upstreamStatus: response.status,
      userMessage: `${connection.title} returned an error (${response.status}).`,
      ...(detail ? { detail } : {}),
    });
  }
};

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
