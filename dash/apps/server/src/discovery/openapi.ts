import type { CatalogEntry, ParamDef } from "@freebirdai/dash-spec";
import { fieldsFromSchema } from "./schema-fields.js";
import { catalogEntrySchema, deriveResourceModel, pathParamNames } from "@freebirdai/dash-spec";
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
        if (Array.isArray(value)) required.push(...value.filter((entry) => typeof entry === "string"));
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
      if (Array.isArray(value)) required.push(...value.filter((entry) => typeof entry === "string"));
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

const baseUrlFrom = (doc: Json, specUrl: string): string | undefined => {
  if (specVersionOf(doc) === 2) {
    const host = str(doc.host);
    const basePath = str(doc.basePath) ?? "";
    const schemes = Array.isArray(doc.schemes) ? doc.schemes.map(String) : [];
    const scheme = schemes.includes("https") ? "https" : (schemes[0] ?? "https");
    if (host) return `${scheme}://${host}${basePath}`.replace(/\/+$/, "");
  } else {
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    for (const server of servers) {
      const url = isObject(server) ? str(server.url) : undefined;
      if (!url || url.includes("{")) continue; // templated server, unusable as-is
      if (/^https?:\/\//i.test(url)) return url.replace(/\/+$/, "");
      // A relative server URL is relative to where the spec was served from.
      try {
        return new URL(url, specUrl).toString().replace(/\/+$/, "");
      } catch {
        /* keep looking */
      }
    }
  }
  // Last resort: the spec's own origin.
  try {
    return new URL(specUrl).origin;
  } catch {
    return undefined;
  }
};

type DialectAuth = NonNullable<CatalogEntry["dialect"]["auth"]>;
type DialectPagination = NonNullable<CatalogEntry["dialect"]["pagination"]>;
type DialectTimeFilter = NonNullable<CatalogEntry["dialect"]["timeFilter"]>;

const authFrom = (doc: Json, keyRef: string): DialectAuth => {
  const schemes = specVersionOf(doc) === 2
    ? (isObject(doc.securityDefinitions) ? doc.securityDefinitions : {})
    : (isObject(doc.components) && isObject(doc.components.securitySchemes)
        ? doc.components.securitySchemes
        : {});

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
  for (const requirement of requirements) {
    if (isObject(requirement)) for (const name of Object.keys(requirement)) declared.add(name);
  }
  const DECLARED_BONUS = 5;

  for (const [name_, raw] of Object.entries(schemes)) {
    const preferred = declared.has(name_) ? DECLARED_BONUS : 0;
    const scheme = deref(doc, raw);
    if (!isObject(scheme)) continue;
    const type = str(scheme.type)?.toLowerCase();
    const inWhere = str(scheme.in)?.toLowerCase();
    const name = str(scheme.name);

    if (type === "http") {
      const httpScheme = str(scheme.scheme)?.toLowerCase();
      if (httpScheme === "bearer") {
        candidates.push({ rank: 0 - preferred, auth: { type: "bearer", keyRef } });
      }
      if (httpScheme === "basic") {
        candidates.push({ rank: 3 - preferred, auth: { type: "basic", username: "api", keyRef } });
      }
    }
    // Swagger 2.0 spells apiKey the same way, so this covers both versions.
    if (type === "apikey" && name) {
      if (inWhere === "header") {
        candidates.push({ rank: 1 - preferred, auth: { type: "header", header: name, keyRef } });
      }
      if (inWhere === "query") {
        candidates.push({ rank: 2 - preferred, auth: { type: "query", param: name, keyRef } });
      }
    }
    if (type === "oauth2") {
      candidates.push({ rank: 9 - preferred, auth: { type: "bearer", keyRef } });
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

/**
 * Where the rows live, read from the declared response schema.
 *
 * A bare array is the rows; an object with exactly one array property is the
 * classic envelope. Anything else is treated as a summary rather than guessed
 * at — the sample step will show the user what actually came back.
 */
const shapeOf = (
  doc: Json,
  schema: Json | undefined,
): { archetype: "list" | "summary"; rowsPath?: string } => {
  if (!schema) return { archetype: "summary" };

  if (str(schema.type) === "array") return { archetype: "list", rowsPath: "$" };

  const properties = isObject(schema.properties) ? schema.properties : null;
  if (!properties) return { archetype: "summary" };

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
  where: "path" | "query",
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
const operationParams = (doc: Json, operation: Json, pathItem: Json): ImportedParam[] => {
  const collect = (raw: unknown): ImportedParam[] => {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): ImportedParam[] => {
      const parameter = deref(doc, entry);
      if (!isObject(parameter)) return [];

      const where = str(parameter.in)?.toLowerCase();
      // Header and cookie params are not modelled: a secret belongs in the
      // auth config, not a per-op field the UI would invite someone to fill.
      if (where !== "query" && where !== "path") return [];

      const name = str(parameter.name);
      if (!name) return [];

      // Swagger 2.0 puts the type inline; 3.x nests it under `schema`.
      const schema = isObject(parameter.schema) ? deref(doc, parameter.schema) : parameter;
      const enumValues = (isObject(schema) && Array.isArray(schema.enum) ? schema.enum : [])
        .map(scalar)
        .filter((value): value is string | number | boolean => value !== undefined);

      const declaredDefault = isObject(schema) ? scalar(schema.default) : undefined;
      const declaredExample =
        scalar(parameter.example) ?? (isObject(schema) ? scalar(schema.example) : undefined);
      const type = paramType(schema);
      const required = where === "path" || parameter.required === true;

      return [
        {
          name,
          in: where,
          type,
          required,
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
const LIMIT_PARAMS = ["limit", "per_page", "page_size", "pagesize", "count", "hitsperpage", "max_results"];

const DATE_PARAMS: ReadonlyArray<{ names: string[]; format: "unix" | "iso" | "date" }> = [
  { names: ["created[gte]", "created_at[gte]", "since_ts", "start_time"], format: "unix" },
  { names: ["since", "start_date", "from", "created_after", "updated_after", "start"], format: "iso" },
  { names: ["date_from", "start_day"], format: "date" },
];

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

  const cursor = pick(lower, CURSOR_PARAMS);
  const page = pick(lower, PAGE_PARAMS);
  const offset = pick(lower, OFFSET_PARAMS);
  const limit = pick(lower, LIMIT_PARAMS);

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
    pagination = { kind: "page", param: page, startsAt: 1, ...(limit ? { limitParam: limit, pageSize: 100 } : {}) };
  } else {
    pagination = { kind: "none" };
  }

  let timeFilter: DialectTimeFilter | undefined;
  for (const group of DATE_PARAMS) {
    const match = pick(lower, group.names);
    if (match) {
      const original = names.find((name) => name.toLowerCase() === match)!;
      timeFilter = { param: original, format: group.format };
      break;
    }
  }

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
const templatePath = (path: string): string => path.replace(/\{([^}]+)\}/g, (_m, name: string) => `{{param.${String(name).replace(/[^a-zA-Z0-9_]/g, "_")}}}`);

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
  const baseUrl = baseUrlFrom(doc, specUrl);
  if (!baseUrl) return null;

  const warnings: string[] = [];
  const keyRef = `${id}-key`;
  const auth = authFrom(doc, keyRef);
  // A spec that declares no scheme has not told us the API is public — most
  // business APIs omit the block and still require credentials. Record that a
  // key is needed without inventing where it goes.
  const authRequired = auth.type === "none";
  if (authRequired) {
    warnings.push("This API needs an API key to function.");
  }

  const paths = isObject(doc.paths) ? doc.paths : {};
  const collectedParams: string[] = [];
  const ops: CatalogEntry["ops"] = [];
  let total = 0;
  const usedIds = new Set<string>();

  for (const [rawPath, rawItem] of Object.entries(paths)) {
    const pathItem = deref(doc, rawItem);
    if (!isObject(pathItem)) continue;
    // Read-only by construction: nothing but GET is ever imported.
    const operation = deref(doc, pathItem.get);
    if (!isObject(operation)) continue;
    if (operation.deprecated === true) continue;
    total++;

    const params = operationParams(doc, operation, pathItem);
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
    const shape = shapeOf(doc, responseSchema);
    /*
     * The other 95% of the schema the line above already resolved.
     *
     * `shapeOf` derefs the response to find where the rows live and discards
     * everything else. Reading the field list out of the same node costs
     * nothing more and is the only way to know the shape of an endpoint that
     * cannot be called without an id — which is most of them.
     */
    const fields = fieldsFromSchema(
      responseSchema,
      (node) => deref(doc, node),
      shape.rowsPath,
    );
    let identifier = opId(rawPath, str(operation.operationId));
    let suffix = 2;
    while (usedIds.has(identifier)) identifier = `${opId(rawPath, str(operation.operationId))}_${suffix++}`;
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

    ops.push({
      id: identifier,
      title: str(operation.summary) ?? str(operation.operationId) ?? rawPath,
      ...(detail ? { description: detail.slice(0, 400) } : {}),
      ...(fields.length > 0 ? { fields } : {}),
      path: templatePath(rawPath),
      archetype: shape.archetype,
      ...(shape.rowsPath ? { rowsPath: shape.rowsPath } : {}),
      // Strip the seeding-only field; the rest is the declared contract.
      params: params.map(({ value: _seed, ...param }) => param),
      query,
    });
  }

  if (ops.length === 0) return null;
  // Say how big it is rather than letting the number be a surprise later.
  if (ops.length > 60) {
    warnings.push(`This API declares ${ops.length} readable endpoints, and all of them were imported.`);
  }

  const inferred = dialectFromParams(collectedParams);
  warnings.push(...inferred.warnings);

  const parsed = catalogEntrySchema.safeParse({
    id,
    title,
    baseUrl,
    dialect: {
      auth,
      pagination: inferred.pagination,
      ...(inferred.timeFilter ? { timeFilter: inferred.timeFilter } : {}),
    },
    ops,
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
    // A spec is a description, not a proof. Only a real request flips this.
    verified: false,
  });

  if (!parsed.success) {
    options.onReject?.(parsed.error.issues);
    return null;
  }
  return { entry: parsed.data, warnings, totalOperations: total };
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
  for (const match of text.matchAll(/(?:https?:\/\/[^\s"'`<>()[\]]*|\/[^\s"'`<>()[\]]*)llms\.txt/gi)) {
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
