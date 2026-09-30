import {
  interpolate,
  type OpSpec,
  type ParamDef,
  type ReadBody,
  type ResolvedParams,
} from "@freebirdai/dash-spec";

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
