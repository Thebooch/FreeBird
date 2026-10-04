import type {
  CatalogEntry,
  ParamDef,
  ServerTemplate,
  ServerVariable,
  WriteOpDef,
} from "@freebirdai/dash-spec";
import { fieldsFromSchema } from "./schema-fields.js";
import { bodyFieldsFromSchema, isJsonBody } from "./body-fields.js";
import {
  IMPORT_VERSION,
  WRITES_VERSION,
  type CapabilityId,
  capabilityNote,
  catalogEntrySchema,
  deriveResourceModel,
  fnv1a,
  serverTemplateSchema,
  templateVariableNames,
  writeOpDefSchema,
} from "@freebirdai/dash-spec";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

/**
 * Rung 2 of the discovery ladder, and the one worth reaching for first.
 *
 * A published spec is exact: paths, params, auth and response shapes, with no
 * model in the loop and nothing to hallucinate. It also reveals the two things
 * sampling never can — pagination and auth — which are precisely where a wrong
 * guess fails silently rather than loudly.
 */

export interface OpenApiResult {
  readonly entry: CatalogEntry;
  readonly warnings: readonly string[];
  /** GET operations found before any cap was applied. */
  readonly totalOperations: number;
  /** Create, update, delete and action endpoints, kept apart from the reads. */
  readonly totalWrites?: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * A spec's prose, with its markup taken out.
 *
 * Descriptions are written for a documentation site, so they arrive with HTML
 * in them — Buildium's carry a `<span class="permissionBlock">` naming the
 * scope each endpoint needs. The *text* of that is worth keeping and is
 * genuinely useful: it says which permission a key must hold, which is exactly
 * what a 403 turns out to be about. The tags are only noise, and they would be
 * noise inside a model prompt that is already tight on room.
 */
const plainText = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const text = value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/`/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : undefined;
};

/** Does this document look like a spec at all? */
export const looksLikeOpenApi = (doc: unknown): boolean =>
  isObject(doc) && (typeof doc.openapi === "string" || typeof doc.swagger === "string");

/**
 * Collapse `allOf` / single-branch `oneOf` into the schema they describe.
 *
 * OpenAPI 3.0 ignores every sibling of a `$ref`, so the only way to attach a
 * description or `nullable` to a referenced schema is to wrap it:
 *
 *     Category: { allOf: [{ $ref: ".../TaskCategory" }],
 *                 description: "Task category.", nullable: true }
 *
 * That is not an edge case. It is what every generator that emits annotated
 * references produces, which is most enterprise specs — and unflattened it has
 * no `type`, no `properties` and no `items`, so a reader sees a schema that
 * declares nothing and treats it as a string. Buildium's whole API imported
 * that way: `Category` and `Property` on a task became strings, no field name
 * with a dot in it existed anywhere in the map, and everything downstream that
 * reasons about nested values was reading a flat world. The structural
 * fallback added earlier could not help — there was no structure to read until
 * the wrapper came off.
 *
 * `oneOf` and `anyOf` are collapsed only when exactly one branch says
 * anything, which is the other spelling of the same idea — a schema paired
 * with an explicit null. A genuine union of several shapes is left alone,
 * because picking one of them would be inventing a fact.
 */
const flattenComposition = (doc: Json, node: Json, seen: Set<string>, depth: number): Json => {
  const branches = [node.allOf, node.oneOf, node.anyOf].find((value) => Array.isArray(value));
  if (!Array.isArray(branches) || branches.length === 0) return node;

  const resolved = branches
    .map((branch) => deref(doc, branch, new Set(seen), depth + 1))
    .filter((branch): branch is Json => isObject(branch));

  // `oneOf: [{$ref}, {type: "null"}]` — everything meaningful is in one branch.
  const meaningful =
    node.allOf !== undefined
      ? resolved
      : resolved.filter((branch) => str(branch.type) !== "null" && Object.keys(branch).length > 0);
  if (meaningful.length === 0 || (node.allOf === undefined && meaningful.length > 1)) return node;

  const merged: Json = {};
  const properties: Json = {};
  const required: string[] = [];

  for (const branch of meaningful) {
    for (const [key, value] of Object.entries(branch)) {
      if (key === "properties") {
        if (isObject(value)) Object.assign(properties, value);
      } else if (key === "required") {
        if (Array.isArray(value))
          required.push(...value.filter((entry) => typeof entry === "string"));
      } else if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }

  /*
   * The wrapper's own keys win, because they are the annotation: a `nullable`
   * or a `description` written beside the composition is about this use of the
   * schema, not about the schema. `allOf` itself is dropped — it has been
   * consumed — and its own properties merge with the branches' rather than
   * replacing them.
   */
  for (const [key, value] of Object.entries(node)) {
    if (key === "allOf" || key === "oneOf" || key === "anyOf") continue;
    if (key === "properties") {
      if (isObject(value)) Object.assign(properties, value);
    } else if (key === "required") {
      if (Array.isArray(value))
        required.push(...value.filter((entry) => typeof entry === "string"));
    } else {
      merged[key] = value;
    }
  }

  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.length > 0) merged.required = [...new Set(required)];
  return merged;
};

/**
 * Resolve `$ref` pointers within the same document. External refs are not
 * followed — a spec that splits across files is rarer than one that lies, and
 * chasing them turns a parse into a crawl.
 */
const deref = (doc: Json, node: unknown, seen = new Set<string>(), depth = 0): unknown => {
  if (depth > 8 || !isObject(node)) return node;
  const ref = str(node.$ref);
  if (!ref) return flattenComposition(doc, node, seen, depth);
  if (!ref.startsWith("#/") || seen.has(ref)) return {};
  seen.add(ref);

  let cursor: unknown = doc;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(cursor)) return {};
    cursor = cursor[key];
  }
  return deref(doc, cursor, seen, depth + 1);
};

const specVersionOf = (doc: Json): 2 | 3 => (typeof doc.swagger === "string" ? 2 : 3);

/** Where an API lives, as its specification tells it. */
export interface ApiAddress {
  /** A real address to start from. See `server` and `guessed` before trusting it. */
  readonly baseUrl: string;
  /** The address with per-account parts, when the spec writes it that way. */
  readonly server?: ServerTemplate;
  /** The spec never said; `baseUrl` is where the documentation was served from. */
  readonly guessed?: true;
}

/** "account_subdomain" → "Account subdomain". */
const humanise = (name: string): string => {
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/**
 * A templated server — `https://{account}.rentvine.com/api/manager` — kept as
 * a template, with what the spec says about each blank.
 *
 * These used to be skipped as "unusable as-is", which sent every request to
 * the host the docs were served from. A business API hosted per customer is
 * the ordinary case, not an edge one; the blank is the one thing only the
 * person connecting can fill in, and now they are asked for it.
 */
const templatedServer = (
  server: Json,
  specUrl: string,
): { baseUrl: string; server: ServerTemplate } | undefined => {
  const raw = str(server.url);
  if (!raw) return undefined;
  let url = raw.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    /* A relative template is relative to the spec, like any relative server. */
    try {
      const origin = new URL(specUrl).origin;
      url = `${origin}${url.startsWith("/") ? "" : "/"}${url}`;
    } catch {
      return undefined;
    }
  }
  const declared = isObject(server.variables) ? server.variables : {};
  const variables: ServerVariable[] = templateVariableNames(url).map((name) => {
    const spec = isObject(declared[name]) ? declared[name] : {};
    const options = Array.isArray(spec.enum)
      ? spec.enum.map(String).filter((value) => value.length > 0).slice(0, 50)
      : [];
    const description = plainText(str(spec.description))?.slice(0, 300);
    const fallback = str(spec.default) ?? (spec.default !== undefined ? String(spec.default) : undefined);
    return {
      name,
      label: humanise(name),
      ...(description ? { description } : {}),
      ...(fallback ? { default: fallback.slice(0, 200) } : {}),
      ...(options.length > 0 ? { options } : {}),
    };
  });
  const parsed = serverTemplateSchema.safeParse({ url, variables });
  if (!parsed.success) return undefined;

  /*
   * `baseUrl` still has to be an address, so the template is filled with its
   * defaults — or the blank's own name — and nothing trusts it: a connection
   * made from this asks for the real values before it sends anything.
   */
  const filled = parsed.data.url.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_raw, name: string) => {
    const variable = parsed.data.variables.find((one) => one.name === name);
    return (variable?.default ?? name).replace(/[^A-Za-z0-9._~-]/g, "") || name;
  });
  try {
    return { baseUrl: new URL(filled).toString().replace(/\/+$/, ""), server: parsed.data };
  } catch {
    return undefined;
  }
};

/** Whether a document names no server at all, so it is served from where the document is. */
const servedFromDocument = (doc: Json): boolean =>
  specVersionOf(doc) === 2
    ? str(doc.host) === undefined
    : !Array.isArray(doc.servers) || doc.servers.length === 0;

export const addressFrom = (doc: Json, specUrl: string): ApiAddress | undefined => {
  if (specVersionOf(doc) === 2) {
    const host = str(doc.host);
    const basePath = str(doc.basePath) ?? "";
    const schemes = Array.isArray(doc.schemes) ? doc.schemes.map(String) : [];
    const scheme = schemes.includes("https") ? "https" : (schemes[0] ?? "https");
    if (host && !host.includes("{")) {
      return { baseUrl: `${scheme}://${host}${basePath}`.replace(/\/+$/, "") };
    }
    /* No host at all means the host serving the document, by Swagger 2's own rule — not a guess. */
    if (host === undefined) {
      try {
        const served = new URL(specUrl);
        return { baseUrl: `${served.protocol}//${served.host}${basePath}`.replace(/\/+$/, "") };
      } catch {
        /* fall through to the guess */
      }
    }
  } else {
    const servers = Array.isArray(doc.servers) ? doc.servers.filter(isObject) : [];
    /*
     * No servers at all means one at "/", relative to the document, by
     * OpenAPI 3's own rule — not a guess. Asked for an address anyway, a
     * public API whose document leaves them out could never be read without
     * a person typing what the specification had already said.
     */
    if (!Array.isArray(doc.servers) || doc.servers.length === 0) {
      try {
        return { baseUrl: new URL(specUrl).origin };
      } catch {
        return undefined;
      }
    }
    /* A fixed address wins: nothing to ask. */
    for (const server of servers) {
      const url = str(server.url);
      if (!url || url.includes("{")) continue;
      if (/^https?:\/\//i.test(url)) return { baseUrl: url.replace(/\/+$/, "") };
      // A relative server URL is relative to where the spec was served from.
      try {
        return { baseUrl: new URL(url, specUrl).toString().replace(/\/+$/, "") };
      } catch {
        /* keep looking */
      }
    }
    for (const server of servers) {
      if (!str(server.url)?.includes("{")) continue;
      const templated = templatedServer(server, specUrl);
      if (templated) return templated;
    }
  }
  // Last resort: the spec's own origin — a guess, and said to be one.
  try {
    return { baseUrl: new URL(specUrl).origin, guessed: true };
  } catch {
    return undefined;
  }
};

/**
 * Where one operation lives, when it names a server of its own.
 *
 * OpenAPI 3 lets a path or an operation override the document's servers.
 * Ignoring that sends the request to the document's address, where the
 * endpoint does not exist. A server under the connection's own address is
 * folded into the path; one elsewhere cannot be read by a connection pinned
 * to one host, so the caller leaves the endpoint out and says so.
 */
export const operationPath = (
  doc: Json,
  rawPath: string,
  operation: Json,
  pathItem: Json,
  baseUrl: string,
  specUrl: string,
): { path: string } | { elsewhere: string } => {
  if (specVersionOf(doc) === 2) return { path: rawPath };
  const servers = [operation.servers, pathItem.servers].find(
    (list): list is unknown[] => Array.isArray(list) && list.length > 0,
  );
  if (!servers) return { path: rawPath };
  const fixed = servers
    .filter(isObject)
    .map((server) => str(server.url))
    .find((url): url is string => !!url && !url.includes("{"));
  // A templated override cannot be resolved here; the document's address stands.
  if (!fixed) return { path: rawPath };
  let server: URL;
  let base: URL;
  try {
    server = new URL(fixed, specUrl);
    base = new URL(baseUrl);
  } catch {
    return { path: rawPath };
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const serverPath = server.pathname.replace(/\/+$/, "");
  if (
    server.origin !== base.origin ||
    !(serverPath === basePath || serverPath.startsWith(`${basePath}/`))
  )
    return { elsewhere: `${server.origin}${serverPath}` };
  const rest = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return { path: `${serverPath.slice(basePath.length)}${rest}` };
};

/**
 * What the documentation says about getting in, in a reader's words.
 *
 * The security scheme's own description first, then a section headed like
 * "Authentication", then the sentences of the overview that mention keys. A
 * spec can say perfectly clearly that the username is an access key and the
 * password a secret — Rentvine's does, under its Authentication tag — while
 * its security scheme says only `http/basic`. That sentence is the one the
 * person connecting needs to read.
 */
export const authHelpFrom = (doc: Json): string | undefined => {
  const schemes =
    specVersionOf(doc) === 2
      ? isObject(doc.securityDefinitions)
        ? doc.securityDefinitions
        : {}
      : isObject(doc.components) && isObject(doc.components.securitySchemes)
        ? doc.components.securitySchemes
        : {};
  /*
   * Prose only. Example requests go first — a `curl` line is an illustration,
   * not an instruction — and block boundaries become sentence breaks, or
   * "…the password.</p><pre>#…" reads as one run-on sentence that ends in a
   * shell command.
   */
  const prose = (raw: string | undefined): string | undefined =>
    plainText(
      raw
        ?.replace(/<pre[\s\S]*?<\/pre>/gi, " ")
        .replace(/<code[\s\S]*?<\/code>/gi, " ")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, "\n")
        .replace(/\n+/g, ". ")
        .replace(/\.\s*\./g, "."),
    );
  const fromSchemes = Object.values(schemes)
    .map((scheme) => (isObject(scheme) ? prose(str(scheme.description)) : undefined))
    .filter((text): text is string => Boolean(text));
  const tags = Array.isArray(doc.tags) ? doc.tags.filter(isObject) : [];
  const fromTags = tags
    .filter((tag) => /auth/i.test(str(tag.name) ?? ""))
    .map((tag) => prose(str(tag.description)))
    .filter((text): text is string => Boolean(text));
  const info = isObject(doc.info) ? doc.info : {};
  const overview = prose(str(info.description));

  const AUTH_WORDS = /authenticat|api[ -]?key|access key|secret|token|username|password|credential/i;
  const sentences = (text: string): string[] =>
    text
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(
        (sentence) =>
          sentence.length > 0 &&
          sentence.length <= 300 &&
          AUTH_WORDS.test(sentence) &&
          /* Example requests are not instructions. */
          !/\bcurl\b|^#|\$ /.test(sentence),
      );

  const picked = [...fromSchemes, ...fromTags, ...(overview ? [overview] : [])]
    .flatMap(sentences)
    .filter((sentence, index, all) => all.indexOf(sentence) === index)
    .slice(0, 3);
  const help = picked.join(" ").slice(0, 600).trim();
  return help.length > 0 ? help : undefined;
};

/**
 * What the documentation calls the two halves of a Basic login.
 *
 * "…with the access key as the username and secret as the password" gives
 * "Access key" and "Secret". Read clause by clause, so one half's words never
 * run into the other's; absent when the text does not say.
 */
export const basicLabelsFrom = (
  text: string | undefined,
): { usernameLabel?: string; label?: string } => {
  if (!text) return {};
  const STOP = /^(?:(?:use|using|with|pass|passing|send|sending|provide|supply|enter|set|your|the|an?|as|and|by)\s+)+/i;
  const found: { usernameLabel?: string; label?: string } = {};
  for (const clause of text.split(/[.,;:()]|\band\b/i)) {
    const match = clause.match(
      /([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3})\s+as\s+(?:the\s+|your\s+)?(username|user name|login|password|secret)\b/i,
    );
    if (!match) continue;
    const words = match[1]!.replace(STOP, "").trim();
    if (!words || /user\s*name|password/i.test(words) || words.length > 40) continue;
    const label = words.charAt(0).toUpperCase() + words.slice(1);
    if (/user|login/i.test(match[2]!)) found.usernameLabel ??= label;
    else found.label ??= label;
  }
  return found;
};

type DialectAuth = NonNullable<CatalogEntry["dialect"]["auth"]>;
type DialectPagination = NonNullable<CatalogEntry["dialect"]["pagination"]>;
type DialectTimeFilter = NonNullable<CatalogEntry["dialect"]["timeFilter"]>;

/**
 * Every security scheme the document declares, by name.
 *
 * Both homes are read, the document's own version first. A document merged
 * from per-page fragments can carry schemes in either, and reading only the
 * one its version names is how a merged Swagger 2 reference lost every scheme
 * it had and came out as needing no key at all.
 */
const schemesOf = (doc: Json): Json => {
  const v2 = isObject(doc.securityDefinitions) ? doc.securityDefinitions : {};
  const v3 =
    isObject(doc.components) && isObject(doc.components.securitySchemes)
      ? doc.components.securitySchemes
      : {};
  return specVersionOf(doc) === 2 ? { ...v3, ...v2 } : { ...v2, ...v3 };
};

/**
 * A key the API issues itself, through a login it documents.
 *
 * "A session token from POST /login" is not something anybody copies from a
 * settings page: asking a person to paste it asks them for a value they do not
 * have. Recognised narrowly — the scheme's own description names a POST
 * operation this document declares — so a key described as coming from an
 * account page is still a key.
 */
const issuedByLogin = (doc: Json, scheme: Json): boolean => {
  const description = str(scheme.description) ?? "";
  if (description === "") return false;
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const match of description.matchAll(/\bPOST\s+`?(\/[A-Za-z0-9_\-./{}]+)/g)) {
    const item = paths[match[1]!.replace(/[.,;:]+$/, "")];
    if (isObject(item) && isObject(item.post)) return true;
  }
  return false;
};

/**
 * AWS Signature Version 4, as API Gateway's exports mark it: an `apiKey`
 * scheme named `Authorization` carrying `x-amazon-apigateway-authtype`.
 * Signed by the built-in signer, never pasted as a header.
 */
const awsSigned = (scheme: Json): boolean =>
  /^aws_?sigv4$/i.test(str(scheme["x-amazon-apigateway-authtype"]) ?? "") ||
  (str(scheme.type)?.toLowerCase() === "http" && /^aws4-hmac-sha256$/i.test(str(scheme.scheme) ?? ""));

/** The capability a scheme needs that no supported auth type covers, if any. */
const schemeGap = (scheme: Json, doc: Json): CapabilityId | null => {
  const type = str(scheme.type)?.toLowerCase();
  const httpScheme = str(scheme.scheme)?.toLowerCase();
  if ((type === "apikey" || (type === "http" && httpScheme === "bearer")) && issuedByLogin(doc, scheme))
    return "auth.token-exchange";
  if (type === "oauth2") return oauthFlowOf(scheme, "probe") ? null : "auth.oauth2-token";
  if (type === "openidconnect") return "auth.oidc";
  if (awsSigned(scheme)) return null;
  if (type === "http" && httpScheme && httpScheme !== "bearer" && httpScheme !== "basic")
    return "auth.signing";
  return null;
};

/**
 * What the document's sign-in needs that Dash cannot do, in plain words.
 *
 * Said only when it matters: when nothing supported was found, or when the
 * key being asked for is an OAuth token somebody must fetch by hand. A spec
 * that offers an API key *and* OAuth needs no sentence about OAuth.
 */
const signInGaps = (doc: Json, chosen: DialectAuth): string[] => {
  const byGap = new Map<CapabilityId, string>();
  let bearer = false;
  for (const [name, raw] of Object.entries(schemesOf(doc))) {
    const scheme = deref(doc, raw);
    if (!isObject(scheme)) continue;
    if (str(scheme.type) === "http" && str(scheme.scheme)?.toLowerCase() === "bearer") bearer = true;
    const gap = schemeGap(scheme, doc);
    if (gap && !byGap.has(gap)) byGap.set(gap, name);
  }
  const fromOAuth = chosen.type === "bearer" && !bearer && byGap.has("auth.oauth2-token");
  if (chosen.type !== "none" && !fromOAuth) return [];
  return [...byGap]
    .filter(([gap]) => chosen.type === "none" || gap === "auth.oauth2-token")
    .map(([gap, name]) => capabilityNote(gap, `The "${name}" sign-in scheme`));
};

/**
 * Every sign-in a document declares that Dash cannot send, in plain words.
 *
 * For explaining, after the fact, why a connection made from it has no
 * sign-in: the integration loop says this instead of reporting a refusal
 * when nothing was ever sent.
 */
export const signInGapNotes = (doc: unknown): string[] =>
  isObject(doc) ? signInGaps(doc, { type: "none" }) : [];

/** Words that name a read, and words that name a change, in an operation's id, summary or path. */
const READ_WORDS = /\b(search|query|queries|list|find|filter|report|reports|lookup|retrieve|fetch|browse)\b/i;
const CHANGE_WORDS =
  /\b(create|add|new|update|edit|delete|remove|send|submit|cancel|approve|close|upload|import|export|batch|bulk|start|run|trigger|charge|refund|pay|void)\b/i;
const PAGING_WORDS = new Set([
  ...["cursor", "starting_after", "after", "page_token", "next_cursor", "next"],
  ...["page", "page_number", "pagenum"],
  ...["offset", "skip", "start"],
]);

/**
 * Whether a POST reads, and what it would send.
 *
 * A POST is a read only on the specification's own word (`x-read-only`) or
 * when its name says it reads — search, list, query, report — and nothing in
 * it says it changes something, and it answers with a list of records. That
 * is evidence of intent, not proof, so it is recorded as such (`readSafety`)
 * and such a read is only ever sent while somebody is looking at it.
 *
 * Its body is a template: each field of the request becomes a `{{param.x}}`
 * input (left out when empty), except the fields a paging rule will set,
 * and fields with a documented default, which are sent with it.
 */
export const postReadOf = (
  doc: Json,
  operation: Json,
  rawPath: string,
): {
  readonly body: { type: "json"; template: Record<string, unknown> };
  readonly params: ImportedParam[];
  readonly readSafety: { basis: "spec-declared" | "docs-inferred"; note: string };
} | null => {
  const declared = operation["x-read-only"] === true || operation["x-readonly"] === true;
  const name = str(operation.operationId)?.replace(/([a-z])([A-Z])/g, "$1 $2");
  const words = [name, str(operation.summary), rawPath.split("/").filter(Boolean).pop()].filter(Boolean).join(" ");
  if (!declared && (!READ_WORDS.test(words) || CHANGE_WORDS.test(words))) return null;
  if (!declared && shapeOf(doc, successSchema(doc, operation), false).archetype !== "list") return null;

  const requestBody = deref(doc, operation.requestBody);
  const content = isObject(requestBody) && isObject(requestBody.content) ? requestBody.content : {};
  const media = Object.entries(content).find(([type]) => /json/i.test(type))?.[1];
  const schema = isObject(media) ? deref(doc, media.schema) : undefined;

  const template: Record<string, unknown> = {};
  const params: ImportedParam[] = [];
  const walk = (node: unknown, path: string[], depth: number) => {
    const object = deref(doc, node);
    if (!isObject(object) || !isObject(object.properties) || depth > 2) return;
    for (const [key, raw] of Object.entries(object.properties)) {
      const property = deref(doc, raw);
      const here = [...path, key];
      if (isObject(property) && isObject(property.properties)) {
        walk(property, here, depth + 1);
        continue;
      }
      const dotted = here.join(".");
      const paging = PAGING_WORDS.has(key.toLowerCase());
      const fixed = isObject(property) ? scalar(property.default) : undefined;
      params.push({
        name: dotted,
        in: "body",
        type: paramType(property),
        required: false,
        ...(isObject(property) && str(property.description) ? { description: str(property.description)!.slice(0, 300) } : {}),
        ...(fixed !== undefined ? { default: fixed } : {}),
        ...(paging ? {} : { role: "filter" as const }),
        value: fixed,
      });
      if (paging) continue;
      let cursor = template;
      for (const step of path) {
        if (!isObject(cursor[step])) cursor[step] = {};
        cursor = cursor[step] as Record<string, unknown>;
      }
      cursor[key] = `{{param.${dotted}}}`;
    }
  };
  walk(schema, [], 0);

  const title = str(operation.summary) ?? str(operation.operationId) ?? rawPath;
  return {
    body: { type: "json", template },
    params,
    readSafety: declared
      ? { basis: "spec-declared", note: "The specification marks it read-only." }
      : { basis: "docs-inferred", note: `Named “${title.slice(0, 120)}”, and answers with a list of records.` },
  };
};

/** Where a response states how many records match in all, when its schema has a count beside the list. */
const totalPathOf = (doc: Json, schema: unknown): string | undefined => {
  const TOTAL = /^(total|total_?count|totalCount|total_?results|total_?items|total_?entries)$/i;
  const walk = (node: unknown, path: string, depth: number): string | undefined => {
    const object = deref(doc, node);
    if (!isObject(object) || !isObject(object.properties) || depth > 2) return undefined;
    for (const [key, raw] of Object.entries(object.properties)) {
      const property = deref(doc, raw);
      if (TOTAL.test(key) && isObject(property) && (property.type === "integer" || property.type === "number"))
        return `${path}.${key}`;
    }
    for (const [key, raw] of Object.entries(object.properties)) {
      const found = walk(raw, `${path}.${key}`, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(schema, "$", 0);
};

/** What a success response is declared as, when it is declared as something other than JSON. */
const responseGap = (doc: Json, operation: Json): CapabilityId | null => {
  let types: string[] = [];
  if (specVersionOf(doc) === 2) {
    const produces = Array.isArray(operation.produces) ? operation.produces : doc.produces;
    types = Array.isArray(produces) ? produces.map(String) : [];
  } else {
    const responses = isObject(operation.responses) ? operation.responses : {};
    for (const code of ["200", "201", "2XX", "default"]) {
      const response = deref(doc, responses[code]);
      if (isObject(response) && isObject(response.content)) {
        types = Object.keys(response.content);
        break;
      }
    }
  }
  if (types.length === 0) return null;
  const lowered = types.map((type) => type.toLowerCase());
  const lines = (type: string) => /nd-?json|jsonl|json-seq/.test(type);
  if (lowered.some((type) => /json/.test(type) && !lines(type)) || lowered.includes("*/*")) return null;
  if (lowered.some(lines)) return "response.ndjson";
  if (lowered.includes("text/event-stream")) return "transport.stream";
  if (lowered.some((type) => /csv|tab-separated|tsv/.test(type))) return "response.csv";
  if (lowered.some((type) => /xml/.test(type))) return "response.xml";
  if (lowered.every((type) => type.startsWith("text/plain"))) return null;
  return "response.binary";
};

/** The first `$ref` pointing into another file, if the document has any. */
const externalRef = (doc: Json): string | null => {
  let budget = 200_000;
  const walk = (node: unknown): string | null => {
    if (--budget < 0) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    if (!isObject(node)) return null;
    const ref = node.$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) return ref;
    for (const value of Object.values(node)) {
      const found = walk(value);
      if (found) return found;
    }
    return null;
  };
  return walk(doc);
};

/**
 * The OAuth flow a scheme declares that the broker can run, as a connection's
 * sign-in: client credentials first (nobody has to be there), then signing in
 * with the provider. Swagger 2 names them `application` and `accessCode`.
 * Addresses must be absolute; anything else is left for a pasted token.
 */
const oauthFlowOf = (scheme: Json, keyRef: string): DialectAuth | null => {
  const absolute = (value: unknown): string | undefined => {
    const text = str(value);
    return text && /^https:\/\//i.test(text) ? text : undefined;
  };
  const scopesOf = (flow: Json): string[] =>
    isObject(flow.scopes) ? Object.keys(flow.scopes).slice(0, 50) : [];
  const refs = { clientIdRef: `${keyRef}-client`, clientSecretRef: `${keyRef}-secret`, keyRef: `${keyRef}-token` };

  const flows = isObject(scheme.flows) ? scheme.flows : {};
  const client = isObject(flows.clientCredentials)
    ? flows.clientCredentials
    : str(scheme.flow) === "application"
      ? scheme
      : undefined;
  const clientToken = client ? absolute(client.tokenUrl) : undefined;
  if (client && clientToken)
    return { type: "oauth2", flow: "client_credentials", tokenUrl: clientToken, scopes: scopesOf(client), pkce: true, clientAuth: "body", ...refs } as DialectAuth;

  const code = isObject(flows.authorizationCode)
    ? flows.authorizationCode
    : str(scheme.flow) === "accessCode"
      ? scheme
      : undefined;
  const authorizeUrl = code ? absolute(code.authorizationUrl) : undefined;
  const codeToken = code ? absolute(code.tokenUrl) : undefined;
  if (code && authorizeUrl && codeToken)
    return {
      type: "oauth2",
      flow: "authorization_code",
      authorizeUrl,
      tokenUrl: codeToken,
      scopes: scopesOf(code),
      pkce: true,
      clientAuth: "body",
      ...refs,
      refreshRef: `${keyRef}-refresh`,
    } as DialectAuth;
  return null;
};

const authFrom = (doc: Json, keyRef: string): DialectAuth => {
  const schemes = schemesOf(doc);

  /**
   * Rank the candidates rather than taking the first one declared.
   *
   * Plenty of specs offer both OAuth and an API key. OAuth needs a registered
   * app and a consent flow, neither of which exists yet, so a key the user can
   * actually paste in wins even when the spec lists OAuth first.
   */
  const candidates: Array<{ rank: number; auth: DialectAuth }> = [];

  /*
   * Which scheme the spec itself says to use.
   *
   * Top-level `security` is the document naming its own default, and it beats
   * any ranking we could invent. Aptly declares three schemes — an `x-token`
   * header, a delegate token and a partner bearer — with
   * `security: [{ApiKeyHeader: []}]` singling out the first. Ranking by type
   * alone picked the bearer and would have failed every request.
   *
   * A bonus rather than an override, so the reasoning below still applies:
   * a declared OAuth scheme should still lose to an API key someone can paste.
   */
  const declared = new Set<string>();
  const requirements = Array.isArray(doc.security) ? doc.security : [];
  if (
    Array.isArray(doc.security) &&
    (requirements.length === 0 ||
      requirements.some((entry) => isObject(entry) && Object.keys(entry).length === 0))
  )
    return { type: "none" };
  // Each object is an AND requirement; the array contains alternatives.
  // Preserve every required header instead of choosing one and losing the rest.
  for (const requirement of requirements) {
    if (!isObject(requirement) || Object.keys(requirement).length < 2) continue;
    /* A signature and a key in a header beside it: API Gateway's metered APIs ask for both. */
    const required = Object.keys(requirement).map((schemeName) => deref(doc, schemes[schemeName]));
    const beside = required.filter((scheme) => !(isObject(scheme) && awsSigned(scheme)));
    if (required.length === 2 && beside.length === 1) {
      const key = beside[0];
      if (isObject(key) && str(key.type)?.toLowerCase() === "apikey" && str(key.in)?.toLowerCase() === "header" && str(key.name))
        return {
          type: "sigv4",
          accessKeyRef: `${keyRef}-access`,
          keyRef,
          apiKey: { header: str(key.name)!, keyRef: `${keyRef}-api` },
        };
    }
    const parts: Array<{ header: string; keyRef: string; template?: string; in?: "query" | "cookie" }> = [];
    for (const [index, schemeName] of Object.keys(requirement).entries()) {
      const scheme = deref(doc, schemes[schemeName]);
      if (!isObject(scheme) || awsSigned(scheme)) break;
      const where = str(scheme.in)?.toLowerCase();
      if (
        str(scheme.type)?.toLowerCase() === "apikey" &&
        (where === "header" || where === "query" || where === "cookie") &&
        str(scheme.name)
      ) {
        /* Wherever each key goes: a header, the query string, a cookie. */
        parts.push({
          header: str(scheme.name)!,
          keyRef: `${keyRef}-${index + 1}`,
          ...(where === "header" ? {} : { in: where }),
        });
      } else if (str(scheme.type) === "http" && str(scheme.scheme) === "bearer") {
        parts.push({
          header: "Authorization",
          template: "Bearer {{key}}",
          keyRef: `${keyRef}-${index + 1}`,
        });
      }
    }
    if (parts.length === Object.keys(requirement).length) return { type: "headers", parts };
  }
  for (const requirement of requirements) {
    if (isObject(requirement)) for (const name of Object.keys(requirement)) declared.add(name);
  }
  const DECLARED_BONUS = 5;

  for (const [name_, raw] of Object.entries(schemes)) {
    if (
      requirements.length > 0 &&
      !requirements.some(
        (entry) => isObject(entry) && Object.keys(entry).length === 1 && name_ in entry,
      )
    )
      continue;
    const preferred = declared.has(name_) ? DECLARED_BONUS : 0;
    const scheme = deref(doc, raw);
    if (!isObject(scheme)) continue;
    /* A token the API's own login issues is not a key to ask anybody for. See `issuedByLogin`. */
    if (schemeGap(scheme, doc) === "auth.token-exchange") continue;
    const type = str(scheme.type)?.toLowerCase();
    const inWhere = str(scheme.in)?.toLowerCase();
    const name = str(scheme.name);

    // Swagger 2.0 names Basic as its own type rather than an http scheme.
    const httpScheme = type === "basic" ? "basic" : str(scheme.scheme)?.toLowerCase();
    if (type === "http" || type === "basic") {
      if (httpScheme === "bearer") {
        candidates.push({ rank: 0 - preferred, auth: { type: "bearer", keyRef } });
      }
      if (httpScheme === "basic") {
        /* Both halves are the person's to enter — see `authSchema`. */
        candidates.push({
          rank: 3 - preferred,
          auth: { type: "basic", usernameRef: `${keyRef}-user`, keyRef },
        });
      }
      /* HTTP Digest: the same two values, answered to the server's challenge. */
      if (httpScheme === "digest") {
        candidates.push({
          rank: 3 - preferred,
          auth: { type: "basic", digest: true, usernameRef: `${keyRef}-user`, keyRef },
        });
      }
    }
    /* Signed for AWS: two values the person holds, and a signature made here. The address names the region. */
    if (awsSigned(scheme)) {
      candidates.push({ rank: 1 - preferred, auth: { type: "sigv4", accessKeyRef: `${keyRef}-access`, keyRef } });
      continue;
    }
    // Swagger 2.0 spells apiKey the same way, so this covers both versions.
    if (type === "apikey" && name) {
      if (inWhere === "header") {
        candidates.push({ rank: 1 - preferred, auth: { type: "header", header: name, keyRef } });
      }
      if (inWhere === "query") {
        candidates.push({ rank: 2 - preferred, auth: { type: "query", param: name, keyRef } });
      }
      /* A key sent in a cookie: one part of the several-keys sign-in, sent there. */
      if (inWhere === "cookie") {
        candidates.push({ rank: 2 - preferred, auth: { type: "headers", parts: [{ header: name, keyRef, in: "cookie" }] } });
      }
    }
    if (type === "oauth2") {
      /*
       * A flow the broker can run becomes a real OAuth connection: signed in
       * once (or, for client credentials, never), renewed by itself. Still
       * ranked after a key somebody can simply paste, since OAuth also needs
       * an app registered with the provider. Only a flow nothing here can run
       * — implicit, password — falls back to a pasted token.
       */
      const flow = oauthFlowOf(scheme, keyRef);
      candidates.push(
        flow ? { rank: 8 - preferred, auth: flow } : { rank: 9 - preferred, auth: { type: "bearer", keyRef } },
      );
    }
  }

  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.auth ?? { type: "none" };
};

/** The schema of a 2xx JSON response body, with refs resolved. */
const successSchema = (doc: Json, operation: Json): Json | undefined => {
  const responses = isObject(operation.responses) ? operation.responses : {};
  for (const code of ["200", "201", "2XX", "default"]) {
    const response = deref(doc, responses[code]);
    if (!isObject(response)) continue;

    if (specVersionOf(doc) === 2) {
      const schema = deref(doc, response.schema);
      if (isObject(schema)) return schema;
      continue;
    }
    const content = isObject(response.content) ? response.content : {};
    for (const [mime, entry] of Object.entries(content)) {
      if (!mime.includes("json") || !isObject(entry)) continue;
      const schema = deref(doc, entry.schema);
      if (isObject(schema)) return schema;
    }
  }
  return undefined;
};

/** A key that names a wrapper around an answer's content, not a field of a record. */
export const ENVELOPE_KEY = /^(_embedded|data|result|results|response|payload|body|content|d)$/i;

/**
 * Where the rows live, read from the declared response schema.
 *
 * A bare array is the rows; an object with exactly one array property is the
 * classic envelope. Anything else is treated as a summary rather than guessed
 * at — the sample step will show the user what actually came back.
 *
 * `single` is what stops that envelope rule from eating a record. An endpoint
 * whose path ends in a parameter returns **one** of something, and one of
 * something routinely contains exactly one array — a vendor with its phone
 * numbers, a board member with theirs. Read as an envelope, the phone numbers
 * became the rows: the field list was `Number` and `Type`, the record page
 * bound fields no row had and refused to draw at all, and the runtime's
 * extract step would have returned a vendor's phone numbers in place of the
 * vendor. Two of a real API's 108 record types were exactly this.
 */
const shapeOf = (
  doc: Json,
  schema: Json | undefined,
  single: boolean,
): { archetype: "list" | "summary"; rowsPath?: string } => {
  if (!schema) return { archetype: "summary" };

  if (str(schema.type) === "array") return { archetype: "list", rowsPath: "$" };

  const properties = isObject(schema.properties) ? schema.properties : null;
  if (!properties) return { archetype: "summary" };

  /*
   * One record is the row. Never an envelope, whatever it happens to contain.
   */
  if (single) return { archetype: "summary", rowsPath: "$" };

  const arrayProps = Object.entries(properties).filter(([, value]) => {
    const resolved = deref(doc, value);
    return isObject(resolved) && str(resolved.type) === "array";
  });

  if (arrayProps.length === 1) {
    return { archetype: "list", rowsPath: `$.${arrayProps[0]![0]}` };
  }
  if (arrayProps.length > 1) {
    // Prefer a conventional name when several arrays are on offer.
    const preferred = ["data", "items", "results", "records", "rows", "hits"];
    const match = arrayProps.find(([name]) => preferred.includes(name));
    if (match) return { archetype: "list", rowsPath: `$.${match[0]}` };
  }
  /*
   * An envelope inside an envelope: HAL's `_embedded.vehicles`, OData's
   * `d.results`, a `data.items`. Only under a key that names a wrapper, and
   * only where it holds exactly one list — a record's own nested object with
   * a list in it is still a record. Read as one record, 214 vehicles were
   * eight: one per page (2026-09-30).
   */
  if (arrayProps.length === 0) {
    for (const [name, value] of Object.entries(properties)) {
      const container = deref(doc, value);
      if (!ENVELOPE_KEY.test(name) || !isObject(container) || !isObject(container.properties)) continue;
      const inner = Object.entries(container.properties).filter(([, entry]) => {
        const resolved = deref(doc, entry);
        return isObject(resolved) && str(resolved.type) === "array";
      });
      if (inner.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner[0]![0]))
        return { archetype: "list", rowsPath: `$.${name}.${inner[0]![0]}` };
    }
  }
  return { archetype: "summary" };
};

/** A spec parameter, kept whole rather than reduced to a seed value. */
interface ImportedParam extends ParamDef {
  /** The default/example/enum value used to seed a required query param. */
  readonly value: string | number | boolean | undefined;
}

const SEARCH_PARAMS = ["q", "search", "query", "keyword", "keywords", "term", "filter", "text"];
const SORT_PARAMS = ["sort", "sort_by", "sortby", "order", "order_by", "orderby", "ordering"];

const scalar = (value: unknown): string | number | boolean | undefined =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;

const paramType = (schema: unknown): ParamDef["type"] => {
  const raw = isObject(schema) ? str(schema.type)?.toLowerCase() : undefined;
  const format = isObject(schema) ? str(schema.format)?.toLowerCase() : undefined;
  if (format === "date" || format === "date-time") return "date";
  if (raw === "integer" || raw === "number") return "number";
  if (raw === "boolean") return "boolean";
  if (raw === "array") return "array";
  return "string";
};

/**
 * What the parameter is *for*, in vendor-independent terms.
 *
 * Pagination stays deliberately unmapped: it is the dialect's job, declared
 * once per API, and duplicating it per op would give two places to disagree.
 */
const paramRole = (
  name: string,
  where: ParamDef["in"],
  type: ParamDef["type"],
): ParamDef["role"] | undefined => {
  const lower = name.toLowerCase();
  if (where === "path") return "id";

  /*
   * Which END of a range this is, checked before anything else about dates.
   *
   * Vendors run the words together as often as they separate them —
   * Buildium ships `lastupdatedfrom` and `lastupdatedto` — so a marker is
   * matched as a plain suffix too. Getting this wrong labels both ends
   * `rangeStart`, and a range with two starts silently filters nothing.
   */
  if (/\[lte\]$|(^|_)(end|to|before|until)(_|$)|(?:to|end|before|until)$/.test(lower)) {
    return "rangeEnd";
  }
  if (/\[gte\]$|(^|_)(start|from|after|since)(_|$)|(?:from|start|after|since)$/.test(lower)) {
    return "rangeStart";
  }
  for (const group of DATE_PARAMS) {
    if (group.names.some((candidate) => candidate === lower)) return "rangeStart";
  }
  if (SEARCH_PARAMS.includes(lower)) return "search";
  if (SORT_PARAMS.includes(lower)) return "sort";
  // A lone date with no directional marker is a lower bound by convention.
  if (type === "date") return "rangeStart";
  return undefined;
};

/**
 * Every parameter the spec declares for this operation.
 *
 * Path parameters are captured alongside query ones — an endpoint that takes
 * an id is the single most useful thing to know about an API, because it is
 * what makes a list row expandable into the record behind it.
 */
const operationParams = (
  doc: Json,
  operation: Json,
  pathItem: Json,
  /** Header names a sign-in scheme carries: those are the key, never a parameter. */
  signInHeaders: ReadonlySet<string> = new Set(["authorization"]),
): ImportedParam[] => {
  const collect = (raw: unknown): ImportedParam[] => {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): ImportedParam[] => {
      const parameter = deref(doc, entry);
      if (!isObject(parameter)) return [];

      const where = str(parameter.in)?.toLowerCase();
      if (where !== "query" && where !== "path" && where !== "header" && where !== "cookie") return [];

      const name = str(parameter.name);
      if (!name) return [];
      /*
       * A header or cookie parameter is an ordinary input — a version, an
       * account — and is kept. The one that carries the key is the auth
       * config's, and never becomes a field somebody is invited to fill in.
       */
      if (where === "header" && signInHeaders.has(name.toLowerCase())) return [];

      // Swagger 2.0 puts the type inline; 3.x nests it under `schema`.
      const schema = isObject(parameter.schema) ? deref(doc, parameter.schema) : parameter;

      /*
       * `deepObject` writes an object as `filter[account]=4000`. Each property
       * becomes its own query parameter under that name, which is exactly
       * what is sent and needs no serialiser of its own.
       */
      if (where === "query" && str(parameter.style) === "deepObject" && isObject(schema) && isObject(schema.properties)) {
        return Object.entries(schema.properties).flatMap(([property, raw]): ImportedParam[] => {
          const inner = deref(doc, raw);
          const innerDefault = isObject(inner) ? scalar(inner.default) : undefined;
          return [
            {
              name: `${name}[${property}]`,
              in: "query",
              type: paramType(inner),
              required: false,
              ...(isObject(inner) && str(inner.description)
                ? { description: str(inner.description)!.slice(0, 300) }
                : {}),
              ...(innerDefault !== undefined ? { default: innerDefault } : {}),
              role: "filter",
              value: innerDefault,
            },
          ];
        });
      }
      const enumValues = (isObject(schema) && Array.isArray(schema.enum) ? schema.enum : [])
        .map(scalar)
        .filter((value): value is string | number | boolean => value !== undefined);

      /* A header allowed exactly one value — a version, usually — is sent with it. */
      const onlyValue = where !== "query" && where !== "path" && enumValues.length === 1 ? enumValues[0] : undefined;
      const declaredDefault = (isObject(schema) ? scalar(schema.default) : undefined) ?? onlyValue;
      const declaredExample =
        scalar(parameter.example) ?? (isObject(schema) ? scalar(schema.example) : undefined);
      const type = paramType(schema);
      const required = where === "path" || parameter.required === true;
      const style = str(parameter.style);
      const listStyle =
        type === "array" && (style === "form" || style === "spaceDelimited" || style === "pipeDelimited")
          ? style
          : undefined;

      return [
        {
          name,
          in: where,
          type,
          required,
          ...(listStyle ? { style: listStyle } : {}),
          ...(type === "array" && typeof parameter.explode === "boolean" ? { explode: parameter.explode } : {}),
          ...(str(parameter.description)
            ? { description: str(parameter.description)!.slice(0, 300) }
            : {}),
          ...(enumValues.length > 0 ? { enum: enumValues.slice(0, 50) } : {}),
          ...(declaredDefault !== undefined ? { default: declaredDefault } : {}),
          ...(declaredExample !== undefined ? { example: declaredExample } : {}),
          ...(paramRole(name, where, type) ? { role: paramRole(name, where, type) } : {}),
          value: declaredDefault ?? declaredExample ?? enumValues[0],
        },
      ];
    });
  };
  return [...collect(pathItem.parameters), ...collect(operation.parameters)];
};

const CURSOR_PARAMS = ["cursor", "starting_after", "after", "page_token", "next_cursor", "next"];
const PAGE_PARAMS = ["page", "page_number", "pagenum"];
const OFFSET_PARAMS = ["offset", "skip", "start"];
const LIMIT_PARAMS = [
  "limit",
  "per_page",
  "page_size",
  "pagesize",
  "count",
  "hitsperpage",
  "max_results",
];

/*
 * Parameters that window records by when they happened. Not `since` or
 * `updated_after`: on most APIs those select records *changed* since a time,
 * and a total read through one counts only what was edited lately — a
 * catalogue of 194 products read as 33 (measurement 1). Those suit keeping a
 * copy up to date, and are said so rather than installed; see
 * `CHANGED_SINCE`.
 */
const DATE_PARAMS: ReadonlyArray<{ names: string[]; format: "unix" | "iso" | "date" }> = [
  { names: ["created[gte]", "created_at[gte]", "since_ts", "start_time"], format: "unix" },
  {
    names: ["start_date", "from", "created_after", "start"],
    format: "iso",
  },
  { names: ["date_from", "start_day"], format: "date" },
];

/** What closes the range each of those opens, where an API declares it. */
const RANGE_END: Readonly<Record<string, readonly string[]>> = {
  "created[gte]": ["created[lt]", "created[lte]"],
  "created_at[gte]": ["created_at[lt]", "created_at[lte]"],
  since_ts: ["until_ts"],
  start_time: ["end_time"],
  start_date: ["end_date"],
  from: ["to"],
  created_after: ["created_before"],
  start: ["end"],
};

/** A parameter that selects records changed since a time, not records that happened in one. */
export const CHANGED_SINCE = /^(since|updated|modified|changed)$|(updated|modified|changed|edited)[_-]?(after|since|from|gte|\[gte\])|(updated|modified|changed)_?at\[?gte|^last_?(modified|updated|changed)/i;

const pick = (names: readonly string[], candidates: readonly string[]): string | undefined =>
  candidates.find((candidate) => names.some((name) => name.toLowerCase() === candidate));

/**
 * Infer the dialect from the query parameters the spec declares.
 *
 * This is a proposal, never a conclusion: pagination that is guessed wrong
 * does not error, it silently returns page one. The UI marks the result
 * unverified until a real request proves it.
 */
const dialectFromParams = (
  names: readonly string[],
): { pagination: DialectPagination; timeFilter?: DialectTimeFilter; warnings: string[] } => {
  const warnings: string[] = [];
  const lower = names.map((name) => name.toLowerCase());

  const original = (candidates: readonly string[]) => {
    const found = pick(lower, candidates);
    return names.find((name) => name.toLowerCase() === found);
  };
  const cursor = original(CURSOR_PARAMS);
  const page = original(PAGE_PARAMS);
  const offset = original(OFFSET_PARAMS);
  const limit = original(LIMIT_PARAMS);

  let pagination: DialectPagination;
  if (cursor) {
    // The cursor's *source* cannot be read from a spec — only the request
    // parameter is declared, never which response field feeds it.
    pagination = { kind: "cursor", cursorPath: "$.next_cursor", param: cursor };
    warnings.push(
      `Found a "${cursor}" parameter, so this API is probably cursor-paginated. A spec never says which response field holds the next cursor — check "cursorPath" against a real response.`,
    );
  } else if (offset && limit) {
    pagination = { kind: "offset", param: offset, limitParam: limit, pageSize: 100 };
  } else if (page) {
    pagination = {
      kind: "page",
      param: page,
      startsAt: 1,
      ...(limit ? { limitParam: limit, pageSize: 100 } : {}),
    };
  } else {
    pagination = { kind: "none" };
  }

  let timeFilter: DialectTimeFilter | undefined;
  for (const group of DATE_PARAMS) {
    const match = pick(lower, group.names);
    if (match) {
      const original = names.find((name) => name.toLowerCase() === match)!;
      /*
       * The other end of the range, where the API declares one beside it. Only
       * for a moment in time: "now" is the same end whether the API includes
       * it or not, while a date that excludes its last day would drop today.
       */
      const other = group.format === "date" ? undefined : RANGE_END[match]?.find((name) => lower.includes(name));
      const endParam = other ? names.find((name) => name.toLowerCase() === other) : undefined;
      timeFilter = { param: original, ...(endParam ? { endParam } : {}), format: group.format };
      break;
    }
  }
  const changedSince = names.find((name) => CHANGED_SINCE.test(name));
  if (!timeFilter && changedSince)
    warnings.push(
      `"${changedSince}" selects records changed since a time, so it is not used as a board's time window: a total read through it would count only what was edited lately.`,
    );

  return { pagination, ...(timeFilter ? { timeFilter } : {}), warnings };
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "api";

const opId = (path: string, operationId: string | undefined): string => {
  const base = operationId ?? path;
  return (
    base
      .replace(/\{[^}]*\}/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "op"
  );
};

/** OpenAPI path templating (`{id}`) becomes a Dash filter token. */
const templatePath = (path: string): string =>
  path.replace(
    /\{([^}]+)\}/g,
    (_m, name: string) => `{{param.${String(name).replace(/[^a-zA-Z0-9_]/g, "_")}}}`,
  );

/*
 * There is no op cap.
 *
 * There used to be one, at 40, and it did more damage than truncation: it took
 * an arbitrary slice of the document, so a collection could be dropped while
 * its own sub-collections were kept. On a real 230-endpoint API that left
 * `/v1/rentals/units/{unitId}/listing` imported with no `/v1/rentals/units`
 * to hang it from — an endpoint nobody could reach, describing a resource
 * nobody could see.
 *
 * The relation model reads structure out of the *whole* set of paths: a parent
 * is recognised because its child's path contains it. A partial import does
 * not give a smaller graph, it gives a broken one. Import everything; making
 * a long list manageable is a presentation problem, and belongs in the UI.
 */

export interface ParseOpenApiOptions {
  /**
   * Called with the schema issues when a document parses but the entry it
   * produces is rejected.
   *
   * Returning a bare `null` is fine for a single spec — the ladder just moves
   * on. It is not fine after merging a few hundred documentation pages: a
   * caps violation (`resources` is capped at 200, `relations` at 40 apiece)
   * would throw away a minute of paced fetching with nothing to show and no
   * way to tell the user which knob to turn.
   */
  readonly onReject?: (issues: readonly z.ZodIssue[]) => void;
}

export const parseOpenApi = (
  doc: unknown,
  specUrl: string,
  options: ParseOpenApiOptions = {},
): OpenApiResult | null => {
  if (!looksLikeOpenApi(doc) || !isObject(doc)) return null;

  const info = isObject(doc.info) ? doc.info : {};
  const title = str(info.title) ?? "Imported API";
  const id = slug(title);
  const address = addressFrom(doc, specUrl);
  if (!address) return null;
  const baseUrl = address.baseUrl;

  const warnings: string[] = [];
  if (address.guessed) {
    warnings.push(
      "The specification does not say where the API lives, so its address is a guess. It is asked for before connecting.",
    );
  } else if (servedFromDocument(doc)) {
    warnings.push(
      `The specification names no server, so requests go to the host that serves it (${baseUrl}), as the specification's own rules say.`,
    );
  }
  const keyRef = `${id}-key`;
  /*
   * The documentation's own words on getting in: shown beside the key fields,
   * and read for what it calls the two halves of a Basic login.
   */
  const keyHelp = authHelpFrom(doc);
  const labelled = (value: DialectAuth): DialectAuth =>
    value.type === "basic" ? { ...value, ...basicLabelsFrom(keyHelp) } : value;
  const auth = labelled(authFrom(doc, keyRef));
  /*
   * A client certificate (mutual TLS), where a requirement the API states
   * asks for one — alone, or beside a key.
   */
  const mutualTls = (() => {
    const schemes = schemesOf(doc);
    const named = Object.entries(schemes)
      .filter(([, raw]) => {
        const scheme = deref(doc, raw);
        return isObject(scheme) && str(scheme.type)?.toLowerCase() === "mutualtls";
      })
      .map(([name]) => name);
    if (named.length === 0) return false;
    const requirements = Array.isArray(doc.security) ? doc.security.filter(isObject) : [];
    return requirements.length === 0 || requirements.some((entry) => named.some((name) => name in entry));
  })();
  // A spec that declares no scheme has not told us the API is public — most
  // business APIs omit the block and still require credentials. Record that a
  // key is needed without inventing where it goes.
  const explicitlyPublic =
    Array.isArray(doc.security) &&
    (doc.security.length === 0 ||
      doc.security.some((entry) => isObject(entry) && Object.keys(entry).length === 0));
  const authRequired = auth.type === "none" && !explicitlyPublic;
  /* Named when found, instead of carrying on as if there were nothing to say. */
  const gaps = authRequired || auth.type !== "none" ? signInGaps(doc, auth) : [];
  if (authRequired && gaps.length === 0) {
    warnings.push(
      "The specification does not declare a supported authentication setup. Confirm how this API authenticates before connecting.",
    );
  }
  warnings.push(...gaps);
  const reference = externalRef(doc);
  if (reference)
    warnings.push(
      capabilityNote(
        "discovery.external-ref",
        `This specification (it refers to ${reference.slice(0, 80)})`,
      ),
    );

  /* Headers a sign-in scheme carries: those are the key, not a missing parameter. */
  const signInHeaders = new Set<string>(["authorization"]);
  for (const raw of Object.values(schemesOf(doc))) {
    const scheme = deref(doc, raw);
    const name = isObject(scheme) && str(scheme.in)?.toLowerCase() === "header" ? str(scheme.name) : undefined;
    if (name) signInHeaders.add(name.toLowerCase());
  }
  /* Per-gap tallies across every read, said once at the end. */
  const unreadable = new Map<CapabilityId, number>();
  /* Paths whose POST is a read: not offered as a change. */
  const postReads = new Set<string>();

  const paths = isObject(doc.paths) ? doc.paths : {};
  const collectedParams: string[] = [];
  const ops: CatalogEntry["ops"] = [];
  let total = 0;
  const usedIds = new Set<string>();
  // Addresses some endpoints named for themselves that this connection cannot reach.
  const elsewhere = new Set<string>();

  /** An endpoint's own security, where it overrides the document's. */
  const endpointAuthOf = (
    operation: Json,
  ): { endpointAuth: DialectAuth | undefined; endpointNeedsSetup: boolean } => {
    /* Labelled like the top-level auth, so an endpoint that simply repeats
     * the document's own scheme compares equal to it and inherits it. */
    const override = Array.isArray(operation.security)
      ? labelled(authFrom({ ...doc, security: operation.security }, keyRef))
      : undefined;
    const endpointAuth =
      override && JSON.stringify(override) !== JSON.stringify(auth)
        ? labelled(
            authFrom(
              { ...doc, security: operation.security },
              `op-key-${fnv1a(JSON.stringify(operation.security))}`,
            ),
          )
        : override;
    const endpointNeedsSetup =
      endpointAuth?.type === "none" &&
      Array.isArray(operation.security) &&
      operation.security.length > 0 &&
      !operation.security.some((entry) => isObject(entry) && Object.keys(entry).length === 0);
    return { endpointAuth, endpointNeedsSetup };
  };

  for (const [rawPath, rawItem] of Object.entries(paths)) {
    const pathItem = deref(doc, rawItem);
    if (!isObject(pathItem)) continue;
    /*
     * Reads are GET — and POST only for an endpoint that reads with a body, a
     * search or a report (`postReadOf`), which then says why it is believed to
     * read. Everything else that is not a GET is a write, read below into its
     * own list.
     */
    for (const verb of ["get", "post"] as const) {
    const operation = deref(doc, pathItem[verb]);
    if (!isObject(operation)) continue;
    const postRead = verb === "post" ? postReadOf(doc, operation, rawPath) : null;
    if (verb === "post" && !postRead) continue;
    if (operation.deprecated === true) continue;
    total++;
    const located = operationPath(doc, rawPath, operation, pathItem, baseUrl, specUrl);
    if ("elsewhere" in located) {
      elsewhere.add(located.elsewhere);
      continue;
    }
    if (postRead) postReads.add(rawPath);

    const format = responseGap(doc, operation);
    /* A table of rows, a record a line and XML are read as they are; only a file of bytes is not. */
    if (format === "response.binary") unreadable.set(format, (unreadable.get(format) ?? 0) + 1);
    /* A stream of events is read for a window, each event a record. */
    const streams = format === "transport.stream";

    const params = [
      ...operationParams(doc, operation, pathItem, signInHeaders),
      ...(postRead?.params ?? []),
    ];
    // Dialect inference is about query conventions; a path segment named `id`
    // says nothing about how this API paginates.
    collectedParams.push(
      ...params.filter((param) => param.in === "query").map((param) => param.name),
    );

    // Seed the required parameters so the endpoint works when it is tested.
    // Pagination and date parameters are the dialect's job, not the op's.
    const reserved = new Set(
      [...CURSOR_PARAMS, ...PAGE_PARAMS, ...OFFSET_PARAMS, ...LIMIT_PARAMS].map((name) => name),
    );
    const query: Record<string, string | number | boolean> = {};
    for (const param of params) {
      if (param.in !== "query") continue;
      if (!param.required || param.value === undefined) continue;
      if (reserved.has(param.name.toLowerCase())) continue;
      query[param.name] = param.value;
    }
    // A path parameter with no value is not "unmet" in the same sense — it is
    // supplied per call (by a drill-down, say), not configured once.
    const unmet = params.filter(
      (param) =>
        param.in === "query" &&
        param.required &&
        param.value === undefined &&
        !reserved.has(param.name.toLowerCase()),
    );
    for (const param of unmet) {
      warnings.push(
        `"${str(operation.summary) ?? rawPath}" requires a "${param.name}" parameter that the spec gives no example for — set it before using this endpoint.`,
      );
    }

    const responseSchema = successSchema(doc, operation);
    /*
     * A path ending in a parameter returns one of something. That single fact
     * is what tells a record apart from an envelope, and it is right here.
     */
    const single = /\}\s*$/.test(rawPath.trim());
    const shape = shapeOf(doc, responseSchema, single);
    /*
     * The other 95% of the schema the line above already resolved.
     *
     * `shapeOf` derefs the response to find where the rows live and discards
     * everything else. Reading the field list out of the same node costs
     * nothing more and is the only way to know the shape of an endpoint that
     * cannot be called without an id — which is most of them.
     */
    const fields = fieldsFromSchema(responseSchema, (node) => deref(doc, node), shape.rowsPath);
    let identifier = opId(rawPath, str(operation.operationId));
    let suffix = 2;
    while (usedIds.has(identifier))
      identifier = `${opId(rawPath, str(operation.operationId))}_${suffix++}`;
    usedIds.add(identifier);

    /*
     * The prose the spec author wrote, kept.
     *
     * `summary` becomes the title, and `description` used to be dropped — which
     * mattered more than it looks. On an API where every summary is "Retrieve
     * all X", the description is the only thing that distinguishes one endpoint
     * from another, and the assistant choosing between 230 of them has nothing
     * else to go on.
     */
    const detail = plainText(str(operation.description));
    const { endpointAuth, endpointNeedsSetup } = endpointAuthOf(operation);
    if (endpointNeedsSetup)
      warnings.push(
        `"${str(operation.summary) ?? rawPath}" declares authentication that needs manual setup.`,
      );

    const totalPath = totalPathOf(doc, responseSchema);
    ops.push({
      ...(endpointAuth ? { auth: endpointAuth, authRequired: endpointNeedsSetup } : {}),
      id: identifier,
      method: postRead ? "POST" : "GET",
      ...(postRead ? { body: postRead.body, readSafety: postRead.readSafety } : {}),
      title: str(operation.summary) ?? str(operation.operationId) ?? rawPath,
      ...(detail ? { description: detail.slice(0, 400) } : {}),
      ...(fields.length > 0 ? { fields } : {}),
      path: templatePath(located.path),
      /*
       * One record per line, or per row: a collection, whatever its schema
       * says (usually just "string"). Read as one summary, it was never a
       * resource, so its records could never be asked for (measurement 1).
       */
      ...(streams ? { stream: { events: 100, seconds: 5 } } : {}),
      ...(format === "response.ndjson" || format === "response.csv" || streams
        ? { archetype: "list" as const, rowsPath: "$" }
        : format === "response.xml" && !single
          ? /*
             * XML names no list in a way a schema here is read for: a
             * collection's address is a collection, and where its records are
             * is found by reading it (`rowsStrategy`).
             */
            { archetype: "list" as const }
          : { archetype: shape.archetype, ...(shape.rowsPath ? { rowsPath: shape.rowsPath } : {}) }),
      ...(totalPath ? { totalPath } : {}),
      // Strip the seeding-only field; the rest is the declared contract.
      params: params.map(({ value: _seed, ...param }) => param),
      query,
    });
    }
  }

  if (ops.length === 0) return null;

  const endpoints = (count: number) => `${count} endpoint${count === 1 ? "" : "s"}`;
  for (const [format, count] of unreadable) warnings.push(capabilityNote(format, endpoints(count)));
  if (postReads.size > 0)
    warnings.push(
      `${endpoints(postReads.size)} read${postReads.size === 1 ? "s" : ""} with POST — a search or a report. ${postReads.size === 1 ? "It is" : "They are"} read only while somebody is looking, never in the background, and never retried.`,
    );

  /*
   * The endpoints that change things, read after every read id is taken so
   * that adding them can never rename a GET a binding already uses. Their ids
   * are their own namespace; nothing that names an op can name one of these.
   */
  const writes = writeOpsFrom(doc, paths, endpointAuthOf, (rawPath, operation, pathItem, verb) => {
    // A POST that reads is a read, never offered as a change.
    if (verb === "post" && postReads.has(rawPath)) return { elsewhere: "read" };
    const located = operationPath(doc, rawPath, operation, pathItem, baseUrl, specUrl);
    if ("elsewhere" in located) elsewhere.add(located.elsewhere);
    return located;
  });
  elsewhere.delete("read");
  if (elsewhere.size > 0)
    warnings.push(
      `Some endpoints are served from another address (${[...elsewhere].slice(0, 3).join(", ")}) and were left out: a connection reads from one address.`,
    );
  if (writes.truncated.length > 0) {
    const named = writes.truncated.slice(0, 3).join(", ");
    const more = writes.truncated.length > 3 ? ", and others" : "";
    warnings.push(
      `Some request bodies were too large to read whole (${named}${more}); their longest field or value lists were cut.`,
    );
  }

  // Say how big it is rather than letting the number be a surprise later.
  if (ops.length > 60) {
    warnings.push(
      `This API declares ${ops.length} readable endpoints, and all of them were imported.`,
    );
  }

  const inferred = dialectFromParams(collectedParams);
  warnings.push(...inferred.warnings);
  /*
   * The time range is sent only where the endpoint takes it. One parameter
   * found anywhere in the specification was sent to every list, and an
   * endpoint that never declared it was asked for a window it cannot give.
   * Both ends only where every endpoint that takes the start takes the end.
   */
  const timeFilter = (() => {
    const found = inferred.timeFilter;
    if (!found) return undefined;
    const takes = (op: (typeof ops)[number], name: string) => op.params.some((param) => param.in === "query" && param.name === name);
    for (const [index, op] of ops.entries())
      if (!takes(op, found.param)) ops[index] = { ...op, timeFiltered: false };
    const everywhere = found.endParam !== undefined && ops.every((op) => !takes(op, found.param) || takes(op, found.endParam!));
    const { endParam, ...start } = found;
    return everywhere && endParam ? found : start;
  })();
  if (inferred.pagination.kind !== "none")
    warnings.push(
      "Pagination is an unconfirmed suggestion. Only one response will be read until an endpoint's pagination contract is configured.",
    );

  const parsed = catalogEntrySchema.safeParse({
    id,
    title,
    baseUrl,
    ...(address.server ? { server: address.server } : {}),
    ...(address.guessed ? { baseUrlGuessed: true } : {}),
    ...(keyHelp ? { keyHelp } : {}),
    ...(mutualTls ? { clientCertificate: { certRef: `${keyRef}-cert`, keyRef: `${keyRef}-cert-key` } } : {}),
    dialect: {
      auth,
      pagination: { kind: "none" },
      ...(timeFilter ? { timeFilter } : {}),
    },
    ops,
    writes: writes.ops,
    writesVersion: WRITES_VERSION,
    ...(inferred.pagination.kind !== "none" ? { paginationProposal: inferred.pagination } : {}),
    resources: deriveResources(ops),
    /*
     * The validation endpoint must be one that can actually be called with no
     * further input. An op whose path still contains `{{param.x}}` sends that
     * placeholder literally and comes back 404 — which reads as "your key is
     * wrong" when the key was fine all along. Prefer a parameter-free path.
     *
     * Left unset when nothing qualifies. The old fallbacks to "any list op"
     * and then "the first op" defeated the point — on a merged set of mostly
     * detail pages they reliably chose a path with a live placeholder in it.
     * No validation endpoint is a better answer than one that cannot work.
     */
    validateOpId:
      ops.find((op) => op.archetype === "list" && !PATH_PARAM.test(op.path))?.id ??
      ops.find((op) => !PATH_PARAM.test(op.path))?.id,
    ...(str(info.termsOfService) ? {} : {}),
    /*
     * Where this came from, so the field schemas can be re-read later.
     *
     * The URL was always in hand here and simply never written down, and the
     * cost of that showed up much later: fields come from the import while
     * relations come from the mapping pass, and the only way to refresh the
     * first was to replace the whole entry — which discarded the second. An
     * entry that cannot say where it came from can only be rebuilt, never
     * corrected, so every improvement to the importer was unreachable for
     * every API already imported.
     */
    specUrl,
    authRequired,
    origin: "openapi",
    importVersion: IMPORT_VERSION,
    // A spec is a description, not a proof. Only a real request flips this.
    verified: false,
  });

  if (!parsed.success) {
    options.onReject?.(parsed.error.issues);
    return null;
  }
  return { entry: parsed.data, warnings, totalOperations: total, totalWrites: writes.ops.length };
};

const WRITE_VERBS = ["post", "put", "patch", "delete"] as const;

/**
 * Every create, update, delete and action endpoint in a document.
 *
 * Kept whole, including ones no form can build — a multipart upload, a body
 * that is a list — so they are known about and marked, rather than missing
 * and wondered about.
 */
export const writeOpsFrom = (
  doc: Json,
  paths: Json,
  endpointAuthOf: (operation: Json) => {
    endpointAuth: DialectAuth | undefined;
    endpointNeedsSetup: boolean;
  },
  /** Where each operation lives; absent means at its own path. See `operationPath`. */
  locate: (
    rawPath: string,
    operation: Json,
    pathItem: Json,
    verb: string,
  ) => { path: string } | { elsewhere: string } = (rawPath) => ({ path: rawPath }),
): { ops: WriteOpDef[]; truncated: string[] } => {
  const ops: WriteOpDef[] = [];
  const truncated: string[] = [];
  const used = new Set<string>();

  for (const [rawPath, rawItem] of Object.entries(paths)) {
    const pathItem = deref(doc, rawItem);
    if (!isObject(pathItem)) continue;
    for (const verb of WRITE_VERBS) {
      const operation = deref(doc, pathItem[verb]);
      if (!isObject(operation) || operation.deprecated === true) continue;
      const located = locate(rawPath, operation, pathItem, verb);
      if ("elsewhere" in located) continue;

      const base = opId(rawPath, str(operation.operationId));
      let id = used.has(base) ? `${verb}_${base}` : base;
      let suffix = 2;
      while (used.has(id)) id = `${verb}_${base}_${suffix++}`;
      used.add(id);

      const params = operationParams(doc, operation, pathItem).map(
        ({ value: _seed, ...param }) => param,
      );
      const title =
        str(operation.summary) ?? str(operation.operationId) ?? `${verb.toUpperCase()} ${rawPath}`;
      const body = requestBodyOf(doc, operation);
      if (body?.truncated) truncated.push(title);
      const { endpointAuth, endpointNeedsSetup } = endpointAuthOf(operation);
      const detail = plainText(str(operation.description));

      const parsed = writeOpDefSchema.safeParse({
        id,
        title: title.slice(0, 200),
        ...(detail ? { description: detail.slice(0, 400) } : {}),
        method: verb.toUpperCase(),
        path: templatePath(located.path),
        params,
        ...(endpointAuth ? { auth: endpointAuth, authRequired: endpointNeedsSetup } : {}),
        ...(body ? { body: body.body } : {}),
        returns: returnsOf(doc, operation),
        confidence: "declared",
        verified: false,
      });
      if (parsed.success) ops.push(parsed.data);
    }
  }
  return { ops, truncated };
};

/** A request body's schema, from either spec version, read into fields. */
const requestBodyOf = (
  doc: Json,
  operation: Json,
): { body: WriteOpDef["body"]; truncated: boolean } | undefined => {
  const resolve = (node: unknown) => deref(doc, node);
  const read = (contentType: string, schema: unknown) => {
    const reading = bodyFieldsFromSchema(schema, resolve);
    return {
      body: {
        contentType,
        fields: reading.fields,
        ...(reading.unsupported ? { unsupported: reading.unsupported } : {}),
      },
      truncated: reading.truncated,
    };
  };

  // Swagger 2: a parameter `in: body`.
  if (specVersionOf(doc) === 2) {
    const raw = Array.isArray(operation.parameters) ? operation.parameters : [];
    const param = raw.map(resolve).find((entry) => isObject(entry) && entry.in === "body");
    if (!isObject(param)) return undefined;
    const consumes = Array.isArray(operation.consumes) ? operation.consumes.map(String) : [];
    const contentType = consumes.find(isJsonBody) ?? consumes[0] ?? "application/json";
    if (!isJsonBody(contentType)) {
      return { body: { contentType, fields: [], unsupported: contentType }, truncated: false };
    }
    return read(contentType, param.schema);
  }

  const requestBody = resolve(operation.requestBody);
  if (!isObject(requestBody) || !isObject(requestBody.content)) return undefined;
  const types = Object.keys(requestBody.content);
  const contentType = types.find(isJsonBody);
  if (!contentType) {
    const declared = types[0] ?? "unknown";
    return { body: { contentType: declared, fields: [], unsupported: declared }, truncated: false };
  }
  const media = requestBody.content[contentType];
  return read(contentType, isObject(media) ? media.schema : undefined);
};

/** What a success sends back: the record, nothing, or unsaid. */
const returnsOf = (doc: Json, operation: Json): WriteOpDef["returns"] => {
  const schema = successSchema(doc, operation);
  if (isObject(schema) && (isObject(schema.properties) || str(schema.type) === "object")) {
    return "record";
  }
  const responses = isObject(operation.responses) ? Object.keys(operation.responses) : [];
  const successes = responses.filter((code) => /^2/.test(code));
  if (successes.length > 0 && successes.every((code) => code === "204")) return "none";
  return "unknown";
};

/** Where specs conventionally live, tried against the URL's own origin. */
/** A path that still needs a value supplied before it can be called. */
export const PATH_PARAM = /\{\{param\./;

/**
 * Resource derivation now lives in `@freebirdai/dash-spec` alongside the resource model
 * itself, because the capabilities layer needs exactly the same rules and two
 * copies of "what counts as a resource" is how the two come to disagree.
 */
export const deriveResources = (ops: CatalogEntry["ops"]): CatalogEntry["resources"] =>
  deriveResourceModel(ops);

/**
 * Read a spec document, whichever of the two serialisations it arrived in.
 *
 * The bug this exists to end: the well-known probe below asks for
 * `/openapi.yaml` by name, and the caller then checked the reply with a
 * JSON-only parser. A real 153KB spec came back, failed `JSON.parse`, and was
 * discarded as if the path had 404'd — after which discovery fell all the way
 * through to a web search and offered a different company's API.
 *
 * YAML is a superset of JSON, so one call covers both; JSON is still tried
 * first because it is the common case and far cheaper to reject.
 */
export const parseSpecDocument = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    /* not JSON — fall through */
  }

  // A cheap gate before handing megabytes to the YAML parser: every OpenAPI
  // document declares its version at the top level, so the key must appear.
  if (!/^\s*(openapi|swagger)\s*:/m.test(text)) return null;

  try {
    return parseYaml(text, { maxAliasCount: 100 });
  } catch {
    // A malformed document is not a crash — the ladder simply moves on.
    return null;
  }
};

export const WELL_KNOWN_SPEC_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/api-docs",
  "/v3/api-docs",
  "/api/openapi.json",
  "/.well-known/openapi.json",
  "/swagger/v1/swagger.json",
] as const;

/**
 * Where this page says its own machine-readable index lives.
 *
 * `llms.txt` is a convention docs platforms adopted so automated readers stop
 * guessing, and the sites that publish one generally say so in the body:
 * "Fetch the complete documentation index at …". Guessing `${origin}/llms.txt`
 * only works when the docs sit at the root — HubSpot's is under `/docs/`, so
 * the root probe 404s while the page is telling us the answer in plain text.
 *
 * Returned in the order found, so the advertised location is tried before any
 * fallback the caller adds.
 */
export const indexLinksIn = (text: string, pageUrl: string): string[] => {
  const found = new Set<string>();
  // Absolute, or root-relative — both appear in the wild.
  for (const match of text.matchAll(
    /(?:https?:\/\/[^\s"'`<>()[\]]*|\/[^\s"'`<>()[\]]*)llms\.txt/gi,
  )) {
    try {
      found.add(new URL(match[0], pageUrl).toString());
    } catch {
      /* not a usable URL */
    }
  }
  return [...found].slice(0, 3);
};

/**
 * Spec links embedded in a documentation page.
 *
 * Quoted forms cover HTML attributes; the bare forms cover Markdown and plain
 * text, which is not a niche case — docs platforms increasingly content-negotiate
 * a `.md` rendering to non-browser clients, and a link that was an `<a href>`
 * in the browser arrives as bare prose to us. Aptly's page named its spec that
 * way and the HTML-only patterns walked straight past it.
 */
export const specLinksIn = (html: string, pageUrl: string): string[] => {
  const found = new Set<string>();
  const patterns = [
    /["'`]([^"'`\s]*(?:openapi|swagger)[^"'`\s]*\.(?:json|ya?ml))["'`]/gi,
    /["'`]([^"'`\s]*\/(?:api-docs|v3\/api-docs)[^"'`\s]*)["'`]/gi,
    // Unquoted, e.g. a Markdown link target or a URL sitting in a sentence.
    // Trailing punctuation is trimmed below rather than matched here.
    /\bhttps?:\/\/[^\s"'`<>()[\]]*(?:openapi|swagger)[^\s"'`<>()[\]]*\.(?:json|ya?ml)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      // The bare pattern has no capture group — the whole match is the URL.
      const raw = match[1] ?? match[0];
      // `.json).` at the end of a Markdown link or sentence is punctuation,
      // not part of the path.
      const candidate = raw.replace(/[).,;:\]]+$/, "");
      if (!candidate) continue;
      try {
        found.add(new URL(candidate, pageUrl).toString());
      } catch {
        /* not a usable URL */
      }
    }
  }
  return [...found].slice(0, 5);
};

/**
 * The header parameters a specification requires for the operation at a
 * path, with the value it documents where it documents exactly one.
 *
 * For the integration loop, which reads the specification again when an API
 * refuses a request for want of a header: a version header declared with one
 * allowed value is something a person should never be asked for.
 */
export const requiredHeadersFor = (
  doc: unknown,
  path: string,
  method = "get",
): Array<{ name: string; value?: string }> => {
  if (!isObject(doc) || !isObject(doc.paths)) return [];
  const shape = (value: string) => value.replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, "{}").replace(/\/+$/, "");
  const wanted = shape(path);
  const match = Object.entries(doc.paths).find(([candidate]) => {
    const one = shape(candidate);
    return one === wanted || wanted.endsWith(one) || one.endsWith(wanted);
  });
  if (!match) return [];
  const pathItem = deref(doc, match[1]);
  if (!isObject(pathItem)) return [];
  const operation = deref(doc, pathItem[method.toLowerCase()]);
  if (!isObject(operation)) return [];
  const found: Array<{ name: string; value?: string }> = [];
  for (const raw of [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ]) {
    const parameter = deref(doc, raw);
    if (!isObject(parameter) || str(parameter.in)?.toLowerCase() !== "header") continue;
    if (parameter.required !== true) continue;
    const name = str(parameter.name);
    if (!name) continue;
    const schema = isObject(parameter.schema) ? deref(doc, parameter.schema) : parameter;
    const enumValues = isObject(schema) && Array.isArray(schema.enum) ? schema.enum.map(scalar) : [];
    const documented =
      enumValues.length === 1
        ? enumValues[0]
        : (isObject(schema) ? scalar(schema.default) : undefined) ?? scalar(parameter.example);
    found.push({ name, ...(documented !== undefined ? { value: String(documented) } : {}) });
  }
  return found;
};
