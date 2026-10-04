import type { CatalogEntry, ResourceSpec } from "@freebirdai/dash-spec";

/**
 * A GraphQL API, set up from its schema.
 *
 * A GraphQL API has one address, and every read is a query sent to it. What
 * the documentation calls its endpoints are the fields of its query type, and
 * which of them hold a list of records — and how they page — is written in the
 * schema, not guessed: a Relay connection has `nodes` and `pageInfo`, a plain
 * list is a list. So the reads are generated from the schema, the same way
 * every time, rather than written per API by a model: one query per list, with
 * each record's plain fields selected, and paging where the schema declares it.
 *
 * The schema comes from wherever the API publishes it: SDL in the
 * documentation, or introspection where it answers. Both are parsed into the
 * same small model here.
 */

type CatalogOp = CatalogEntry["ops"][number];
type MappedField = NonNullable<CatalogOp["fields"]>[number];

export type GqlRef =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "list"; readonly of: GqlRef }
  | { readonly kind: "nonNull"; readonly of: GqlRef };

export interface GqlArg {
  readonly name: string;
  readonly type: GqlRef;
  readonly hasDefault: boolean;
}

export interface GqlField {
  readonly name: string;
  readonly args: readonly GqlArg[];
  readonly type: GqlRef;
  readonly deprecated: boolean;
  readonly description?: string;
}

export interface GqlType {
  readonly kind: "object" | "interface" | "input" | "enum" | "scalar" | "union";
  readonly name: string;
  readonly fields: readonly GqlField[];
  readonly values?: readonly string[];
  readonly description?: string;
}

export interface GqlSchema {
  readonly queryType: string;
  readonly types: ReadonlyMap<string, GqlType>;
}

const BUILTIN_SCALARS = ["String", "Int", "Float", "Boolean", "ID"];

/** The named type under any list and non-null wrappers. */
export const namedOf = (ref: GqlRef): string => (ref.kind === "named" ? ref.name : namedOf(ref.of));
const unwrapNonNull = (ref: GqlRef): GqlRef => (ref.kind === "nonNull" ? ref.of : ref);
const isList = (ref: GqlRef): boolean => unwrapNonNull(ref).kind === "list";
const required = (arg: GqlArg): boolean => arg.type.kind === "nonNull" && !arg.hasDefault;

/* ── SDL ───────────────────────────────────────────────────────────────── */

type Token = { readonly kind: "name" | "punct" | "string" | "number"; readonly value: string };

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (/[\s,﻿]/.test(char)) {
      at++;
      continue;
    }
    if (char === "#") {
      while (at < text.length && text[at] !== "\n") at++;
      continue;
    }
    if (text.startsWith('"""', at)) {
      const end = text.indexOf('"""', at + 3);
      const stop = end === -1 ? text.length : end;
      tokens.push({ kind: "string", value: text.slice(at + 3, stop).trim() });
      at = stop + 3;
      continue;
    }
    if (char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
      tokens.push({ kind: "string", value: text.slice(at + 1, end) });
      at = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = at + 1;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end]!)) end++;
      tokens.push({ kind: "name", value: text.slice(at, end) });
      at = end;
      continue;
    }
    if (/[-0-9]/.test(char)) {
      let end = at + 1;
      while (end < text.length && /[0-9.eE+-]/.test(text[end]!)) end++;
      tokens.push({ kind: "number", value: text.slice(at, end) });
      at = end;
      continue;
    }
    if (text.startsWith("...", at)) {
      tokens.push({ kind: "punct", value: "..." });
      at += 3;
      continue;
    }
    tokens.push({ kind: "punct", value: char });
    at++;
  }
  return tokens;
};

/**
 * A schema written as SDL, as far as reading records needs: its types, their
 * fields and arguments, enums, and which type answers queries. Directives and
 * default values are read past; `@deprecated` is kept.
 */
export const parseSdl = (text: string): GqlSchema | null => {
  const tokens = tokenize(text);
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset];
  const is = (value: string, offset = 0) => peek(offset)?.value === value;
  const take = () => tokens[at++];
  const types = new Map<string, GqlType>();
  let queryType: string | null = null;

  /** A value — a default, a directive argument — read past, however nested. */
  const skipValue = (): void => {
    const token = take();
    if (!token) return;
    if (token.value === "[" || token.value === "{") {
      const close = token.value === "[" ? "]" : "}";
      while (peek() && !is(close)) {
        if (peek()?.kind === "name" && is(":", 1)) at += 2;
        skipValue();
      }
      take();
    }
  };
  const directives = (): boolean => {
    let deprecated = false;
    while (is("@")) {
      take();
      if (take()?.value === "deprecated") deprecated = true;
      if (is("(")) {
        take();
        while (peek() && !is(")")) {
          take(); // name
          if (is(":")) take();
          skipValue();
        }
        take();
      }
    }
    return deprecated;
  };
  const typeRef = (): GqlRef => {
    let ref: GqlRef;
    if (is("[")) {
      take();
      ref = { kind: "list", of: typeRef() };
      if (is("]")) take();
    } else {
      ref = { kind: "named", name: take()?.value ?? "String" };
    }
    if (is("!")) {
      take();
      ref = { kind: "nonNull", of: ref };
    }
    return ref;
  };
  const description = (): string | undefined => (peek()?.kind === "string" ? take()!.value : undefined);
  const args = (): GqlArg[] => {
    const out: GqlArg[] = [];
    if (!is("(")) return out;
    take();
    while (peek() && !is(")")) {
      description();
      const name = take()?.value ?? "";
      if (is(":")) take();
      const type = typeRef();
      let hasDefault = false;
      if (is("=")) {
        take();
        skipValue();
        hasDefault = true;
      }
      directives();
      out.push({ name, type, hasDefault });
    }
    take();
    return out;
  };
  const fieldsBlock = (): GqlField[] => {
    const out: GqlField[] = [];
    if (!is("{")) return out;
    take();
    while (peek() && !is("}")) {
      const said = description();
      const name = take()?.value ?? "";
      const taken = args();
      if (is(":")) take();
      const type = typeRef();
      if (is("=")) {
        take();
        skipValue();
      }
      const deprecated = directives();
      out.push({ name, args: taken, type, deprecated, ...(said ? { description: said } : {}) });
    }
    take();
    return out;
  };
  const add = (type: GqlType, extend: boolean) => {
    const known = types.get(type.name);
    types.set(
      type.name,
      extend && known ? { ...known, fields: [...known.fields, ...type.fields] } : { ...(known ?? {}), ...type },
    );
  };

  while (at < tokens.length) {
    const said = description();
    let keyword = take()?.value;
    const extend = keyword === "extend";
    if (extend) keyword = take()?.value;
    if (keyword === "schema") {
      directives();
      if (is("{")) {
        take();
        while (peek() && !is("}")) {
          const operation = take()?.value;
          if (is(":")) take();
          const name = take()?.value;
          if (operation === "query" && name) queryType = name;
        }
        take();
      }
    } else if (keyword === "type" || keyword === "interface" || keyword === "input") {
      const name = take()?.value ?? "";
      if (is("implements")) {
        take();
        if (is("&")) take();
        while (peek()?.kind === "name" && !is("{") && !is("@")) {
          take();
          if (is("&")) take();
        }
      }
      directives();
      const fields = fieldsBlock();
      add(
        {
          kind: keyword === "type" ? "object" : keyword,
          name,
          fields,
          ...(said ? { description: said } : {}),
        },
        extend,
      );
    } else if (keyword === "enum") {
      const name = take()?.value ?? "";
      directives();
      const values: string[] = [];
      if (is("{")) {
        take();
        while (peek() && !is("}")) {
          description();
          const value = take()?.value;
          if (value) values.push(value);
          directives();
        }
        take();
      }
      add({ kind: "enum", name, fields: [], values }, extend);
    } else if (keyword === "scalar") {
      const name = take()?.value ?? "";
      directives();
      add({ kind: "scalar", name, fields: [], ...(said ? { description: said } : {}) }, extend);
    } else if (keyword === "union") {
      const name = take()?.value ?? "";
      directives();
      if (is("=")) {
        take();
        if (is("|")) take();
        while (peek()?.kind === "name") {
          take();
          if (is("|")) take();
          else break;
        }
      }
      add({ kind: "union", name, fields: [] }, extend);
    } else if (keyword === "directive") {
      /* `directive @name(args) repeatable? on A | B`: read to its last location. */
      if (is("@")) take();
      take();
      args();
      if (is("repeatable")) take();
      if (is("on")) {
        take();
        if (is("|")) take();
        while (peek()?.kind === "name") {
          take();
          if (is("|")) take();
          else break;
        }
      }
    } else if (keyword === undefined) {
      break;
    }
    /* Anything else is not a definition this reads: step past it. */
  }

  const query = queryType ?? (types.has("Query") ? "Query" : types.has("QueryRoot") ? "QueryRoot" : null);
  if (!query || types.get(query)?.kind !== "object") return null;
  return { queryType: query, types };
};

/** Whether a document reads as SDL: a query type, or a schema naming one. */
export const looksLikeSdl = (text: string): boolean =>
  /(^|\n)\s*(schema\s*\{[^}]*query\s*:|type\s+(Query|QueryRoot)\s*[{@])/.test(text);

/* ── Introspection ─────────────────────────────────────────────────────── */

/** What is asked of an API that answers introspection: enough to read records, no more. */
export const INTROSPECTION_QUERY = `query DashIntrospection {
  __schema {
    queryType { name }
    types {
      kind
      name
      description
      enumValues(includeDeprecated: false) { name }
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        args { name defaultValue type { ...DashRef } }
        type { ...DashRef }
      }
    }
  }
}
fragment DashRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;

/**
 * The same, shallower, for an API that limits how deep a query may go
 * ("Query depth limit exceeded", Rick and Morty's): three wrappers still reach
 * `[Type!]!`, and an argument's type only needs to say whether it is required.
 */
export const SHALLOW_INTROSPECTION_QUERY = `query DashIntrospection {
  __schema {
    queryType { name }
    types {
      kind
      name
      enumValues(includeDeprecated: false) { name }
      fields(includeDeprecated: true) {
        name
        isDeprecated
        args { name defaultValue type { kind name } }
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }
}`;

type IntroRef = { kind?: string; name?: string | null; ofType?: IntroRef | null } | null | undefined;

/** A type the answer was not deep enough to name: never a record, never selected. */
const UNKNOWN = "__Unknown";

const refOf = (ref: IntroRef): GqlRef => {
  if (!ref) return { kind: "named", name: UNKNOWN };
  if (ref.kind === "NON_NULL") return { kind: "nonNull", of: refOf(ref.ofType) };
  if (ref.kind === "LIST") return { kind: "list", of: refOf(ref.ofType) };
  return { kind: "named", name: ref.name ?? UNKNOWN };
};

const INTRO_KINDS: Record<string, GqlType["kind"]> = {
  OBJECT: "object",
  INTERFACE: "interface",
  INPUT_OBJECT: "input",
  ENUM: "enum",
  SCALAR: "scalar",
  UNION: "union",
};

/**
 * Introspection a type at a time, for an API that refuses a query deeper than
 * four levels (Rick and Morty's). The types and their kinds first, then each
 * object type the query type reaches, by name: `__type → fields → type →
 * ofType` is four deep. A field wrapped too deeply to name is left unnamed,
 * and so never selected — which is a list of records, not a field, anyway.
 */
export const introspectByType = async (
  ask: (query: string) => Promise<unknown>,
  limit = 30,
): Promise<GqlSchema | null> => {
  const listing = (await ask("query DashTypes { __schema { queryType { name } types { kind name } } }")) as {
    data?: { __schema?: { queryType?: { name?: string }; types?: { kind?: string; name?: string }[] } };
  } | null;
  const queryType = listing?.data?.__schema?.queryType?.name;
  const kinds = new Map((listing?.data?.__schema?.types ?? []).map((one) => [one.name ?? "", one.kind ?? ""]));
  if (!queryType) return null;
  const types: unknown[] = [...kinds].filter(([name, kind]) => kind !== "OBJECT" && kind !== "INTERFACE" && name).map(([name, kind]) => ({ kind, name }));
  const queue = [queryType];
  const asked = new Set<string>();
  while (queue.length > 0 && asked.size < limit) {
    const name = queue.shift()!;
    if (asked.has(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    asked.add(name);
    const answer = (await ask(
      `query DashType { __type(name: "${name}") { fields(includeDeprecated: true) { name isDeprecated args { name defaultValue type { kind name } } type { kind name ofType { kind name } } } } }`,
    )) as { data?: { __type?: { fields?: { type?: IntroRef }[] } | null } } | null;
    const fields = answer?.data?.__type?.fields;
    if (!fields) continue;
    types.push({ kind: kinds.get(name) ?? "OBJECT", name, fields });
    for (const field of fields) {
      const named = namedOf(refOf(field.type));
      const kind = kinds.get(named);
      if ((kind === "OBJECT" || kind === "INTERFACE") && !asked.has(named)) queue.push(named);
    }
  }
  return parseIntrospection({ data: { __schema: { queryType: { name: queryType }, types } } });
};

/** An introspection answer (`{ data: { __schema } }`), or null when it is not one. */
export const parseIntrospection = (body: unknown): GqlSchema | null => {
  const schema = (body as { data?: { __schema?: unknown } } | null)?.data?.__schema as
    | { queryType?: { name?: string }; types?: unknown[] }
    | undefined;
  const queryType = schema?.queryType?.name;
  if (!queryType || !Array.isArray(schema?.types)) return null;
  const types = new Map<string, GqlType>();
  for (const raw of schema.types) {
    const type = raw as {
      kind?: string;
      name?: string;
      description?: string | null;
      enumValues?: { name?: string }[] | null;
      fields?: {
        name?: string;
        description?: string | null;
        isDeprecated?: boolean;
        args?: { name?: string; defaultValue?: string | null; type?: IntroRef }[];
        type?: IntroRef;
      }[] | null;
    };
    const kind = INTRO_KINDS[type.kind ?? ""];
    if (!kind || !type.name || type.name.startsWith("__")) continue;
    types.set(type.name, {
      kind,
      name: type.name,
      fields: (type.fields ?? []).map((field) => ({
        name: field.name ?? "",
        args: (field.args ?? []).map((arg) => ({
          name: arg.name ?? "",
          type: refOf(arg.type),
          hasDefault: arg.defaultValue !== null && arg.defaultValue !== undefined,
        })),
        type: refOf(field.type),
        deprecated: field.isDeprecated === true,
        ...(field.description ? { description: field.description } : {}),
      })),
      ...(type.enumValues ? { values: type.enumValues.map((one) => one.name ?? "").filter(Boolean) } : {}),
      ...(type.description ? { description: type.description } : {}),
    });
  }
  return types.get(queryType)?.kind === "object" ? { queryType, types } : null;
};

/* ── Reads ─────────────────────────────────────────────────────────────── */

/** Arguments that page, and are set by the paging rule rather than by anybody. */
const PAGING_ARGS = new Set(["first", "after", "last", "before", "limit", "offset", "skip", "page", "perPage", "per_page", "pageSize", "page_size", "cursor"]);

/** How deep into nested objects a record's fields are selected: `totalPriceSet.shopMoney.amount`. */
const MAX_DEPTH = 3;
/** Fields selected per record, at most. */
const MAX_LEAVES = 60;
/** Records asked for per page, before any cost ceiling. */
const PAGE_SIZE = 100;
/**
 * A query's cost, kept under a ceiling the documentation may not state.
 * Hosted stores refuse a query over 1,000 points, counting each object on a
 * page; the page is sized so its objects come to at most this many.
 */
const COST_BUDGET = 900;

const scalarKinds = (schema: GqlSchema, name: string): MappedField["kinds"] => {
  if (name === "Int" || name === "Float") return ["number"];
  if (name === "Boolean") return ["boolean"];
  if (schema.types.get(name)?.kind === "enum") return ["string"];
  return ["string"];
};

const isLeaf = (schema: GqlSchema, name: string): boolean =>
  BUILTIN_SCALARS.includes(name) || ["scalar", "enum"].includes(schema.types.get(name)?.kind ?? "");

const DATE_SCALAR = /date|time|timestamp|instant/i;

/** One record's selection, and the fields it gives, flattened with dots. */
const selectionOf = (
  schema: GqlSchema,
  typeName: string,
  depth: number,
  path: readonly string[],
  within: ReadonlySet<string>,
  budget: { leaves: number; objects: number },
): { text: string; fields: MappedField[] } | null => {
  const type = schema.types.get(typeName);
  if (!type || (type.kind !== "object" && type.kind !== "interface")) return null;
  const parts: string[] = [];
  const fields: MappedField[] = [];
  for (const field of type.fields) {
    if (budget.leaves >= MAX_LEAVES) break;
    if (field.deprecated || field.args.some(required) || field.name.startsWith("__")) continue;
    const name = namedOf(field.type);
    const nullable = field.type.kind !== "nonNull";
    if (isLeaf(schema, name)) {
      const list = isList(field.type);
      const scalar = schema.types.get(name);
      parts.push(field.name);
      budget.leaves++;
      fields.push({
        name: [...path, field.name].join("."),
        kinds: list ? ["array"] : scalarKinds(schema, name),
        nullable,
        ...(!list && (DATE_SCALAR.test(name) || /ISO.?8601/i.test(scalar?.description ?? "")) ? { format: "iso8601" as const } : {}),
        ...(!list && scalar?.kind === "enum" && scalar.values && scalar.values.length > 0 ? { values: scalar.values.slice(0, 50) } : {}),
        ...(field.description ? { description: field.description.split("\n")[0]!.slice(0, 200) } : {}),
      });
      continue;
    }
    /* A nested record, once: a list of them, a connection or a cycle is another read, not a field. */
    if (depth >= MAX_DEPTH || isList(field.type) || within.has(name) || connectionOf(schema, name)) continue;
    const nested = selectionOf(schema, name, depth + 1, [...path, field.name], new Set([...within, name]), budget);
    if (!nested || nested.fields.length === 0) continue;
    budget.objects++;
    parts.push(`${field.name} { ${nested.text} }`);
    fields.push(...nested.fields);
  }
  return parts.length > 0 ? { text: parts.join(" "), fields } : null;
};

/** A Relay connection's shape: where its records are, and how it pages. */
const connectionOf = (
  schema: GqlSchema,
  typeName: string,
): { readonly records: string; readonly via: "nodes" | "edges" } | null => {
  const type = schema.types.get(typeName);
  if (!type || type.kind !== "object") return null;
  const pageInfo = type.fields.find((field) => field.name === "pageInfo");
  const info = pageInfo ? schema.types.get(namedOf(pageInfo.type)) : undefined;
  if (!info?.fields.some((field) => field.name === "endCursor") || !info.fields.some((field) => field.name === "hasNextPage"))
    return null;
  const nodes = type.fields.find((field) => field.name === "nodes" && isList(field.type));
  if (nodes && !isLeaf(schema, namedOf(nodes.type))) return { records: namedOf(nodes.type), via: "nodes" };
  const edges = type.fields.find((field) => field.name === "edges" && isList(field.type));
  const edge = edges ? schema.types.get(namedOf(edges.type)) : undefined;
  const node = edge?.fields.find((field) => field.name === "node");
  return node ? { records: namedOf(node.type), via: "edges" } : null;
};

/** A wrapper holding one list of records beside what it says about them: `{ info { count } results [...] }`. */
const wrapperOf = (
  schema: GqlSchema,
  typeName: string,
): { readonly list: string; readonly records: string; readonly count?: string } | null => {
  const type = schema.types.get(typeName);
  if (!type || type.kind !== "object") return null;
  const lists = type.fields.filter((field) => isList(field.type) && !isLeaf(schema, namedOf(field.type)) && !field.args.some(required));
  if (lists.length !== 1) return null;
  const counted = type.fields
    .flatMap((field) => {
      if (/^(total_?count|totalCount|count|total)$/.test(field.name) && namedOf(field.type) === "Int") return [field.name];
      const inner = schema.types.get(namedOf(field.type));
      const count = inner?.fields.find((one) => /^(count|total|totalCount)$/.test(one.name) && namedOf(one.type) === "Int");
      return inner && count && !isList(field.type) ? [`${field.name}.${count.name}`] : [];
    })
    .at(0);
  return { list: lists[0]!.name, records: namedOf(lists[0]!.type), ...(counted ? { count: counted } : {}) };
};

const words = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/^./, (first) => first.toUpperCase());

const singular = (name: string): string => {
  const lower = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return lower.endsWith("ies") ? `${lower.slice(0, -3)}y` : lower.endsWith("ses") ? lower.slice(0, -2) : lower.endsWith("s") ? lower.slice(0, -1) : lower;
};

export interface GraphqlReads {
  readonly ops: CatalogOp[];
  readonly resources: ResourceSpec[];
  /** Lists left out, and why: one that needs an input nobody supplies. */
  readonly skipped: readonly string[];
}

/**
 * One read per list the query type offers: a Relay connection, a plain list,
 * or a wrapper around one. A list that needs an input nobody has — an id, a
 * search — is left out and said. Each query selects the record's own plain
 * fields and the nested objects it carries, and pages the way the schema
 * says: a connection by its cursor, a list with `page` or `offset` by those.
 */
export const graphqlReads = (schema: GqlSchema, input: { readonly path: string }): GraphqlReads => {
  const query = schema.types.get(schema.queryType);
  const ops: CatalogOp[] = [];
  const resources: ResourceSpec[] = [];
  const skipped: string[] = [];
  const taken = new Set<string>();
  /* The kinds of record a resource was named for already. */
  const typed = new Set<string>();
  for (const field of query?.fields ?? []) {
    if (field.deprecated || field.name.startsWith("__")) continue;
    const returns = unwrapNonNull(field.type);
    const named = namedOf(field.type);
    const connection = returns.kind === "named" ? connectionOf(schema, named) : null;
    const wrapper = returns.kind === "named" && !connection ? wrapperOf(schema, named) : null;
    const plainList = returns.kind === "list" && !isLeaf(schema, named) ? named : null;
    const records = connection?.records ?? wrapper?.records ?? plainList;
    if (!records) continue;
    /*
     * Arguments it insists on: kept as the read's inputs, not a reason to leave
     * it out. An organisation's projects need its id, and the check finds where
     * that comes from — the organisations list. Only an
     * argument of a plain kind: an input object nobody can fill in.
     */
    const needs = field.args.filter((arg) => required(arg) && !PAGING_ARGS.has(arg.name));
    const unfillable = needs.filter((arg) => !isLeaf(schema, namedOf(arg.type)));
    if (unfillable.length > 0) {
      skipped.push(`${field.name} needs ${unfillable.map((arg) => arg.name).join(", ")}, which takes more than a value`);
      continue;
    }
    const budget = { leaves: 0, objects: 0 };
    const selection = selectionOf(schema, records, 1, [], new Set([records]), budget);
    if (!selection) continue;

    const has = (name: string) => field.args.some((arg) => arg.name === name);
    const argType = (name: string) => {
      const arg = field.args.find((one) => one.name === name);
      return arg ? `${namedOf(arg.type)}${arg.type.kind === "nonNull" ? "!" : ""}` : "";
    };
    /* Sized so a page's objects stay under a cost ceiling the documentation may not state. */
    const pageSize = Math.max(10, Math.min(PAGE_SIZE, Math.floor(COST_BUDGET / (1 + budget.objects + (connection?.via === "edges" ? 1 : 0)))));
    const variables: string[] = [];
    const passed: string[] = [];
    /* Each insisted-on argument: a variable the body fills from the read's input of the same name. */
    const inputs = needs.map((arg) => {
      variables.push(`$${arg.name}: ${argType(arg.name)}`);
      passed.push(`${arg.name}: $${arg.name}`);
      const kind = namedOf(arg.type);
      return {
        name: arg.name,
        in: "body" as const,
        type: kind === "Int" || kind === "Float" ? ("number" as const) : kind === "Boolean" ? ("boolean" as const) : ("string" as const),
        required: true,
      };
    });
    let pagination: CatalogOp["pagination"] | undefined;
    const base = `$.data.${field.name}`;
    let rowsPath: string;
    let shape: string;
    let totalPath: string | undefined;

    if (connection) {
      const pages = has("first") && has("after");
      if (pages) {
        variables.push(`$after: ${argType("after") || "String"}`.replace(/!$/, ""));
        passed.push(`first: ${pageSize}`, "after: $after");
        pagination = {
          kind: "cursor",
          param: "after",
          cursorPath: `${base}.pageInfo.endCursor`,
          hasMorePath: `${base}.pageInfo.hasNextPage`,
          in: "body",
        };
      }
      const counted = schema.types.get(named)?.fields.find((one) => /^(totalCount|total_count|total|count)$/.test(one.name) && namedOf(one.type) === "Int");
      shape =
        connection.via === "nodes"
          ? `nodes { ${selection.text} } pageInfo { hasNextPage endCursor }${counted ? ` ${counted.name}` : ""}`
          : `edges { node { ${selection.text} } } pageInfo { hasNextPage endCursor }${counted ? ` ${counted.name}` : ""}`;
      rowsPath = connection.via === "nodes" ? `${base}.nodes` : `${base}.edges[*].node`;
      if (counted) totalPath = `${base}.${counted.name}`;
    } else {
      if (has("page")) {
        variables.push(`$page: ${argType("page").replace(/!$/, "") || "Int"}`);
        passed.push("page: $page");
        pagination = { kind: "page", param: "page", startsAt: 1, in: "body" };
      } else if (has("offset") || has("skip")) {
        const offset = has("offset") ? "offset" : "skip";
        const limit = ["limit", "first", "take"].find(has);
        if (limit) {
          variables.push(`$${offset}: Int`, `$${limit}: Int`);
          passed.push(`${offset}: $${offset}`, `${limit}: $${limit}`);
          pagination = { kind: "offset", param: offset, limitParam: limit, pageSize, in: "body" };
        }
      } else if (has("limit") || has("first")) {
        /* A list that only takes a size: as many as it gives in one answer. */
        passed.push(`${has("limit") ? "limit" : "first"}: ${PAGE_SIZE}`);
      }
      if (wrapper) {
        const counted = wrapper.count;
        const [outer, inner] = counted?.split(".") ?? [];
        shape = `${wrapper.list} { ${selection.text} }${counted ? ` ${inner ? `${outer} { ${inner} }` : outer}` : ""}`;
        rowsPath = `${base}.${wrapper.list}`;
        if (counted) totalPath = `${base}.${counted}`;
      } else {
        shape = selection.text;
        rowsPath = base;
      }
    }

    const operation = `Dash${field.name.replace(/^./, (first) => first.toUpperCase())}`;
    const document = `query ${operation}${variables.length > 0 ? `(${variables.join(", ")})` : ""} { ${field.name}${
      passed.length > 0 ? `(${passed.join(", ")})` : ""
    } { ${shape} } }`;
    let id = field.name;
    for (let suffix = 2; taken.has(id); suffix++) id = `${field.name}-${suffix}`;
    taken.add(id);
    ops.push({
      id,
      title: field.description?.split("\n")[0]?.slice(0, 120) || words(field.name),
      method: "POST",
      path: input.path,
      body: {
        type: "graphql",
        query: document,
        variables: Object.fromEntries(inputs.map((one) => [one.name, `{{param.${one.name}}}`])),
        operationName: operation,
      },
      readSafety: { basis: "graphql-query", note: `The ${field.name} query, generated from the schema.` },
      archetype: "list",
      rowsPath,
      ...(pagination ? { pagination } : {}),
      ...(totalPath ? { totalPath } : {}),
      params: inputs,
      query: {},
      fields: selection.fields,
    });
    /* One record type per kind of record: a search over the orders is another way to read orders, not a type of its own. */
    if (typed.has(records)) continue;
    typed.add(records);
    let resource = singular(field.name).replace(/[^a-z0-9-]/g, "-") || "record";
    for (let suffix = 2; resources.some((one) => one.id === resource); suffix++) resource = `${singular(field.name)}-${suffix}`;
    resources.push({ id: resource, title: words(field.name), listOp: id, relations: [], verified: false });
  }
  return { ops, resources, skipped };
};

/* ── From documentation ────────────────────────────────────────────────── */

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " " };
const decode = (text: string): string => text.replace(/&(lt|gt|amp|quot|nbsp|#39|#x27);/g, (entity) => ENTITIES[entity] ?? entity);

/** SDL written into the page itself, in a code block. */
const sdlInPage = (html: string): string[] =>
  [...html.matchAll(/<(pre|code)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => decode(match[2]!.replace(/<[^>]+>/g, "")))
    .filter(looksLikeSdl);

/** Schema files the page links to: `schema.graphql`, `*.gql`. */
const sdlLinks = (html: string, pageUrl: string): string[] => {
  const found: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = decode(match[1]!);
    if (!/\.(graphqls?|gql|sdl)(\?|#|$)/i.test(href)) continue;
    try {
      const url = new URL(href, pageUrl);
      if (url.protocol === "https:" || url.protocol === "http:") found.push(url.toString());
    } catch {
      /* Not an address. */
    }
  }
  return [...new Set(found)].slice(0, 3);
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};
const siteOf = (host: string | null): string => (host ?? "").split(".").slice(-2).join(".");

/**
 * Where the GraphQL endpoint is, under the entry's address: the address the
 * documentation gives for it, else an endpoint the prose read named, else
 * `/graphql`.
 */
const endpointPath = (entry: CatalogEntry, text: string): string => {
  let base: URL | null = null;
  try {
    base = new URL(entry.baseUrl);
  } catch {
    base = null;
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`)]+/g)) {
    const raw = match[0].replace(/[.,;:]+$/, "");
    if (!/graphql/i.test(raw)) continue;
    try {
      const url = new URL(raw);
      if (!base || url.origin !== base.origin) continue;
      const root = base.pathname.replace(/\/+$/, "");
      /* The address the prose read settled on may be the endpoint itself: see `withGraphqlReads`. */
      if (url.pathname.replace(/\/+$/, "") === root) return "";
      if (url.pathname.startsWith(`${root}/`)) return url.pathname.slice(root.length);
    } catch {
      /* Not an address. */
    }
  }
  return entry.ops.find((op) => /graphql/i.test(op.path))?.path ?? "/graphql";
};

/**
 * An entry read from prose, with its GraphQL reads written from the schema
 * the documentation publishes — in the page, or in a schema file it links to
 * on the same site. The prose's own guess at the endpoint is replaced; its
 * address and sign-in stay. Null when there is no schema to read.
 */
export const withGraphqlReads = async (
  entry: CatalogEntry,
  page: { readonly html: string; readonly url: string },
  fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>,
): Promise<{ readonly entry: CatalogEntry; readonly note: string; readonly warnings: readonly string[] } | null> => {
  const sources = sdlInPage(page.html);
  const site = siteOf(hostOf(page.url));
  for (const link of sdlLinks(page.html, page.url)) {
    if (sources.length > 0) break;
    if (siteOf(hostOf(link)) !== site && siteOf(hostOf(link)) !== siteOf(hostOf(entry.baseUrl))) continue;
    const answer = await fetchDocument(link).catch(() => null);
    if (answer && answer.status >= 200 && answer.status < 300 && looksLikeSdl(answer.text)) sources.push(answer.text);
  }
  const schema = sources.map(parseSdl).find((one): one is GqlSchema => one !== null);
  if (!schema) return null;
  let path = endpointPath(entry, decode(page.html.replace(/<[^>]+>/g, " ")));
  /*
   * The address is the endpoint itself (`…/admin/2026-07/graphql.json`): its
   * last segment becomes the path, so a read is not sent to `graphql.json/`.
   */
  let baseUrl = entry.baseUrl;
  if (path === "") {
    try {
      const url = new URL(entry.baseUrl);
      const segments = url.pathname.replace(/\/+$/, "").split("/");
      const last = segments.pop() ?? "";
      if (last) {
        path = `/${last}`;
        url.pathname = segments.join("/") || "/";
        baseUrl = url.toString().replace(/\/+$/, "");
      }
    } catch {
      /* Kept as it is. */
    }
  }
  const reads = graphqlReads(schema, { path });
  if (reads.ops.length === 0) return null;
  /* The prose read's own guess at the endpoint, however it spelled the path. */
  const same = (one: string) => {
    const spelled = one.replace(/\/+$/, "");
    return spelled === path.replace(/\/+$/, "") || (baseUrl !== entry.baseUrl && spelled === "");
  };
  const replaced = new Set(entry.ops.filter((op) => same(op.path)).map((op) => op.id));
  const kept = entry.ops.filter((op) => !replaced.has(op.id));
  const taken = new Set(kept.map((op) => op.id));
  const ops = reads.ops.filter((op) => !taken.has(op.id));
  return {
    entry: {
      ...entry,
      baseUrl,
      ops: [...kept, ...ops],
      resources: [
        ...entry.resources.filter((resource) => !resource.listOp || !replaced.has(resource.listOp)),
        ...reads.resources.filter((resource) => ops.some((op) => op.id === resource.listOp)),
      ],
    },
    note: `Its GraphQL schema was read, and ${ops.length} list(s) set up from it.`,
    warnings: reads.skipped.map((one) => `Not set up: ${one}.`),
  };
};
