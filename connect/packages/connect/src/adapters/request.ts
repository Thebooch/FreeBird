import {
  fnv1a,
  hasTokens,
  interpolate,
  interpolatePath,
  missingInputs,
  pagingParamNames,
  pathParamNames,
  type ConnectionSpec,
  type OpSpec,
  type ParamDef,
  type ReadBody,
  type ResolvedParams,
} from "@freebirdai/connect-spec";
import { firstPageParams } from "./paginate.js";
import { AdapterError } from "./types.js";

/**
 * Building a read's request: where each input goes, how a list is written,
 * and what a body says.
 *
 * Shared by reads and writes, so one API's conventions are spelled one way
 * whichever direction a request goes.
 */

type Value = string | number | boolean;

/** Inputs given for an endpoint, sorted by where the endpoint declares each one goes. */
export interface LocatedInputs {
  readonly query: Record<string, Value>;
  readonly header: Record<string, string>;
  readonly cookie: Record<string, string>;
  /** Filled into the body template through its `{{param.x}}` tokens. */
  readonly body: Record<string, Value>;
}

/**
 * Put each supplied value where its parameter lives, and fill in the
 * documented default of any header, cookie or body parameter nobody supplied.
 * A value for a name the endpoint does not declare goes on the query string,
 * which is what every caller did before locations existed.
 */
export const locateInputs = (
  op: Pick<OpSpec, "params">,
  supplied: Readonly<Record<string, Value>>,
): LocatedInputs => {
  const located: LocatedInputs = { query: {}, header: {}, cookie: {}, body: {} };
  const byName = new Map(op.params.map((param) => [param.name, param]));
  for (const [name, value] of Object.entries(supplied)) {
    const where = byName.get(name)?.in ?? "query";
    if (where === "header" || where === "cookie") located[where][name] = String(value);
    else if (where === "body") located.body[name] = value;
    else if (where === "query") located.query[name] = value;
  }
  for (const param of op.params) {
    if (param.default === undefined || param.name in supplied) continue;
    if (param.in === "header" || param.in === "cookie") located[param.in][param.name] = String(param.default);
    else if (param.in === "body") located.body[param.name] = param.default;
  }
  return located;
};

/**
 * Write one value onto a query string, a list per its parameter's style.
 *
 * OpenAPI's defaults: `form`, exploded — `status=open&status=paid`.
 * Unexploded it is `status=open,paid`; `spaceDelimited` and `pipeDelimited`
 * join with a space or a bar. A list arrives as text separated by commas,
 * which is what a filter's value is. Anything that is not a list is set as-is.
 */
export const setQueryValue = (
  query: URLSearchParams,
  name: string,
  value: Value,
  param?: ParamDef,
): void => {
  if (param?.type !== "array") {
    query.set(name, String(value));
    return;
  }
  const items = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  query.delete(name);
  if (items.length === 0) return;
  const style = param.style ?? "form";
  if (style === "form" && (param.explode ?? true)) {
    for (const item of items) query.append(name, item);
    return;
  }
  query.set(name, items.join(style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ","));
};

/** Set a value at a dotted path (`page.after`) in an object, making the steps on the way. */
export const setAtPath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = path.split(".").filter(Boolean);
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last) cursor[last] = value;
};

const ONLY_TOKEN = /^\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|\s*([a-z_]+)\s*)?\}\}$/;

/**
 * Fill a body template's tokens.
 *
 * A string that is exactly one token takes its value's own type, so
 * `"size": "{{param.size}}"` sends 50, not "50"; a token that resolves to
 * nothing drops its key, because an empty filter means no filter. Every
 * other string is interpolated as text.
 */
export const fillTemplate = (template: unknown, params: ResolvedParams): unknown => {
  if (typeof template === "string") {
    const only = ONLY_TOKEN.exec(template);
    if (only) {
      const key = only[1]!;
      if (key.startsWith("param.") && !only[2]) {
        const raw = params.filters[key.slice("param.".length)];
        return raw === undefined || raw === "" ? undefined : raw;
      }
      const text = interpolate(template, params);
      if (text === "") return undefined;
      return only[2] === "unix" || only[2] === "unix_ms" ? Number(text) : text;
    }
    return interpolate(template, params);
  }
  if (Array.isArray(template))
    return template.map((item) => fillTemplate(item, params)).filter((item) => item !== undefined);
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      const filled = fillTemplate(value, params);
      if (filled !== undefined) out[key] = filled;
    }
    return out;
  }
  return template;
};

/** A paging value as the body wants it: a number where it is one, a cursor as text. */
const pagingValue = (value: string): string | number =>
  /^-?\d+$/.test(value) && value.length < 16 ? Number(value) : value;

/**
 * What a read sends: the body, rendered, and how it says what it is.
 *
 * `paging` holds the paging rule's parameters when they travel in the body —
 * dotted paths into a JSON body, or into GraphQL's variables.
 */
export const renderBody = (
  body: ReadBody,
  params: ResolvedParams,
  paging: Readonly<Record<string, string>>,
): { readonly text: string; readonly contentType: string } => {
  if (body.type === "form") {
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(fillTemplate(body.template, params) as Record<string, unknown>)) {
      if (value !== undefined) form.set(name, String(value));
    }
    for (const [name, value] of Object.entries(paging)) form.set(name, value);
    return { text: form.toString(), contentType: "application/x-www-form-urlencoded" };
  }
  if (body.type === "xml") {
    const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    /* An element holding only an input nobody gave is left out, not sent empty. */
    const text = body.template
      .replace(/<([A-Za-z_][\w.:-]*)>\s*(\{\{[^}]+\}\})\s*<\/\1>/g, (_whole, tag: string, token: string) => {
        const value = interpolate(token, params);
        return value === "" ? "" : `<${tag}>${escape(value)}</${tag}>`;
      })
      .replace(/\{\{[^}]+\}\}/g, (token) => escape(interpolate(token, params)));
    return { text, contentType: body.contentType };
  }
  if (body.type === "graphql") {
    const variables = (fillTemplate(body.variables, params) ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(paging)) setAtPath(variables, name, pagingValue(value));
    return {
      text: JSON.stringify({
        query: body.query,
        variables,
        ...(body.operationName ? { operationName: body.operationName } : {}),
      }),
      contentType: "application/json",
    };
  }
  const filled = fillTemplate(body.template, params);
  const document =
    filled !== null && typeof filled === "object" && !Array.isArray(filled)
      ? (filled as Record<string, unknown>)
      : Object.keys(paging).length > 0
        ? {}
        : filled;
  if (document !== null && typeof document === "object" && !Array.isArray(document))
    for (const [name, value] of Object.entries(paging))
      setAtPath(document as Record<string, unknown>, name, pagingValue(value));
  return { text: JSON.stringify(document ?? {}), contentType: "application/json" };
};

/**
 * A read's first request, with every input in place and no credential: the
 * request REST sends, and the one connector code is handed.
 *
 * One resolver, so an endpoint read by connector code asks for exactly the
 * records the same endpoint read by REST would: the widget's own values, the
 * board's filters and range, each parameter's documented default. Before
 * this, a connector's request was rebuilt from the endpoint's defaults alone,
 * and a widget narrowed by a value read every record.
 */
export interface ResolvedReadRequest {
  readonly method: "GET" | "POST";
  /** The base address and the path, with no query string. */
  readonly address: string;
  /** The first page's query string. Credentials are the caller's to add. */
  readonly query: URLSearchParams;
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Whether the paging rule's values travel in the body rather than the query string. */
  readonly pagingInBody: boolean;
  /** What a body template's tokens read, page after page. */
  readonly bodyParams: ResolvedParams;
  /** The first page's body, where the read sends one. */
  readonly body?: { readonly text: string; readonly contentType: string };
  /** Every value the read is given, by name: defaults, then the board's filters, then the widget's own. */
  readonly inputs: Readonly<Record<string, Value>>;
  /** Inputs the read needs and nothing supplied: refused by REST, left to connector code to supply. */
  readonly unresolved: readonly string[];
  /**
   * What this read asks for, as a digest: the address, path, inputs, headers,
   * body and — where the endpoint reads one — the time range. Never paging,
   * never a credential. A count is only evidence about records read under
   * the same scope.
   */
  readonly scope: string;
}

const withQueryString = (address: string, query: URLSearchParams): string => {
  const text = query.toString();
  return text ? `${address}${address.includes("?") ? "&" : "?"}${text}` : address;
};

export const resolveReadRequest = (
  connection: Pick<ConnectionSpec, "baseUrl">,
  op: OpSpec,
  overrides: Readonly<Record<string, Value>>,
  params: ResolvedParams,
  options: {
    /** Values the credential puts on the query string: they satisfy an input of the same name. */
    readonly credentialQuery?: ReadonlyArray<readonly [string, string]>;
  } = {},
): ResolvedReadRequest => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(op.headers)) headers[name] = interpolate(value, params);

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
    const resolved = interpolate(String(value), params);
    /*
     * A value built from a token that resolves to nothing is left out, as a
     * body's is: a read over every record asks without date bounds, rather
     * than with `created[gte]=`, which an API refuses.
     */
    if (resolved === "" && hasTokens(String(value))) continue;
    setQueryValue(query, name, resolved, byName.get(name));
  }
  for (const [name, value] of Object.entries(located.query)) {
    const resolved = typeof value === "string" ? interpolate(value, params) : String(value);
    // An empty override means "no filter", not "filter by empty string".
    if (resolved === "") query.delete(name);
    else setQueryValue(query, name, resolved, byName.get(name));
  }
  for (const [name, value] of Object.entries(located.header)) {
    const resolved = interpolate(value, params);
    if (resolved !== "") headers[name] = resolved;
  }
  const cookies = Object.entries(located.cookie)
    .map(([name, value]) => [name, interpolate(value, params)] as const)
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

  /* The body's tokens read the supplied values, with body parameters' defaults beside them. */
  const bodyParams: ResolvedParams = { ...params, filters: { ...params.filters, ...located.body } };

  /*
   * What this endpoint needs before it can be called, asked of the spec
   * rather than re-derived here. `missingInputs` checks the declared
   * parameters *and* the path template — see its comment for why the path
   * case is the dangerous one.
   */
  const asked = new URLSearchParams(query);
  for (const [name, value] of options.credentialQuery ?? []) asked.set(name, value);
  const supplied: Record<string, Value> = {
    ...Object.fromEntries(asked),
    ...located.header,
    ...located.cookie,
    ...located.body,
    ...params.filters,
  };
  // Query values are validated where they are sent; path values come only
  // from path inputs, so a query parameter cannot satisfy a missing path id.
  for (const param of op.params) {
    if (param.in === "query") supplied[param.name] = asked.get(param.name) ?? "";
  }
  const unresolved = missingInputs(op, supplied);
  for (const name of pathParamNames(op.path)) {
    if ((params.filters[name] === undefined || params.filters[name] === "") && !unresolved.includes(name)) unresolved.push(name);
  }

  const path = interpolatePath(op.path, params);
  const base = (connection.baseUrl ?? "").replace(/\/+$/, "");
  const address = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const method = op.method;
  const body =
    method === "POST" && op.body ? renderBody(op.body, bodyParams, pagingInBody ? firstPageParams(op.pagination) : {}) : undefined;

  const defaults: Record<string, Value> = {};
  for (const param of op.params) if (param.default !== undefined) defaults[param.name] = param.default;
  const inputs: Record<string, Value> = { ...defaults, ...params.filters, ...overrides };

  const paging = new Set(pagingParamNames(op.pagination));
  const sorted = (entries: Iterable<readonly [string, string]>) =>
    [...entries].filter(([name]) => !paging.has(name)).sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b)));
  const scope = fnv1a(
    JSON.stringify({
      op: op.id,
      address,
      query: sorted(query),
      headers: sorted(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value] as const)),
      body: method === "POST" && op.body ? renderBody(op.body, bodyParams, {}).text : null,
      range: op.usesRange ? [params.range.all ? "all" : params.range.start, params.range.all ? "all" : params.range.end] : null,
    }),
  );

  return {
    method,
    address,
    query,
    url: withQueryString(address, query),
    headers,
    pagingInBody,
    bodyParams,
    ...(body ? { body } : {}),
    inputs,
    unresolved,
    scope,
  };
};
