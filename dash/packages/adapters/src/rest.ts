import { digestAuthorization, parseDigestChallenge, type DigestChallenge } from "./digest.js";
import { awsScopeOf, signSigV4, type SigV4Credentials } from "./sigv4.js";
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
  hasTokens,
  interpolate,
  interpolatePath,
  missingInputs,
  pathParamNames,
} from "@freebirdai/dash-spec";
import { INCOMPLETE, isIncompleteNote as isIncomplete } from "./incomplete.js";
import { formatOf, parseBody } from "./parse/index.js";
import { locateInputs, renderBody, setQueryValue } from "./request.js";
import {
  AdapterError,
  parseRetryAfter,
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
    /** A client certificate to present (mutual TLS), PEM. Sent only over https, to the allowed host. */
    clientCertificate?: { readonly cert: string; readonly key: string; readonly ca?: string };
    /**
     * A stream that never ends: read until this many events have arrived, or
     * this many seconds have passed, and answer with the events read.
     */
    stream?: { readonly events: number; readonly seconds: number };
    /** The connection is on a private network the operator allowed. See the server's `EgressPolicy`. */
    privateNetwork?: boolean;
  },
  allowedHost: string | null,
) => Promise<HttpResponse>;

/**
 * PEM as the provider issued it, from however it was pasted: a one-line field
 * drops the line breaks PEM needs, so the body is wrapped at 64 again.
 */
export const normalizePem = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.includes("\n")) return `${trimmed}\n`;
  return trimmed.replace(
    /(-----BEGIN [A-Z0-9 ]+-----)\s*([A-Za-z0-9+/=\s]+?)\s*(-----END [A-Z0-9 ]+-----)/g,
    (_all, begin: string, body: string, end: string) =>
      `${begin}\n${(body.replace(/\s+/g, "").match(/.{1,64}/g) ?? []).join("\n")}\n${end}\n`,
  );
};

/** A connection's client certificate, from the vault, or an error saying which half is missing. */
const clientCertificateOf = async (
  connection: ConnectionSpec,
  resolveSecret: FetchContext["resolveSecret"],
): Promise<{ readonly cert: string; readonly key: string; readonly ca?: string } | undefined> => {
  const wanted = connection.clientCertificate;
  if (!wanted) return undefined;
  const cert = await resolveSecret?.(wanted.certRef);
  const key = await resolveSecret?.(wanted.keyRef);
  if (!cert || !key)
    throw new AdapterError("client certificate needed", {
      status: 401,
      userMessage: `${connection.title} needs its client certificate and key before it can load anything.`,
    });
  const ca = wanted.caRef ? await resolveSecret?.(wanted.caRef) : null;
  return { cert: normalizePem(cert), key: normalizePem(key), ...(ca ? { ca: normalizePem(ca) } : {}) };
};

/**
 * The credential, applied: headers to send, query values to add, and the
 * query parameter to mask wherever the URL is reported.
 *
 * One function for reads and writes, so a write cannot get a credential
 * slightly wrong in a way reads have already been fixed not to.
 */
export interface PreparedAuth {
  readonly headers: Record<string, string>;
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly redact: string | null;
  /** Every secret resolved, so an error body quoting one can be cleaned. */
  readonly secrets: readonly string[];
  /** HTTP Digest's two values, answered only once the server challenges. */
  readonly digest?: { readonly username: string; readonly password: string };
  /** AWS Signature V4: what signs each request, once its address and body are known. */
  readonly sigv4?: SigV4Credentials;
}

export const prepareAuth = async (
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
  let digest: { readonly username: string; readonly password: string } | undefined;
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
        /* Digest sends nothing until the server challenges; see the page loop. */
        if (auth.digest) digest = { username, password: secret };
        else headers.authorization = `Basic ${base64(`${username}:${secret}`)}`;
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
    const cookies: string[] = [];
    for (const part of auth.parts) {
      const raw = secrets.get(part.keyRef)!;
      const value = part.template ? part.template.replace("{{key}}", raw) : raw;
      if (part.in === "query") {
        query.push([part.header, value]);
        redact ??= part.header;
      } else if (part.in === "cookie") cookies.push(`${part.header}=${encodeURIComponent(value)}`);
      else headers[part.header.toLowerCase()] = value;
    }
    if (cookies.length > 0) headers.cookie = cookies.join("; ");
  }
  /* AWS signs each request as it is sent — its address, its body, the time — so nothing is set here. */
  let sigv4: SigV4Credentials | undefined;
  if (auth.type === "sigv4") {
    /* The scope: what the connection states, else what its address says (an account's own region). */
    const named = awsScopeOf(connection.baseUrl ?? "");
    const region = auth.region ?? named?.region;
    if (!region)
      throw new AdapterError("no AWS region for signing", {
        status: 400,
        userMessage: `${connection.title} signs requests for an AWS region, and neither its address nor its documentation names one.`,
      });
    if (auth.apiKey) headers[auth.apiKey.header.toLowerCase()] = secrets.get(auth.apiKey.keyRef)!;
    sigv4 = {
      accessKeyId: secrets.get(auth.accessKeyRef)!.trim(),
      secretAccessKey: secrets.get(auth.keyRef)!.trim(),
      ...(auth.sessionTokenRef ? { sessionToken: secrets.get(auth.sessionTokenRef)!.trim() } : {}),
      region,
      /* An API of its own behind AWS is served by API Gateway unless something says otherwise. */
      service: auth.service ?? named?.service ?? "execute-api",
    };
  }
  return {
    headers,
    query,
    redact,
    secrets: [...secrets.values()],
    ...(digest ? { digest } : {}),
    ...(sigv4 ? { sigv4 } : {}),
  };
};

/**
 * A request's headers with AWS's signature over them. Signed at the moment of
 * sending: the signature covers the time, and AWS refuses one minutes old.
 */
const signedForAws = async (
  credentials: SigV4Credentials | undefined,
  request: { readonly method: string; readonly url: string; readonly headers: Record<string, string>; readonly body?: string | undefined },
): Promise<Record<string, string>> =>
  credentials
    ? { ...request.headers, ...(await signSigV4({ ...request, credentials, now: Date.now() })) }
    : request.headers;

/** What a Digest answer signs: the request's path and query, as sent. */
const pathAndQuery = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
};

/** The sign-in's headers onto a request's: a key in a cookie joins the endpoint's own cookies. */
const addAuthHeaders = (headers: Record<string, string>, auth: Readonly<Record<string, string>>): void => {
  for (const [name, value] of Object.entries(auth))
    headers[name] = name === "cookie" && headers.cookie ? `${headers.cookie}; ${value}` : value;
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

/** Rate-limit waits per read, the longest wait taken, and the wait when the API names none. */
const MAX_RATE_WAITS = 3;
const MAX_RATE_WAIT_MS = 30_000;
const DEFAULT_RATE_WAIT_MS = 5_000;

/**
 * How many records the API says match, when it says: the endpoint's declared
 * `totalPath`, else an `X-Total-Count` header. What a complete read is later
 * checked against.
 */
const TOTAL_KEY = /^@?(total|total_?count|total_?results|total_?items|total_?entries|total_?records|count)$/i;

/** A whole-collection count an answer states beside its records — `total`, `meta.total`, DRF's `count`. */
const totalBeside = (body: unknown): number | undefined => {
  let found: number | undefined;
  const walk = (node: unknown, depth: number): void => {
    if (found !== undefined || depth > 2 || !node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (TOTAL_KEY.test(key) && typeof value === "number" && Number.isInteger(value) && value >= 0) {
        found = value;
        return;
      }
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(body, 0);
  return found;
};

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


/** Whether a read sends both ends of its time range: only then can a range be narrowed from either side. */
const readsBothEnds = (op: OpSpec): boolean => {
  if (!op.usesRange) return false;
  const sent = `${JSON.stringify(op.query)} ${op.body ? JSON.stringify(op.body) : ""}`;
  return /\{\{\s*range\.start\b/.test(sent) && /\{\{\s*range\.end\b/.test(sent);
};

/** The most windows one read may ask about, and how far a range is halved. */
const MAX_WINDOW_READS = 120;
const MAX_WINDOW_DEPTH = 40;
const DAY_MS = 86_400_000;

/**
 * Where to halve a time range: on a whole day while it spans several, so an
 * API that reads dates gets the same date on both sides of the cut, and on a
 * whole second below that. Null when it cannot be halved further.
 */
const midpoint = (start: number, end: number): number | null => {
  const unit = end - start > 4 * DAY_MS ? DAY_MS : 1000;
  const middle = Math.floor((start + (end - start) / 2) / unit) * unit;
  return middle > start && middle < end ? middle : null;
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

/**
 * The next page's address as the API gave it — in a Link header or in its
 * answer — kept on the address this read is at. Its path and query are the
 * API's; the origin stays ours, since an API behind a proxy names its inner
 * host or plain http, and a key is never sent anywhere else. A key that
 * travels in the query string is put back where the API's address left it out.
 */
const nextAddress = (
  given: string,
  current: string,
  authQuery: ReadonlyArray<readonly [string, string]>,
): string | null => {
  try {
    const here = new URL(current);
    const there = new URL(given, here);
    const url = new URL(`${there.pathname}${there.search}`, here.origin);
    for (const [name, value] of authQuery) if (!url.searchParams.has(name)) url.searchParams.set(name, value);
    return url.toString();
  } catch {
    return null;
  }
};

export class RestAdapter implements SourceAdapter {
  readonly kind = "rest" as const;
  /** Real APIs send no CORS headers, and a key in browser JS is a key on the wire. */
  readonly transport = "proxy" as const;

  constructor(private readonly http: HttpFetch) {}

  /**
   * One read, and — where the API will not list that far — the same read in
   * narrower time windows.
   *
   * Some lists stop at a point: "page × limit must be at most 1000". Past it
   * the API refuses, however the pages are asked for. Where the endpoint also
   * takes a time range and says how many records a range holds, the range is
   * split until each part holds no more than the API will list, and the parts
   * are read whole. Nothing is inferred: a part's count is the API's own, the
   * parts cover the range exactly, and the result is called complete only when
   * the records read are as many as the API said the whole range holds.
   * Otherwise the first read stands, with what it said about itself.
   */
  async fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    const began = Date.now();
    const whole = await this.readOnce(connection, op, overrides, ctx);
    const total = whole.meta.reportedTotal ?? totalBeside(whole.body);
    const reach = rowsAt(whole.body, op.rowsPath)?.length ?? 0;
    if (
      !whole.meta.truncated ||
      !whole.meta.warnings.includes(INCOMPLETE.laterPageRefused) ||
      !readsBothEnds(op) ||
      total === undefined ||
      total <= reach ||
      reach === 0
    )
      return whole;
    const range = ctx.params.range;
    const rows = await this.byWindows(connection, op, overrides, ctx, {
      start: range.all ? 0 : range.start,
      end: range.all ? ctx.now : range.end,
      reach,
    });
    /* Fewer than the first read, or more than the API says there are: the windows did not cover it. */
    if (!rows || rows.length <= reach || rows.length > total) return whole;
    const others = whole.meta.warnings.filter((warning) => warning !== INCOMPLETE.laterPageRefused);
    const short = rows.length < total;
    return {
      body: withRows(whole.body, op.rowsPath, rows),
      meta: {
        ...whole.meta,
        durationMs: Date.now() - began,
        truncated: short || others.some((warning) => isIncomplete(warning)),
        warnings: short ? [...others, INCOMPLETE.reportedMore(total)] : others,
        reportedTotal: total,
      },
    };
  }

  /**
   * Every record in a time range, read as parts the API will list to their
   * end. Null when a part cannot be counted, read or narrowed any further.
   */
  private async byWindows(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
    input: { readonly start: number; readonly end: number; readonly reach: number },
  ): Promise<unknown[] | null> {
    const { validators: _validators, ...rest } = ctx;
    const within = (start: number, end: number): FetchContext => {
      const { all: _all, ...range } = ctx.params.range;
      return { ...rest, params: { ...ctx.params, range: { ...range, start, end, preset: "custom" } } };
    };
    const seen = new Set<string>();
    const rows: unknown[] = [];
    let reads = 0;
    const read = async (start: number, end: number, depth: number): Promise<boolean> => {
      if (++reads > MAX_WINDOW_READS || depth > MAX_WINDOW_DEPTH) return false;
      /* One page says how many the window holds. */
      const first = await this.readOnce(connection, { ...op, maxPages: 1 }, overrides, within(start, end));
      const held = first.meta.reportedTotal ?? totalBeside(first.body);
      if (held === undefined) return false;
      if (held === 0) return true;
      if (held > input.reach) {
        /* Still more than the API will list: halve it, on a whole second or a whole day. */
        const middle = midpoint(start, end);
        if (middle === null) return false;
        return (await read(middle, end, depth + 1)) && (await read(start, middle, depth + 1));
      }
      const firstRows = rowsAt(first.body, op.rowsPath) ?? [];
      const part =
        firstRows.length >= held ? first : (reads++, await this.readOnce(connection, op, overrides, within(start, end)));
      if (part.meta.truncated) return false;
      for (const row of rowsAt(part.body, op.rowsPath) ?? []) {
        /* A record stamped exactly on a boundary may come back from both sides of it. */
        const print = JSON.stringify(row);
        if (seen.has(print)) continue;
        seen.add(print);
        rows.push(row);
      }
      return true;
    };
    try {
      return (await read(input.start, input.end, 0)) ? rows : null;
    } catch (error) {
      /* A window the API refused: the first read stands. A cancelled read is still cancelled. */
      if (ctx.signal?.aborted) throw error;
      return null;
    }
  }

  private async readOnce(
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
    const clientCertificate = await clientCertificateOf(connection, ctx.resolveSecret);
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
      const resolved = interpolate(String(value), ctx.params);
      /*
       * A value built from a token that resolves to nothing is left out, as a
       * body's is: a read over every record asks without date bounds, rather
       * than with `created[gte]=`, which an API refuses (checkpoint 4).
       */
      if (resolved === "" && hasTokens(String(value))) continue;
      setQueryValue(query, name, resolved, byName.get(name));
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
    /* A key in a cookie is kept beside an endpoint's own cookies, not replaced by them. */
    if (cookies.length > 0) headers.cookie = [headers.cookie, ...cookies].filter(Boolean).join("; ");

    if (!pagingInBody)
      for (const [name, value] of Object.entries(firstPageParams(op.pagination))) {
        if (query.get(name) !== value)
          throw new AdapterError(
            `Pagination input ${name} conflicts with this endpoint's pagination settings. Update the endpoint settings before loading it.`,
            { status: 400 },
          );
      }

    addAuthHeaders(headers, prepared.headers);
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
    let firstPageRows: number | undefined;
    let collected = 0;
    let renewals = 0;
    let waits = 0;
    /* HTTP Digest: the challenge answered, and how many requests its nonce has signed. */
    let digestState: { challenge: DigestChallenge; count: number } | null = null;
    let digestAnswers = 0;
    const reads = op.method === "POST" && op.body !== undefined;
    /* Sent twice only where the protocol says a read is a read: a GET, or a GraphQL query. */
    const repeatable = !reads || op.readSafety?.basis === "graphql-query";

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

      if (prepared.digest && digestState) {
        const signed = await digestAuthorization({
          challenge: digestState.challenge,
          username: prepared.digest.username,
          password: prepared.digest.password,
          method: sent ? "POST" : "GET",
          uri: pathAndQuery(next.url),
          count: ++digestState.count,
        });
        if (signed) headers.authorization = signed;
      }

      const response = await this.http(
        next.url,
        {
          headers: await signedForAws(prepared.sigv4, {
            method: sent ? "POST" : "GET",
            url: next.url,
            headers: { ...headers, ...conditional, ...(sent ? { "content-type": sent.contentType } : {}) },
            body: sent?.text,
          }),
          ...(sent ? { method: "POST", body: sent.text, purpose: "read" as const } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(clientCertificate ? { clientCertificate } : {}),
          ...(op.stream ? { stream: op.stream } : {}),
          ...(connection.privateNetwork ? { privateNetwork: true } : {}),
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
          addAuthHeaders(headers, prepared.headers);
          seen.delete(identity);
          continue;
        }
      }

      /*
       * HTTP Digest: the server's challenge, answered, and this same page read
       * again. Twice at most for one page — a fresh nonce, or one gone stale —
       * so a wrong password is refused rather than asked again and again; a
       * server whose nonces last a few requests is answered afresh on each
       * page that needs it.
       */
      if (response.status === 401 && prepared.digest && digestAnswers < 2) {
        const challenge = parseDigestChallenge(response.header("www-authenticate"));
        if (challenge) {
          digestAnswers++;
          digestState = { challenge, count: 0 };
          seen.delete(identity);
          continue;
        }
      }
      if (response.status !== 401) digestAnswers = 0;

      /* A short rate limit part-way through: wait, and read this same page again. */
      if (response.status === 429 && ctx.sleep && repeatable && waits < MAX_RATE_WAITS) {
        const wait = parseRetryAfter(response.header("retry-after") ?? undefined, ctx.now) ?? DEFAULT_RATE_WAIT_MS;
        if (wait <= MAX_RATE_WAIT_MS) {
          waits++;
          await ctx.sleep(wait);
          seen.delete(identity);
          continue;
        }
      }

      /*
       * Past the last page, some APIs answer 404 rather than an empty page.
       * After at least one page, and with no stated count saying more are
       * left, that is the end of the records, not a failed read.
       */
      if (
        response.status === 404 &&
        pageIndex > 0 &&
        (op.pagination.kind === "page" || op.pagination.kind === "offset") &&
        (reportedTotal === undefined || collected >= reportedTotal)
      ) {
        next = null;
        break;
      }

      /*
       * A later page the API will not give — "page × limit must be at most
       * 1000" — ends the read, and says so, rather than throwing away the
       * pages already read. Only a refusal of the request itself: a sign-in,
       * permission or rate limit still fails the read as it would at the
       * start (2026-09-30).
       */
      if (pageIndex > 0 && [400, 409, 416, 422].includes(response.status)) {
        truncated = true;
        warnings.push(INCOMPLETE.laterPageRefused);
        next = null;
        break;
      }

      lastUrl = response.url;
      lastStatus = response.status;
      if (pageIndex === 0) {
        etag = response.header("etag");
        lastModified = response.header("last-modified");
      }

      // What the API said, kept for whoever diagnoses a failure: tags out, secrets out, short.
      refusal(connection, host, response, readDetail(response.text, prepared.secrets));

      /* JSON, or whatever the answer says it is: XML, a table of rows, a record a line (`parse/`). */
      const body = parseBody(response.text, response.header("content-type"), response.url);
      if (pageIndex === 0) reportedTotal = statedTotal(op, body, response);
      pages.push(body);
      pageIndex++;
      if (op.pagination.kind !== "none" && rowsAt(body, op.rowsPath) === null) {
        truncated = true;
        warnings.push(INCOMPLETE.rowsMissing);
        break;
      }

      const pageRows = rowsAt(body, op.rowsPath)?.length ?? 0;
      if (pageIndex === 1) firstPageRows = pageRows;
      /* A window of a stream is the answer, and says it is a window. */
      if (op.stream && formatOf(response.header("content-type")) === "sse") {
        truncated = true;
        warnings.push(INCOMPLETE.streamWindow(op.stream.events, op.stream.seconds));
        next = null;
        break;
      }
      collected += pageRows;
      const decided = nextPageParams({
        pagination: op.pagination,
        body,
        rowsPath: op.rowsPath,
        pageIndex,
        firstPageRows,
        collected,
        reportedTotal,
      });
      if (decided.kind === "none") next = null;
      else if (decided.kind === "link-header" || decided.kind === "url") {
        const given: string | null = decided.kind === "url" ? decided.url : nextFromLinkHeader(response.header("link"));
        const url: string | null = given ? nextAddress(given, next.url, prepared.query) : null;
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
     * A total the answer states beside its records, where nothing declared
     * one: used only to say a read fell short, never to claim it complete.
     * Ten of 332 facts were read and shown as the whole, with nothing on the
     * tile (checkpoint 2).
     */
    if (!truncated && reportedTotal === undefined && pages.length > 0 && op.rowsPath && op.rowsPath !== "$") {
      const hinted = totalBeside(pages[0]);
      if (hinted !== undefined && hinted > collected) {
        truncated = true;
        warnings.push(INCOMPLETE.reportedMore(hinted));
      }
    }

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
    const clientCertificate = await clientCertificateOf(connection, ctx.resolveSecret);
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

    const sentBody = sending ? JSON.stringify(request.body) : undefined;
    const started = Date.now();
    let response: HttpResponse;
    try {
      response = await this.http(
        url,
        {
          headers: await signedForAws(prepared.sigv4, { method: op.method, url, headers, body: sentBody }),
          method: op.method,
          purpose: "write",
          ...(sentBody !== undefined ? { body: sentBody } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(clientCertificate ? { clientCertificate } : {}),
          ...(connection.privateNetwork ? { privateNetwork: true } : {}),
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
      body = parseBody(response.text, response.header("content-type"), response.url);
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

