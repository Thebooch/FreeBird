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
  interpolatePath,
  missingInputs,
  pathParamNames,
} from "@freebirdai/dash-spec";
import { INCOMPLETE } from "./incomplete.js";
import { locateInputs, renderBody, setQueryValue } from "./request.js";
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
    /** GET when absent. A read sends POST only for an API that reads with a body. */
    method?: string;
    body?: string;
    /**
     * Whether this request reads or changes. Absent means a GET reads and
     * anything else changes — which a read sent with POST is not, so it says so.
     */
    purpose?: "read" | "write";
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
  /* A connector's credentials are sent by its code, through the server — never from here. */
  const secret =
    auth.type === "none" || auth.type === "headers" || auth.type === "oauth2" || auth.type === "connector"
      ? null
      : (secrets.get(auth.keyRef) ?? null);

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

  /*
   * OAuth sends the token the broker obtained, not anything pasted. None yet
   * means nobody has signed in (or the sign-in was withdrawn): said as that,
   * never as a wrong key.
   */
  if (auth.type === "oauth2") {
    const token = (await resolveSecret?.(auth.keyRef)) ?? null;
    if (!token) {
      throw new AdapterError("sign-in needed", {
        status: 401,
        userMessage: `${connection.title} needs signing in before it can load anything.`,
      });
    }
    secrets.set(auth.keyRef, token);
    headers.authorization = `Bearer ${token}`;
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

/** How many times one read may renew its credential before the refusal stands. */
const MAX_RENEWALS = 3;

/**
 * How many records the API says match, when it says: the endpoint's declared
 * `totalPath`, else an `X-Total-Count` header. What a complete read is later
 * checked against.
 */
const statedTotal = (op: OpSpec, body: unknown, response: HttpResponse): number | undefined => {
  const raw = op.totalPath ? readPath(body, op.totalPath) : response.header("x-total-count");
  const total = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isInteger(total) && total >= 0 ? total : undefined;
};

/**
 * What an API said about a refused read, for diagnosing it.
 *
 * Shorter than a write's detail and stripped of markup: an error page is
 * HTML more often than not, and what matters is the sentence in it — the
 * header it wanted, the parameter it could not read.
 */
const readDetail = (text: string, secrets: readonly string[]): string | undefined => {
  const plain = errorDetail(text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "), secrets);
  if (!plain) return undefined;
  return plain.length > 300 ? `${plain.slice(0, 299)}…` : plain;
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
    if (connection.paginationPending && op.pagination.kind === "none" && !op.paginationChecked)
      warnings.push(INCOMPLETE.unconfirmed);
    const host = allowedHost(connection);

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(op.headers)) {
      headers[name] = interpolate(value, ctx.params);
    }

    let prepared = await prepareAuth(connection, auth, ctx.resolveSecret);
    const redactQueryParam = prepared.redact;

    /*
     * Each supplied value goes where the endpoint declares it: the query
     * string, a header, a cookie, or the body. Paging parameters go wherever
     * the paging rule says — the query string, or into the body.
     */
    const pagingInBody = "in" in op.pagination && op.pagination.in === "body";
    const located = locateInputs(op, overrides);
    const byName = new Map(op.params.map((param) => [param.name, param]));
    const query = new URLSearchParams(pagingInBody ? {} : firstPageParams(op.pagination));
    for (const [name, value] of Object.entries(op.query)) {
      setQueryValue(query, name, interpolate(String(value), ctx.params), byName.get(name));
    }
    for (const [name, value] of Object.entries(located.query)) {
      const resolved = typeof value === "string" ? interpolate(value, ctx.params) : String(value);
      // An empty override means "no filter", not "filter by empty string".
      if (resolved === "") query.delete(name);
      else setQueryValue(query, name, resolved, byName.get(name));
    }
    for (const [name, value] of Object.entries(located.header)) {
      const resolved = interpolate(value, ctx.params);
      if (resolved !== "") headers[name] = resolved;
    }
    const cookies = Object.entries(located.cookie)
      .map(([name, value]) => [name, interpolate(value, ctx.params)] as const)
      .filter(([, value]) => value !== "")
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
    if (cookies.length > 0) headers.cookie = cookies.join("; ");

    if (!pagingInBody)
      for (const [name, value] of Object.entries(firstPageParams(op.pagination))) {
        if (query.get(name) !== value)
          throw new AdapterError(
            `Pagination input ${name} conflicts with this endpoint's pagination settings. Update the endpoint settings before loading it.`,
            { status: 400 },
          );
      }

    Object.assign(headers, prepared.headers);
    for (const [name, value] of prepared.query) query.set(name, value);

    /* The body's tokens read the supplied values, with body parameters' defaults beside them. */
    const bodyParams = { ...ctx.params, filters: { ...ctx.params.filters, ...located.body } };

    /*
     * What this endpoint needs before it can be called, asked of the spec
     * rather than re-derived here. `missingInputs` checks the declared
     * parameters *and* the path template — see its comment for why the path
     * case is the dangerous one.
     */
    const supplied = {
      ...Object.fromEntries(query),
      ...located.header,
      ...located.cookie,
      ...located.body,
      ...ctx.params.filters,
    };
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

    const path = interpolatePath(op.path, ctx.params);
    const base = connection.baseUrl.replace(/\/+$/, "");
    const first = `${base}${path.startsWith("/") ? path : `/${path}`}`;

    const pages: unknown[] = [];
    const seen = new Set<string>();
    /* The next request: its address, and the paging values its body carries. */
    let next: { url: string; paging: Record<string, string> } | null = {
      url: withQuery(first, query),
      paging: pagingInBody ? firstPageParams(op.pagination) : {},
    };
    let pageIndex = 0;
    let truncated = false;
    let lastUrl = next.url;
    let lastStatus = 0;
    let etag: string | null = null;
    let lastModified: string | null = null;
    let reportedTotal: number | undefined;
    let renewals = 0;
    const reads = op.method === "POST" && op.body !== undefined;

    while (next && pageIndex < op.maxPages) {
      const sent = reads ? renderBody(op.body!, bodyParams, next.paging) : undefined;
      /* A page is the same page when its address and its body are the same. */
      const identity = `${next.url}\n${sent?.text ?? ""}`;
      if (seen.has(identity)) {
        truncated = true;
        warnings.push(INCOMPLETE.repeatedPage);
        break;
      }
      seen.add(identity);

      /*
       * Conditional headers ride on the first request only, and only when the
       * caller supplied validators. A cached copy that spanned several pages
       * never supplies them: a 304 on page one says that page is unchanged,
       * which is not the same as the whole set being unchanged, and treating
       * it that way would quietly serve a stale collection.
       */
      const conditional =
        pageIndex === 0 && ctx.validators && !reads
          ? {
              ...(ctx.validators.etag ? { "if-none-match": ctx.validators.etag } : {}),
              ...(ctx.validators.lastModified
                ? { "if-modified-since": ctx.validators.lastModified }
                : {}),
            }
          : {};

      const response = await this.http(
        next.url,
        {
          headers: { ...headers, ...conditional, ...(sent ? { "content-type": sent.contentType } : {}) },
          ...(sent ? { method: "POST", body: sent.text, purpose: "read" as const } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
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
      /*
       * Refused for its token part-way through: renew it and read this same
       * page again. Bounded, and only when the caller can renew at all.
       */
      if (response.status === 401 && ctx.renew && renewals < MAX_RENEWALS) {
        renewals++;
        if (await ctx.renew()) {
          prepared = await prepareAuth(connection, auth, ctx.resolveSecret);
          Object.assign(headers, prepared.headers);
          seen.delete(identity);
          continue;
        }
      }

      lastUrl = response.url;
      lastStatus = response.status;
      if (pageIndex === 0) {
        etag = response.header("etag");
        lastModified = response.header("last-modified");
      }

      // What the API said, kept for whoever diagnoses a failure: tags out, secrets out, short.
      refusal(connection, host, response, readDetail(response.text, prepared.secrets));

      const body = parseJson(response.text, response.url);
      if (pageIndex === 0) reportedTotal = statedTotal(op, body, response);
      pages.push(body);
      pageIndex++;
      if (op.pagination.kind !== "none" && rowsAt(body, op.rowsPath) === null) {
        truncated = true;
        warnings.push(INCOMPLETE.rowsMissing);
        break;
      }

      const decided = nextPageParams({ pagination: op.pagination, body, rowsPath: op.rowsPath, pageIndex });
      if (decided.kind === "none") next = null;
      else if (decided.kind === "link-header") {
        const url = nextFromLinkHeader(response.header("link"));
        next = url ? { url, paging: next.paging } : null;
      } else if (pagingInBody) next = { url: next.url, paging: { ...next.paging, ...decided.params } };
      else {
        const params = new URLSearchParams(query);
        for (const [name, value] of Object.entries(decided.params)) params.set(name, value);
        next = { url: withQuery(first, params), paging: next.paging };
      }

      if (next && pageIndex >= op.maxPages) {
        // Say so loudly: a silently truncated result is a chart that is
        // quietly incomplete, which is worse than an error.
        truncated = true;
        warnings.push(INCOMPLETE.pageCap(op.maxPages));
      }
    }

    const beforeMerge = warnings.length;
    const merged = pages.length === 1 ? pages[0] : mergePages(pages, op.rowsPath, warnings);
    // A merge that fell back to the first page left the rest out.
    if (warnings.length > beforeMerge) truncated = true;

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
        ...(reportedTotal !== undefined ? { reportedTotal } : {}),
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
    /*
     * A connector signs reads. A change through one would need the same code
     * to sign it, under a write's review — not built yet, so refused plainly
     * rather than sent unsigned.
     */
    if (auth.type === "connector")
      throw new AdapterError("changes through a connector are not supported yet", {
        status: 501,
        userMessage: `${connection.title} signs in through connector code, which can read but cannot make changes yet. Nothing was sent.`,
        outcome: "not-sent",
      });
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
    // Encoded, as a read's path is (`interpolatePath`): a value with a slash in it must not become two segments.
    const path = op.path.replace(/\{\{\s*param\.([A-Za-z0-9_]+)[^}]*\}\}/g, (_token, name: string) =>
      encodeURIComponent(request.params[name] ?? ""),
    );
    const base = connection.baseUrl.replace(/\/+$/, "");
    const query = new URLSearchParams();
    /* The same `{{param.x}}` tokens a read's query carries, filled from this change's values. */
    for (const [name, value] of Object.entries(op.query)) {
      const filled = String(value).replace(
        /\{\{\s*param\.([A-Za-z0-9_]+)[^}]*\}\}/g,
        (_token, param: string) => request.params[param] ?? "",
      );
      if (filled !== "") query.set(name, filled);
    }
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
          purpose: "write",
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

