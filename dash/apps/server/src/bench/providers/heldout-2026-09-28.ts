import { connectorHash } from "../../connector/adapter.js";
import { BENCH_NOW, cents, html, intParam, json, major, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Held-out providers written on 2026-09-28, after checkpoint 1, by a session
 * that has not read the integration loop, its repairs, its prompts, the
 * importers or any result — see `dash/bench/HELDOUT-AUTHORING.md`.
 *
 * Each is shaped after a kind of business API that exists, and is awkward in
 * the ways those APIs are. Nothing here may be read while tuning the loop, a
 * prompt or a repair; they run only at a checkpoint (`dash/bench/PROTOCOL.md`).
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/* ── shared ───────────────────────────────────────────────────────────── */

const bodyJson = (body: string | undefined): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(body ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const form = (body: string | undefined): URLSearchParams => new URLSearchParams(body ?? "");

/** The two halves of an HTTP Basic header, or null when there is none. */
const basicPair = (request: BenchRequest): readonly [string, string] | null => {
  const header = request.headers.authorization ?? "";
  if (!/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? [decoded, ""] : [decoded.slice(0, colon), decoded.slice(colon + 1)];
};

const textAs = (contentType: string, body: string, status = 200, headers: Record<string, string> = {}): BenchResponse => ({
  status,
  headers: { "content-type": contentType, ...headers },
  body,
});

const page = (title: string, content: string): BenchResponse =>
  html(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n${content}\n</body></html>`);

/** For code samples shown inside an HTML page. */
const esc = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const decimal = (amountCents: number): string => (amountCents / 100).toFixed(2);

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const hex = (next: () => number, length: number): string =>
  Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join("");

const FIRST_NAMES = [
  "Ava", "Ben", "Chloe", "Dev", "Elena", "Farid", "Grace", "Hugo", "Iris", "Jonah", "Kira", "Luis", "Maya",
  "Noah", "Olga", "Priya", "Quinn", "Rosa", "Sam", "Tariq", "Uma", "Victor", "Wen", "Yara", "Zane",
] as const;
const LAST_NAMES = [
  "Abbott", "Baker", "Chen", "Diaz", "Evans", "Fischer", "Garcia", "Haddad", "Ito", "Jensen", "Kim", "Lopez",
  "Moreau", "Nakamura", "Okafor", "Patel", "Quist", "Rossi", "Singh", "Tanaka", "Ueda", "Varga", "Walsh", "Young", "Zhou",
] as const;
const COMPANIES = [
  "Alder & Finch", "Bluewater Supply", "Cobalt Dental", "Driftwood Cafe", "Evergreen Clinics", "Foxglove Studio",
  "Granite Freight", "Harbor Lights", "Ironbark Tools", "Juniper Florals", "Kestrel Labs", "Lantern Books",
  "Meridian Legal", "Northgate Motors", "Oakline Builders", "Pinecrest Vets", "Quarry Coffee", "Redwood Rentals",
  "Saltmarsh Foods", "Tidewell Marine", "Upland Outfitters", "Vantage Print", "Willow Yoga", "Yardarm Brewing",
] as const;

/* ── Shopwell: GraphQL, a search string, a cost limit, test orders ────── */

/*
 * An e-commerce admin API in GraphQL, after the big hosted-store platforms:
 * Relay connections with `edges` and `nodes`, a search syntax in an argument,
 * a calculated query cost that refuses an expensive page before it runs,
 * money as decimal strings, a deprecated flat total beside a nested one,
 * introspection turned off with the schema published as SDL, and test orders
 * that are not sales.
 */

const S_API = "api.shopwell.bench.test";
const S_DOCS = "developer.shopwell.bench.test";
const S_TOKEN = "swat_4f1c9e2b7d06a3e1";
const S_VERSIONS = ["2025-10", "2026-01", "2026-04", "2026-07"] as const;
const S_MAX_COST = 1000;

interface ShopOrder {
  readonly number: number;
  readonly id: string;
  readonly email: string | null;
  readonly createdAt: string;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly financial: string;
  readonly fulfillment: string;
  readonly test: boolean;
  readonly tags: readonly string[];
  readonly totalCents: number;
  readonly currentCents: number;
  readonly customer: { readonly id: string; readonly firstName: string; readonly lastName: string; readonly email: string } | null;
}

const shopOrders: readonly ShopOrder[] = (() => {
  const next = random(12011);
  const count = 460;
  return Array.from({ length: count }, (_, index): ShopOrder => {
    const created = BENCH_NOW - Math.floor((count - index) * 0.9 * DAY) + Math.floor(next() * 0.4 * DAY);
    const financial = pick(next, [
      "PAID", "PAID", "PAID", "PAID", "PAID", "PENDING", "AUTHORIZED", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED",
    ] as const);
    const cancelled = next() < 0.07;
    const test = next() < 0.05;
    const totalCents = cents(next, 9, 640);
    const refunded =
      financial === "REFUNDED" || financial === "VOIDED"
        ? totalCents
        : financial === "PARTIALLY_REFUNDED"
          ? Math.round(totalCents * (0.2 + next() * 0.5))
          : 0;
    const guest = next() < 0.18;
    const firstName = pick(next, FIRST_NAMES);
    const lastName = pick(next, LAST_NAMES);
    const email = `${firstName}.${lastName}${index % 9}@example.com`.toLowerCase();
    const fulfillment = cancelled
      ? "UNFULFILLED"
      : pick(next, ["FULFILLED", "FULFILLED", "FULFILLED", "UNFULFILLED", "PARTIALLY_FULFILLED"] as const);
    const tags = next() < 0.25 ? ["wholesale"] : next() < 0.15 ? ["gift"] : [];
    return {
      number: 1001 + index,
      id: `gid://shopwell/Order/${5_310_000 + index * 13}`,
      email: guest && next() < 0.5 ? null : email,
      createdAt: new Date(created).toISOString().replace(/\.\d{3}Z$/, "Z"),
      cancelledAt: cancelled ? new Date(created + 3 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
      cancelReason: cancelled ? pick(next, ["CUSTOMER", "INVENTORY", "FRAUD", "DECLINED", "OTHER"] as const) : null,
      financial,
      fulfillment,
      test,
      tags,
      totalCents,
      currentCents: totalCents - refunded,
      customer: guest
        ? null
        : { id: `gid://shopwell/Customer/${7_200_000 + index * 7}`, firstName, lastName, email },
    };
  });
})();

interface GqlFieldDef {
  readonly type: string;
  readonly list?: boolean;
  readonly args?: readonly string[];
}

const SHOP_SCHEMA: Readonly<Record<string, Readonly<Record<string, GqlFieldDef>>>> = {
  QueryRoot: {
    shop: { type: "Shop" },
    order: { type: "Order", args: ["id"] },
    orders: { type: "OrderConnection", args: ["first", "after", "last", "before", "query", "sortKey", "reverse"] },
  },
  Shop: {
    id: { type: "ID" },
    name: { type: "String" },
    currencyCode: { type: "CurrencyCode" },
    ianaTimezone: { type: "String" },
    myshopwellDomain: { type: "String" },
  },
  OrderConnection: {
    edges: { type: "OrderEdge", list: true },
    nodes: { type: "Order", list: true },
    pageInfo: { type: "PageInfo" },
  },
  OrderEdge: { cursor: { type: "String" }, node: { type: "Order" } },
  PageInfo: {
    hasNextPage: { type: "Boolean" },
    hasPreviousPage: { type: "Boolean" },
    startCursor: { type: "String" },
    endCursor: { type: "String" },
  },
  Order: {
    id: { type: "ID" },
    name: { type: "String" },
    email: { type: "String" },
    createdAt: { type: "DateTime" },
    processedAt: { type: "DateTime" },
    cancelledAt: { type: "DateTime" },
    cancelReason: { type: "OrderCancelReason" },
    displayFinancialStatus: { type: "OrderDisplayFinancialStatus" },
    displayFulfillmentStatus: { type: "OrderDisplayFulfillmentStatus" },
    test: { type: "Boolean" },
    tags: { type: "String", list: true },
    currencyCode: { type: "CurrencyCode" },
    totalPrice: { type: "Money" },
    totalPriceSet: { type: "MoneyBag" },
    currentTotalPriceSet: { type: "MoneyBag" },
    customer: { type: "Customer" },
  },
  MoneyBag: { shopMoney: { type: "MoneyV2" }, presentmentMoney: { type: "MoneyV2" } },
  MoneyV2: { amount: { type: "Decimal" }, currencyCode: { type: "CurrencyCode" } },
  Customer: {
    id: { type: "ID" },
    displayName: { type: "String" },
    firstName: { type: "String" },
    lastName: { type: "String" },
    email: { type: "String" },
  },
};

const moneyBag = (amountCents: number) => {
  const money = { amount: decimal(amountCents), currencyCode: "USD" };
  return { shopMoney: money, presentmentMoney: money };
};

const orderView = (order: ShopOrder): Record<string, unknown> => ({
  id: order.id,
  name: `#${order.number}`,
  email: order.email,
  createdAt: order.createdAt,
  processedAt: order.createdAt,
  cancelledAt: order.cancelledAt,
  cancelReason: order.cancelReason,
  displayFinancialStatus: order.financial,
  displayFulfillmentStatus: order.fulfillment,
  test: order.test,
  tags: order.tags,
  currencyCode: "USD",
  totalPrice: decimal(order.totalCents),
  totalPriceSet: moneyBag(order.totalCents),
  currentTotalPriceSet: moneyBag(order.currentCents),
  customer: order.customer
    ? { ...order.customer, displayName: `${order.customer.firstName} ${order.customer.lastName}` }
    : null,
});

class GqlError extends Error {
  constructor(message: string, readonly code = "GRAPHQL_VALIDATION_FAILED") {
    super(message);
  }
}

type GqlValue =
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "lit"; readonly value: unknown }
  | { readonly kind: "list"; readonly items: readonly GqlValue[] }
  | { readonly kind: "obj"; readonly fields: Readonly<Record<string, GqlValue>> };

interface GqlField {
  readonly kind: "field";
  readonly alias: string | undefined;
  readonly name: string;
  readonly args: Readonly<Record<string, GqlValue>>;
  readonly selections: readonly GqlSelection[] | null;
}

type GqlSelection =
  | GqlField
  | { readonly kind: "spread"; readonly name: string }
  | { readonly kind: "inline"; readonly on: string | null; readonly selections: readonly GqlSelection[] };

interface GqlOperation {
  readonly type: string;
  readonly name: string | null;
  readonly variables: readonly { readonly name: string; readonly defaultValue?: GqlValue }[];
  readonly selections: readonly GqlSelection[];
}

interface GqlDocument {
  readonly operations: GqlOperation[];
  readonly fragments: Map<string, { readonly on: string; readonly selections: readonly GqlSelection[] }>;
}

const gqlTokens = (source: string): string[] => {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/[\s,\ufeff]/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (source.startsWith("...", i)) {
      tokens.push("...");
      i += 3;
      continue;
    }
    if ("{}()[]:!$=@|&".includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      if (end < 0) throw new GqlError("Parse error: unterminated string");
      tokens.push(JSON.stringify(source.slice(i + 3, end)));
      i = end + 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") j++;
        j++;
      }
      if (j >= source.length) throw new GqlError("Parse error: unterminated string");
      tokens.push(source.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const word = /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (!word) throw new GqlError(`Parse error on "${ch}"`);
    tokens.push(word[0]);
    i += word[0].length;
  }
  return tokens;
};

const parseGql = (source: string): GqlDocument => {
  const tokens = gqlTokens(source);
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (expected?: string): string => {
    const token = tokens[at];
    if (token === undefined)
      throw new GqlError(`Parse error: unexpected end of document${expected ? `, expected "${expected}"` : ""}`);
    if (expected !== undefined && token !== expected)
      throw new GqlError(`Parse error on "${token}", expected "${expected}"`);
    at++;
    return token;
  };
  const isName = (token: string | undefined): boolean => token !== undefined && /^[_A-Za-z]/.test(token);
  const name = (): string => {
    const token = take();
    if (!isName(token)) throw new GqlError(`Parse error on "${token}", expected a name`);
    return token;
  };
  const value = (constant: boolean): GqlValue => {
    const token = take();
    if (token === "$") {
      if (constant) throw new GqlError("Parse error: a default value cannot use a variable");
      return { kind: "var", name: name() };
    }
    if (token === "[") {
      const items: GqlValue[] = [];
      while (peek() !== "]") items.push(value(constant));
      take("]");
      return { kind: "list", items };
    }
    if (token === "{") {
      const fields: Record<string, GqlValue> = {};
      while (peek() !== "}") {
        const key = name();
        take(":");
        fields[key] = value(constant);
      }
      take("}");
      return { kind: "obj", fields };
    }
    if (token.startsWith('"')) {
      try {
        return { kind: "lit", value: JSON.parse(token) };
      } catch {
        throw new GqlError(`Parse error: bad string ${token}`);
      }
    }
    if (/^-?[0-9]/.test(token)) return { kind: "lit", value: Number(token) };
    if (token === "true" || token === "false") return { kind: "lit", value: token === "true" };
    if (token === "null") return { kind: "lit", value: null };
    if (isName(token)) return { kind: "lit", value: token };
    throw new GqlError(`Parse error on "${token}"`);
  };
  const args = (): Record<string, GqlValue> => {
    const out: Record<string, GqlValue> = {};
    if (peek() !== "(") return out;
    take("(");
    while (peek() !== ")") {
      const key = name();
      take(":");
      out[key] = value(false);
    }
    take(")");
    return out;
  };
  const directives = (): void => {
    while (peek() === "@") {
      take("@");
      name();
      args();
    }
  };
  const selectionSet = (): GqlSelection[] => {
    take("{");
    const out: GqlSelection[] = [];
    while (peek() !== "}") {
      if (peek() === undefined) throw new GqlError('Parse error: unexpected end of document, expected "}"');
      if (peek() === "...") {
        take("...");
        if (peek() === "on") {
          take("on");
          const on = name();
          directives();
          out.push({ kind: "inline", on, selections: selectionSet() });
        } else if (peek() === "{" || peek() === "@") {
          directives();
          out.push({ kind: "inline", on: null, selections: selectionSet() });
        } else {
          out.push({ kind: "spread", name: name() });
          directives();
        }
        continue;
      }
      let fieldName = name();
      let alias: string | undefined;
      if (peek() === ":") {
        take(":");
        alias = fieldName;
        fieldName = name();
      }
      const fieldArgs = args();
      directives();
      out.push({
        kind: "field",
        alias,
        name: fieldName,
        args: fieldArgs,
        selections: peek() === "{" ? selectionSet() : null,
      });
    }
    take("}");
    if (out.length === 0) throw new GqlError("Parse error: a selection set cannot be empty");
    return out;
  };
  const typeRef = (): void => {
    if (peek() === "[") {
      take("[");
      typeRef();
      take("]");
    } else name();
    if (peek() === "!") take("!");
  };
  const document: GqlDocument = { operations: [], fragments: new Map() };
  while (at < tokens.length) {
    if (peek() === "{") {
      document.operations.push({ type: "query", name: null, variables: [], selections: selectionSet() });
      continue;
    }
    const keyword = name();
    if (keyword === "fragment") {
      const fragmentName = name();
      take("on");
      const on = name();
      directives();
      document.fragments.set(fragmentName, { on, selections: selectionSet() });
      continue;
    }
    if (keyword !== "query" && keyword !== "mutation" && keyword !== "subscription")
      throw new GqlError(`Parse error on "${keyword}"`);
    const operationName = isName(peek()) ? name() : null;
    const variables: { name: string; defaultValue?: GqlValue }[] = [];
    if (peek() === "(") {
      take("(");
      while (peek() !== ")") {
        take("$");
        const variableName = name();
        take(":");
        typeRef();
        let defaultValue: GqlValue | undefined;
        if (peek() === "=") {
          take("=");
          defaultValue = value(true);
        }
        directives();
        variables.push(defaultValue ? { name: variableName, defaultValue } : { name: variableName });
      }
      take(")");
    }
    directives();
    document.operations.push({ type: keyword, name: operationName, variables, selections: selectionSet() });
  }
  if (document.operations.length === 0) throw new GqlError("Parse error: the document has no operation");
  return document;
};

interface GqlContext {
  readonly doc: GqlDocument;
  readonly vars: Readonly<Record<string, unknown>>;
}

const argValue = (value: GqlValue, vars: Readonly<Record<string, unknown>>): unknown => {
  switch (value.kind) {
    case "var":
      return vars[value.name] ?? null;
    case "lit":
      return value.value;
    case "list":
      return value.items.map((item) => argValue(item, vars));
    case "obj":
      return Object.fromEntries(Object.entries(value.fields).map(([key, item]) => [key, argValue(item, vars)]));
  }
};

const collectFields = (
  typeName: string,
  selections: readonly GqlSelection[],
  doc: GqlDocument,
  seen: ReadonlySet<string> = new Set(),
  out: GqlField[] = [],
): GqlField[] => {
  for (const selection of selections) {
    if (selection.kind === "field") out.push(selection);
    else if (selection.kind === "inline") {
      if (!selection.on || selection.on === typeName) collectFields(typeName, selection.selections, doc, seen, out);
    } else {
      const fragment = doc.fragments.get(selection.name);
      if (!fragment) throw new GqlError(`Fragment ${selection.name} was used, but not defined`);
      if (seen.has(selection.name)) throw new GqlError(`Fragment ${selection.name} contains an infinite loop`);
      if (fragment.on === typeName)
        collectFields(typeName, fragment.selections, doc, new Set([...seen, selection.name]), out);
    }
  }
  return out;
};

/** Each object 1, each connection 2 plus its page size times one node, scalars nothing. */
const queryCost = (typeName: string, selections: readonly GqlSelection[], context: GqlContext): number => {
  let cost = 0;
  for (const field of collectFields(typeName, selections, context.doc)) {
    const def = SHOP_SCHEMA[typeName]?.[field.name];
    if (!def || !SHOP_SCHEMA[def.type] || !field.selections) continue;
    const inner = queryCost(def.type, field.selections, context);
    if (def.type.endsWith("Connection")) {
      const size = field.args.first ?? field.args.last;
      cost += 2 + (Number(size ? argValue(size, context.vars) : 0) || 0) * inner;
    } else cost += 1 + inner;
  }
  return cost;
};

const shopCursor = (order: ShopOrder, sortKey: string): string =>
  Buffer.from(JSON.stringify({ last_id: order.number, last_value: sortValue(order, sortKey) })).toString("base64");

const sortValue = (order: ShopOrder, sortKey: string): string | number => {
  switch (sortKey) {
    case "CREATED_AT":
    case "PROCESSED_AT":
      return order.createdAt;
    case "TOTAL_PRICE":
      return order.totalCents;
    default:
      return order.number;
  }
};

type SearchWarning = { readonly field: string; readonly message: string };

const shopSearch = (query: string, warnings: SearchWarning[]): ((order: ShopOrder) => boolean) => {
  const tests: ((order: ShopOrder) => boolean)[] = [];
  for (const raw of query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    if (raw.toUpperCase() === "AND") continue;
    const negate = raw.startsWith("-");
    const term = (negate ? raw.slice(1) : raw).replace(/"/g, "");
    const colon = term.indexOf(":");
    let test: (order: ShopOrder) => boolean;
    if (colon < 0) {
      const word = term.toLowerCase();
      test = (order) => `#${order.number}`.includes(word) || (order.email ?? "").includes(word);
    } else {
      const key = term.slice(0, colon).toLowerCase();
      const [, comparator = "", value = ""] = /^(>=|<=|>|<)?(.*)$/.exec(term.slice(colon + 1)) ?? [];
      const lower = value.toLowerCase();
      const compare = (left: number, right: number): boolean =>
        comparator === ">" ? left > right : comparator === ">=" ? left >= right : comparator === "<" ? left < right : comparator === "<=" ? left <= right : isoDay(left) === isoDay(right);
      switch (key) {
        case "financial_status":
          test = (order) => order.financial.toLowerCase() === lower;
          break;
        case "status":
          test = (order) =>
            lower === "any" ||
            (lower === "open" && order.cancelledAt === null && order.fulfillment !== "FULFILLED") ||
            (lower === "closed" && order.cancelledAt === null && order.fulfillment === "FULFILLED") ||
            (lower === "cancelled" && order.cancelledAt !== null);
          break;
        case "fulfillment_status":
          test = (order) =>
            (["shipped", "fulfilled"].includes(lower) && order.fulfillment === "FULFILLED") ||
            (["unshipped", "unfulfilled"].includes(lower) && order.fulfillment === "UNFULFILLED") ||
            (lower === "partial" && order.fulfillment === "PARTIALLY_FULFILLED");
          break;
        case "test":
          test = (order) => String(order.test) === lower;
          break;
        case "created_at":
        case "processed_at": {
          const when = Date.parse(value);
          if (Number.isNaN(when)) {
            warnings.push({ field: key, message: `Invalid date: ${value}` });
            test = () => true;
          } else test = (order) => compare(Date.parse(order.createdAt), when);
          break;
        }
        case "tag":
          test = (order) => order.tags.includes(lower);
          break;
        case "email":
          test = (order) => order.email === lower;
          break;
        case "name":
          test = (order) => `#${order.number}` === value || String(order.number) === value;
          break;
        default:
          warnings.push({ field: key, message: "Invalid search field for this query." });
          test = () => true;
      }
    }
    tests.push(negate ? (order) => !test(order) : test);
  }
  return (order) => tests.every((one) => one(order));
};

const resolveShopOrders = (args: Record<string, unknown>, warnings: SearchWarning[]): Record<string, unknown> => {
  const first = args.first as number | null | undefined;
  const last = args.last as number | null | undefined;
  if (first == null && last == null) throw new GqlError("you must provide one of first or last");
  for (const [label, size] of [["first", first], ["last", last]] as const) {
    if (size != null && (!Number.isInteger(size) || size < 0 || size > 250))
      throw new GqlError(
        `Argument '${label}' on Field 'orders' has an invalid value (${String(size)}). Expected a page size from 0 to 250.`,
        "argumentLiteralsIncompatible",
      );
  }
  const sortKey = typeof args.sortKey === "string" ? args.sortKey : "ID";
  if (!["ID", "CREATED_AT", "PROCESSED_AT", "TOTAL_PRICE", "ORDER_NUMBER"].includes(sortKey))
    throw new GqlError(`Argument 'sortKey' on Field 'orders' has an invalid value (${sortKey}). Expected type 'OrderSortKeys'.`);
  const query = typeof args.query === "string" ? args.query : "";
  const matching = shopOrders.filter(shopSearch(query, warnings));
  matching.sort((a, b) => {
    const left = sortValue(a, sortKey);
    const right = sortValue(b, sortKey);
    return left < right ? -1 : left > right ? 1 : a.number - b.number;
  });
  if (args.reverse === true) matching.reverse();
  const position = (cursor: unknown): number => {
    try {
      const decoded = JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8")) as { last_id?: number };
      const index = matching.findIndex((order) => order.number === decoded.last_id);
      if (index >= 0) return index;
    } catch {
      /* falls through to the error */
    }
    throw new GqlError("Invalid cursor for current pagination sort.", "BAD_REQUEST");
  };
  let start = 0;
  let end = matching.length;
  if (args.after != null) start = position(args.after) + 1;
  if (args.before != null) end = position(args.before);
  let from = start;
  let to = Math.max(start, end);
  if (first != null) to = Math.min(to, from + first);
  if (last != null) from = Math.max(from, to - last);
  const slice = matching.slice(from, to);
  const cursors = slice.map((order) => shopCursor(order, sortKey));
  return {
    edges: slice.map((order, index) => ({ cursor: cursors[index], node: orderView(order) })),
    nodes: slice.map(orderView),
    pageInfo: {
      hasNextPage: to < matching.length,
      hasPreviousPage: from > 0,
      startCursor: cursors[0] ?? null,
      endCursor: cursors[cursors.length - 1] ?? null,
    },
  };
};

const executeShop = (
  typeName: string,
  source: unknown,
  selections: readonly GqlSelection[],
  context: GqlContext,
  warnings: SearchWarning[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of collectFields(typeName, selections, context.doc)) {
    const key = field.alias ?? field.name;
    if (field.name === "__typename") {
      out[key] = typeName;
      continue;
    }
    if (typeName === "QueryRoot" && (field.name === "__schema" || field.name === "__type"))
      throw new GqlError(
        `Introspection is disabled on this endpoint. The schema is published at https://${S_DOCS}/docs/admin-api/schema.graphql`,
        "INTROSPECTION_DISABLED",
      );
    const def = SHOP_SCHEMA[typeName]?.[field.name];
    if (!def) throw new GqlError(`Field '${field.name}' doesn't exist on type '${typeName}'`, "undefinedField");
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(field.args)) {
      if (!def.args?.includes(name))
        throw new GqlError(`Field '${field.name}' doesn't accept argument '${name}'`, "argumentNotAccepted");
      args[name] = argValue(value, context.vars);
    }
    let raw: unknown;
    if (typeName === "QueryRoot") {
      if (field.name === "orders") raw = resolveShopOrders(args, warnings);
      else if (field.name === "order") {
        const found = shopOrders.find((order) => order.id === args.id);
        raw = found ? orderView(found) : null;
      } else
        raw = {
          id: "gid://shopwell/Shop/88210",
          name: "Juniper & Vine",
          currencyCode: "USD",
          ianaTimezone: "America/Chicago",
          myshopwellDomain: "juniper-vine.myshopwell.bench.test",
        };
    } else raw = (source as Record<string, unknown>)[field.name] ?? null;
    const objectType = SHOP_SCHEMA[def.type] ? def.type : null;
    if (objectType) {
      const inner = field.selections;
      if (!inner)
        throw new GqlError(
          `Field must have selections (field '${field.name}' returns ${def.type} but has no selections. Did you mean '${field.name} { ... }'?)`,
          "selectionMismatch",
        );
      out[key] =
        raw === null
          ? null
          : def.list
            ? (raw as unknown[]).map((item) => executeShop(objectType, item, inner, context, warnings))
            : executeShop(objectType, raw, inner, context, warnings);
    } else {
      if (field.selections)
        throw new GqlError(
          `Selections can't be made on scalars (field '${field.name}' returns ${def.type} but has selections)`,
          "selectionMismatch",
        );
      out[key] = raw;
    }
  }
  return out;
};

const runShopQuery = (query: string, variables: unknown, operationName: unknown): Record<string, unknown> => {
  try {
    const doc = parseGql(query);
    const operation =
      typeof operationName === "string" && operationName
        ? doc.operations.find((one) => one.name === operationName)
        : doc.operations.length === 1
          ? doc.operations[0]
          : undefined;
    if (!operation)
      throw new GqlError(
        typeof operationName === "string" && operationName
          ? `No operation named "${operationName}"`
          : "An operation name is required when the document has more than one operation",
      );
    if (operation.type !== "query")
      throw new GqlError(`Access denied for ${operation.type}. Required access: \`write_orders\` access scope.`, "ACCESS_DENIED");
    const provided = variables && typeof variables === "object" ? (variables as Record<string, unknown>) : {};
    const vars: Record<string, unknown> = {};
    for (const variable of operation.variables)
      vars[variable.name] =
        variable.name in provided ? provided[variable.name] : variable.defaultValue ? argValue(variable.defaultValue, {}) : null;
    const context = { doc, vars };
    const cost = queryCost("QueryRoot", operation.selections, context);
    if (cost > S_MAX_COST)
      return {
        errors: [
          {
            message: `Query cost is ${cost}, which exceeds the single query max cost limit (${S_MAX_COST}).`,
            extensions: { code: "MAX_COST_EXCEEDED", cost, maxCost: S_MAX_COST },
          },
        ],
      };
    const warnings: SearchWarning[] = [];
    const data = executeShop("QueryRoot", null, operation.selections, context, warnings);
    return {
      data,
      extensions: {
        cost: {
          requestedQueryCost: cost,
          actualQueryCost: cost,
          throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 2000 - cost, restoreRate: 100 },
        },
        ...(warnings.length > 0 ? { search: [{ path: ["orders"], warnings }] } : {}),
      },
    };
  } catch (error) {
    if (error instanceof GqlError) return { errors: [{ message: error.message, extensions: { code: error.code } }] };
    throw error;
  }
};

const SHOP_SDL = `"""
The Shopwell Admin API, version 2026-07. Read-only types only; the full
mutation surface is documented separately.
"""
schema {
  query: QueryRoot
}

"""An ISO-8601 date and time in UTC, e.g. "2026-08-14T17:05:33Z"."""
scalar DateTime
"""A decimal number sent as a string, e.g. "129.50"."""
scalar Decimal
"""A monetary value in the shop's currency, as a decimal string."""
scalar Money

enum CurrencyCode { USD CAD EUR GBP AUD }
enum OrderDisplayFinancialStatus { PENDING AUTHORIZED PARTIALLY_PAID PAID PARTIALLY_REFUNDED REFUNDED VOIDED EXPIRED }
enum OrderDisplayFulfillmentStatus { UNFULFILLED PARTIALLY_FULFILLED FULFILLED RESTOCKED }
enum OrderCancelReason { CUSTOMER DECLINED FRAUD INVENTORY STAFF OTHER }
enum OrderSortKeys { ID CREATED_AT PROCESSED_AT TOTAL_PRICE ORDER_NUMBER }

type QueryRoot {
  shop: Shop!
  order(id: ID!): Order
  """
  Orders, in ascending ID order unless sortKey or reverse say otherwise.
  query takes the search syntax described in the guide.
  """
  orders(
    first: Int
    after: String
    last: Int
    before: String
    query: String
    sortKey: OrderSortKeys = ID
    reverse: Boolean = false
  ): OrderConnection!
}

type Shop {
  id: ID!
  name: String!
  currencyCode: CurrencyCode!
  ianaTimezone: String!
  myshopwellDomain: String!
}

type OrderConnection {
  edges: [OrderEdge!]!
  nodes: [Order!]!
  pageInfo: PageInfo!
}

type OrderEdge {
  cursor: String!
  node: Order!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type Order {
  id: ID!
  """The number shown to the customer, e.g. "#1024"."""
  name: String!
  email: String
  createdAt: DateTime!
  processedAt: DateTime!
  """When the order was cancelled; null for an order that was not."""
  cancelledAt: DateTime
  cancelReason: OrderCancelReason
  displayFinancialStatus: OrderDisplayFinancialStatus
  displayFulfillmentStatus: OrderDisplayFulfillmentStatus!
  """True for an order placed through the test payment gateway. Test orders are not sales."""
  test: Boolean!
  tags: [String!]!
  currencyCode: CurrencyCode!
  """The total at checkout, in the shop's currency."""
  totalPrice: Money! @deprecated(reason: "Use totalPriceSet.shopMoney.amount instead.")
  """The total at checkout, in the shop's and the customer's currencies."""
  totalPriceSet: MoneyBag!
  """The total after refunds and removed items."""
  currentTotalPriceSet: MoneyBag!
  customer: Customer
}

type MoneyBag {
  shopMoney: MoneyV2!
  presentmentMoney: MoneyV2!
}

type MoneyV2 {
  amount: Decimal!
  currencyCode: CurrencyCode!
}

type Customer {
  id: ID!
  displayName: String!
  firstName: String
  lastName: String
  email: String
}
`;

const SHOP_EXAMPLE = `query RecentOrders($after: String) {
  orders(first: 50, after: $after, sortKey: CREATED_AT, reverse: true) {
    edges {
      cursor
      node {
        id
        name
        createdAt
        displayFinancialStatus
        totalPriceSet { shopMoney { amount currencyCode } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const shopwellDocs = page(
  "Shopwell Admin API — GraphQL reference",
  `<header><p>Shopwell Developers</p><h1>Admin API</h1><p>Version 2026-07 · GraphQL</p></header>
<nav><a href="#auth">Authentication</a> · <a href="#endpoint">Endpoint</a> · <a href="#schema">Schema</a> · <a href="#pagination">Pagination</a> · <a href="#limits">Rate limits</a> · <a href="#search">Search syntax</a> · <a href="#orders">Orders</a> · <a href="#errors">Errors</a></nav>
<main>
<h2 id="auth">Authentication</h2>
<p>Create a custom app in your store admin under <b>Settings → Apps → Develop apps</b>, give it the <code>read_orders</code> access scope, and install it. Its <b>Admin API access token</b> starts with <code>swat_</code> and is shown once. Send it with every request in the <code>X-Shopwell-Access-Token</code> header.</p>
<h2 id="endpoint">Endpoint</h2>
<pre>POST https://${S_API}/admin/2026-07/graphql.json
Content-Type: application/json
X-Shopwell-Access-Token: {access_token}

{"query": "…", "variables": {…}}</pre>
<p>The version in the path is required. Each version is supported for twelve months; a request for one that is no longer supported is answered by the oldest supported version, and the <code>X-Shopwell-API-Version</code> response header says which answered.</p>
<h2 id="schema">Schema</h2>
<p>The schema is published as SDL at <a href="/docs/admin-api/schema.graphql">schema.graphql</a>. Introspection is turned off on the production endpoint.</p>
<h2 id="pagination">Pagination</h2>
<p>Lists are Relay-style connections. Ask for a page with <code>first</code> (at most 250), then pass the page's <code>pageInfo.endCursor</code> as <code>after</code> for the next one, for as long as <code>pageInfo.hasNextPage</code> is true. Every connection offers both <code>edges { cursor node { … } }</code> and the shorter <code>nodes { … }</code>.</p>
<h2 id="limits">Rate limits</h2>
<p>Queries are limited by calculated cost rather than by request count. Each object costs 1 point, each connection 2 points plus its <code>first</code> (or <code>last</code>) times the cost of one node, and scalar fields cost nothing. <strong>A single query may cost at most 1,000 points</strong>; one that would cost more is refused before it runs. Your app's bucket holds 2,000 points and refills at 100 points a second. Every response reports its cost under <code>extensions.cost</code>.</p>
<h2 id="search">Search syntax</h2>
<p>The <code>query</code> argument of <code>orders</code> takes <code>field:value</code> terms separated by spaces; every term must match. Prefix a term with <code>-</code> to exclude. Dates take <code>&gt;</code>, <code>&gt;=</code>, <code>&lt;</code> or <code>&lt;=</code>.</p>
<table>
<tr><th>Field</th><th>Values</th></tr>
<tr><td><code>financial_status</code></td><td>paid, pending, authorized, partially_refunded, refunded, voided</td></tr>
<tr><td><code>status</code></td><td>open, closed, cancelled, any</td></tr>
<tr><td><code>fulfillment_status</code></td><td>shipped, unshipped, partial</td></tr>
<tr><td><code>test</code></td><td>true, false</td></tr>
<tr><td><code>created_at</code>, <code>processed_at</code></td><td>a date, e.g. <code>created_at:&gt;=2026-01-01</code></td></tr>
<tr><td><code>tag</code>, <code>email</code>, <code>name</code></td><td>exact values</td></tr>
</table>
<p>A field the search does not know is ignored, and reported under <code>extensions.search</code>.</p>
<h2 id="orders">Orders</h2>
<p><code>displayFinancialStatus</code> is PAID, PENDING, AUTHORIZED, PARTIALLY_REFUNDED, REFUNDED or VOIDED. <code>cancelledAt</code> is set when an order is cancelled; a cancelled order keeps its financial status until its refund settles. <code>test</code> is true for orders placed through the test payment gateway — they are not real sales. Totals are decimal strings in the shop's currency. <code>totalPrice</code> is deprecated: use <code>totalPriceSet { shopMoney { amount } }</code>, or <code>currentTotalPriceSet</code> for the total after refunds.</p>
<h3>Example</h3>
<pre>${esc(SHOP_EXAMPLE)}</pre>
<p>This query costs 252 points: 2 for the connection, plus 50 × (1 edge + 1 order + 1 price set + 1 money), plus 1 for <code>pageInfo</code>.</p>
<h3>Response</h3>
<pre>{
  "data": { "orders": { "edges": [ { "cursor": "eyJsYXN0X2lkIjo…", "node": { "id": "gid://shopwell/Order/5315967", "name": "#1458", … } } ],
                        "pageInfo": { "hasNextPage": true, "endCursor": "eyJsYXN0X2lkIjo…" } } },
  "extensions": { "cost": { "requestedQueryCost": 252, "actualQueryCost": 252,
                            "throttleStatus": { "maximumAvailable": 2000, "currentlyAvailable": 1748, "restoreRate": 100 } } }
}</pre>
<h2 id="errors">Errors</h2>
<p>A query that cannot run is answered with HTTP 200, an <code>errors</code> list and no <code>data</code>. A missing or wrong access token is answered with 401.</p>
</main>`,
);

export const shopwell: MockProvider = {
  id: "shopwell",
  split: "heldout",
  pattern:
    "GraphQL store admin: Relay connections, a per-query cost ceiling, a search string in an argument, decimal-string money, test and cancelled orders to leave out, introspection off with the schema as SDL",
  hosts: [S_API, S_DOCS],
  docsUrl: `https://${S_DOCS}/docs/admin-api`,
  credentials: [S_TOKEN],
  credentialLabels: ["Admin API access token"],
  reference: {
    connection: {
      id: "shopwell",
      title: "Shopwell",
      kind: "rest",
      baseUrl: `https://${S_API}/admin/2026-07`,
      auth: { type: "header", header: "X-Shopwell-Access-Token", keyRef: "shopwell-token", label: "Admin API access token" },
      ops: [
        {
          id: "orders",
          title: "Orders",
          method: "POST",
          path: "/graphql.json",
          body: {
            type: "graphql",
            query:
              "query Orders($after: String) { orders(first: 100, after: $after) { nodes { id name displayFinancialStatus cancelledAt test totalPrice } pageInfo { hasNextPage endCursor } } }",
            variables: {},
          },
          readSafety: { basis: "graphql-query" },
          rowsPath: "$.data.orders.nodes",
          pagination: {
            kind: "cursor",
            param: "after",
            cursorPath: "$.data.orders.pageInfo.endCursor",
            hasMorePath: "$.data.orders.pageInfo.hasNextPage",
            in: "body",
          },
          maxPages: 10,
        },
      ],
    },
    secrets: { "shopwell-token": S_TOKEN },
  },
  objectives: [
    {
      id: "paid-revenue",
      request: "What's our total revenue from paid orders? Leave out cancelled orders and test orders.",
      answer: major(
        shopOrders
          .filter((order) => order.financial === "PAID" && order.cancelledAt === null && !order.test)
          .reduce((sum, order) => sum + order.totalCents, 0),
      ),
      tolerance: 0.005,
      records: shopOrders.length,
      scripted: {
        path: "/graphql.json",
        measure: {
          agg: "sum",
          field: "totalPrice",
          where: 'displayFinancialStatus == "PAID" && cancelledAt == null && test == false',
        },
      },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === S_DOCS) {
      if (url.pathname === "/docs/admin-api" || url.pathname === "/docs/admin-api/") return shopwellDocs;
      if (url.pathname === "/docs/admin-api/schema.graphql") return textAs("text/plain; charset=utf-8", SHOP_SDL);
      return notFound();
    }
    const route = /^\/admin\/(\d{4}-\d{2})\/graphql\.json$/.exec(url.pathname);
    if (!route) return json({ errors: "Not Found" }, 404);
    if (request.headers["x-shopwell-access-token"] !== S_TOKEN)
      return json({ errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" }, 401);
    if (request.method !== "POST")
      return json({ errors: "The Admin API accepts POST requests with a JSON body: {\"query\": …, \"variables\": …}." }, 405);
    const asked = route[1]!;
    const version = (S_VERSIONS as readonly string[]).includes(asked) ? asked : S_VERSIONS[0];
    let query: unknown;
    let variables: unknown;
    let operationName: unknown;
    if ((request.headers["content-type"] ?? "").includes("application/graphql")) query = request.body;
    else {
      const parsed = bodyJson(request.body);
      query = parsed.query;
      variables = parsed.variables;
      operationName = parsed.operationName;
    }
    if (typeof query !== "string" || !query.trim())
      return json({ errors: [{ message: "No query string was present" }] }, 400);
    return json(runShopQuery(query, variables, operationName), 200, { "x-shopwell-api-version": version });
  },
};

/* ── Deskpoint: a helpdesk whose list hides old tickets unless asked ──── */

/*
 * A support desk API after the widely used hosted helpdesks: an address per
 * account, HTTP Basic with the API key as the username and any character as
 * the password, statuses as numbers explained in another endpoint, pages by
 * `Link` header — and a list that, by default, returns only tickets created
 * in the last thirty days. Asking for everything takes `updated_since`.
 */

const D_DOMAIN = "brightside";
const D_HOST = `${D_DOMAIN}.deskpoint.bench.test`;
const D_DOCS = "developers.deskpoint.bench.test";
const D_KEY = "dpk_Q2x7pLm4Rt9Vn3Ws";
const D_LIMIT = 200;

interface DeskTicket {
  readonly id: number;
  readonly subject: string;
  readonly status: number;
  readonly priority: number;
  readonly source: number;
  readonly type: string;
  readonly requesterId: number;
  readonly responderId: number | null;
  readonly groupId: number;
  readonly created: number;
  readonly updated: number;
  readonly tags: readonly string[];
  readonly region: string;
  readonly spam: boolean;
  readonly deleted: boolean;
}

const DESK_SUBJECTS = [
  "Can't log in after password reset", "Invoice shows the wrong address", "Refund for duplicate charge",
  "How do I export my data?", "App crashes when uploading photos", "Change the email on my account",
  "Order arrived damaged", "Question about the annual plan", "Two-factor codes not arriving",
  "Feature request: dark mode", "Shipping to Canada?", "Cancel my subscription",
] as const;

const deskTickets: readonly DeskTicket[] = (() => {
  const next = random(12022);
  const count = 540;
  return Array.from({ length: count }, (_, index): DeskTicket => {
    const created = BENCH_NOW - Math.floor((count - index) * 1.32 * DAY) + Math.floor(next() * 0.8 * DAY);
    const recent = BENCH_NOW - created < 45 * DAY;
    const status = recent ? pick(next, [2, 2, 2, 3, 3, 6, 4, 5]) : pick(next, [5, 5, 5, 5, 4, 4, 2, 3]);
    return {
      id: 1000 + index,
      subject: pick(next, DESK_SUBJECTS),
      status,
      priority: pick(next, [1, 1, 2, 2, 2, 3, 4]),
      source: pick(next, [1, 1, 2, 3, 7, 9, 10]),
      type: pick(next, ["Question", "Question", "Incident", "Problem", "Feature Request"] as const),
      requesterId: 8_800_000 + Math.floor(next() * 400),
      responderId: next() < 0.2 ? null : 5_100_000 + Math.floor(next() * 6),
      groupId: pick(next, [301, 302, 303]),
      created,
      updated: Math.min(BENCH_NOW - HOUR, created + Math.floor(next() * 25 * DAY)),
      tags: next() < 0.3 ? ["billing"] : next() < 0.2 ? ["vip"] : [],
      region: pick(next, ["North America", "Europe", "APAC"] as const),
      spam: next() < 0.03,
      deleted: next() < 0.04,
    };
  });
})();

const deskListed = deskTickets.filter((ticket) => !ticket.spam && !ticket.deleted);

const deskStamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const deskTicketView = (ticket: DeskTicket, include: ReadonlySet<string>): Record<string, unknown> => ({
  cc_emails: [],
  fwd_emails: [],
  reply_cc_emails: [],
  fr_escalated: ticket.status === 2 && BENCH_NOW - ticket.created > 2 * DAY,
  spam: ticket.spam,
  email_config_id: null,
  group_id: ticket.groupId,
  priority: ticket.priority,
  requester_id: ticket.requesterId,
  responder_id: ticket.responderId,
  source: ticket.source,
  company_id: null,
  status: ticket.status,
  subject: ticket.subject,
  product_id: null,
  id: ticket.id,
  type: ticket.type,
  due_by: deskStamp(ticket.created + 3 * DAY),
  fr_due_by: deskStamp(ticket.created + DAY),
  is_escalated: false,
  custom_fields: { cf_region: ticket.region },
  created_at: deskStamp(ticket.created),
  updated_at: deskStamp(ticket.updated),
  associated_tickets_count: null,
  tags: ticket.tags,
  ...(ticket.deleted ? { deleted: true } : {}),
  ...(include.has("requester")
    ? { requester: { id: ticket.requesterId, name: `Customer ${ticket.requesterId}`, email: `c${ticket.requesterId}@example.com` } }
    : {}),
  ...(include.has("stats")
    ? {
        stats: {
          agent_responded_at: ticket.responderId ? deskStamp(ticket.created + 2 * HOUR) : null,
          resolved_at: ticket.status >= 4 ? deskStamp(ticket.updated) : null,
          closed_at: ticket.status === 5 ? deskStamp(ticket.updated) : null,
        },
      }
    : {}),
});

const deskInvalid = (field: string, message: string): BenchResponse =>
  json({ description: "Validation failed", errors: [{ field, message, code: "invalid_value" }] }, 400);

const deskpointSpec = {
  openapi: "3.0.3",
  info: {
    title: "Deskpoint API",
    version: "2",
    description:
      "The Deskpoint helpdesk API. Every helpdesk has its own address: https://{domain}.deskpoint.bench.test/api/v2.\n\n" +
      "**Authentication.** HTTP Basic. Use your API key as the username and any single character — X, say — as the password. " +
      "Your API key is on your profile page (click your picture → Profile settings → **Your API Key**).\n\n" +
      "**Rate limits.** Each helpdesk may make 200 calls a minute. Every response carries X-Ratelimit-Total, X-Ratelimit-Remaining " +
      "and X-Ratelimit-Used-CurrentRequest; asking to include related records costs one more call per include. Past the limit, " +
      "requests are refused with 429 and a Retry-After header in seconds.",
  },
  servers: [
    {
      url: "https://{domain}.deskpoint.bench.test/api/v2",
      variables: { domain: { default: "yourcompany", description: "Your helpdesk's domain, as in yourcompany.deskpoint.bench.test" } },
    },
  ],
  components: {
    securitySchemes: {
      basicAuth: {
        type: "http",
        scheme: "basic",
        description: "Username: your API key. Password: any character, such as X.",
      },
    },
    schemas: {
      Ticket: {
        type: "object",
        properties: {
          id: { type: "integer" },
          subject: { type: "string" },
          status: {
            type: "integer",
            description:
              "2 Open, 3 Pending, 4 Resolved, 5 Closed. A helpdesk may add its own statuses, numbered 6 and up; their names are in GET /ticket_fields.",
          },
          priority: { type: "integer", description: "1 Low, 2 Medium, 3 High, 4 Urgent" },
          source: { type: "integer", description: "1 Email, 2 Portal, 3 Phone, 7 Chat, 9 Feedback widget, 10 Outbound email" },
          type: { type: "string" },
          requester_id: { type: "integer" },
          responder_id: { type: "integer", nullable: true },
          group_id: { type: "integer" },
          spam: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          custom_fields: { type: "object" },
          due_by: { type: "string", format: "date-time" },
          fr_due_by: { type: "string", format: "date-time" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
    },
  },
  security: [{ basicAuth: [] }],
  paths: {
    "/tickets": {
      get: {
        operationId: "listTickets",
        summary: "List all tickets",
        description:
          "By default, only tickets that were created within the past 30 days are returned. To get older tickets, use updated_since. " +
          "Spam and deleted tickets are left out unless you ask for them with filter. " +
          "Results are paginated: 30 tickets a page by default, up to 100 with per_page. When there are more, the response has a " +
          'Link header with rel="next" giving the next page\'s URL.',
        parameters: [
          {
            name: "filter",
            in: "query",
            schema: { type: "string", enum: ["new_and_my_open", "watching", "spam", "deleted"] },
            description: "A predefined filter.",
          },
          { name: "requester_id", in: "query", schema: { type: "integer" } },
          { name: "email", in: "query", schema: { type: "string" } },
          {
            name: "updated_since",
            in: "query",
            schema: { type: "string", format: "date-time" },
            description: "Only tickets updated since this time, e.g. 2015-01-19T02:00:00Z.",
          },
          {
            name: "order_by",
            in: "query",
            schema: { type: "string", enum: ["created_at", "due_by", "updated_at", "status"], default: "created_at" },
          },
          { name: "order_type", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
          { name: "include", in: "query", schema: { type: "string", enum: ["requester", "stats"] }, description: "Each include costs one more call." },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "per_page", in: "query", schema: { type: "integer", default: 30, maximum: 100 } },
        ],
        responses: {
          "200": {
            description: "Tickets",
            headers: { Link: { schema: { type: "string" }, description: 'The next page, as <url>; rel="next". Absent on the last page.' } },
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Ticket" } } } },
          },
          "401": { description: "The API key is wrong or missing." },
          "429": { description: "Rate limit reached. Retry after the Retry-After header's number of seconds." },
        },
      },
    },
    "/tickets/{id}": {
      get: {
        operationId: "viewTicket",
        summary: "View a ticket",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "The ticket", content: { "application/json": { schema: { $ref: "#/components/schemas/Ticket" } } } } },
      },
    },
    "/ticket_fields": {
      get: {
        operationId: "listTicketFields",
        summary: "List the ticket fields, with the name of every status",
        responses: { "200": { description: "Ticket fields", content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } } },
      },
    },
  },
};

const DESK_FIELDS = [
  {
    id: 60000401,
    name: "status",
    label: "Status",
    type: "default_status",
    choices: {
      "2": ["Open", "Being Processed"],
      "3": ["Pending", "Awaiting your Reply"],
      "4": ["Resolved", "This ticket has been Resolved"],
      "5": ["Closed", "This ticket has been Closed"],
      "6": ["Waiting on Third Party", "Being Processed"],
    },
  },
  { id: 60000402, name: "priority", label: "Priority", type: "default_priority", choices: { Low: 1, Medium: 2, High: 3, Urgent: 4 } },
  {
    id: 60000403,
    name: "source",
    label: "Source",
    type: "default_source",
    choices: { Email: 1, Portal: 2, Phone: 3, Chat: 7, "Feedback Widget": 9, "Outbound Email": 10 },
  },
  { id: 60000404, name: "ticket_type", label: "Type", type: "default_ticket_type", choices: ["Question", "Incident", "Problem", "Feature Request"] },
  { id: 60000405, name: "cf_region", label: "Region", type: "custom_dropdown", choices: ["North America", "Europe", "APAC"] },
];

let deskUsed = 0;

export const deskpoint: MockProvider = {
  id: "deskpoint",
  split: "heldout",
  pattern:
    "Helpdesk on a per-account host: Basic auth with the key as username and X as password, a list that hides tickets older than 30 days unless updated_since is sent, numeric statuses, Link-header pages",
  hosts: [D_HOST, D_DOCS],
  docsUrl: `https://${D_DOCS}/api/v2/openapi.json`,
  credentials: [D_DOMAIN, D_KEY],
  credentialLabels: ["Helpdesk domain", "Your API Key"],
  reset() {
    deskUsed = 0;
  },
  reference: {
    connection: {
      id: "deskpoint",
      title: "Deskpoint",
      kind: "rest",
      baseUrl: `https://${D_HOST}/api/v2`,
      auth: {
        type: "basic",
        usernameRef: "deskpoint-key",
        keyRef: "deskpoint-password",
        usernameLabel: "Your API Key",
        label: "Password (any character)",
      },
      ops: [
        {
          id: "tickets",
          title: "List all tickets",
          path: "/tickets",
          query: { updated_since: "2015-01-01T00:00:00Z", per_page: 100 },
          pagination: { kind: "link-header" },
          maxPages: 20,
        },
      ],
    },
    secrets: { "deskpoint-key": D_KEY, "deskpoint-password": "X" },
  },
  objectives: [
    {
      id: "open-tickets",
      request: "How many tickets are open right now?",
      answer: deskListed.filter((ticket) => ticket.status === 2).length,
      tolerance: 0,
      records: deskListed.length,
      scripted: { path: "/tickets", measure: { agg: "count", where: "status == 2" } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === D_DOCS) {
      if (url.pathname === "/api/v2/openapi.json") return json(deskpointSpec);
      return notFound();
    }
    const pair = basicPair(request);
    if (!pair || pair[0] !== D_KEY)
      return json({ code: "invalid_credentials", message: "You have to be logged in to perform this action." }, 401);
    const include = new Set((url.searchParams.get("include") ?? "").split(",").filter(Boolean));
    deskUsed += 1 + include.size;
    const limits = {
      "x-ratelimit-total": String(D_LIMIT),
      "x-ratelimit-remaining": String(Math.max(0, D_LIMIT - deskUsed)),
      "x-ratelimit-used-currentrequest": String(1 + include.size),
    };
    if (deskUsed > D_LIMIT) return json({ message: "You have exceeded the limit of requests per minute" }, 429, { ...limits, "retry-after": "60" });
    if (request.method !== "GET") return json({ code: "method_not_allowed", message: "Only GET is available to this key." }, 405, limits);
    if (url.pathname === "/api/v2/ticket_fields") return json(DESK_FIELDS, 200, limits);
    const one = /^\/api\/v2\/tickets\/(\d+)$/.exec(url.pathname);
    if (one) {
      const ticket = deskTickets.find((each) => each.id === Number(one[1]) && !each.deleted);
      return ticket ? json(deskTicketView(ticket, include), 200, limits) : json({ code: "access_denied", message: "Not found" }, 404, limits);
    }
    if (url.pathname !== "/api/v2/tickets") return json({ code: "invalid_url", message: "This URL is not supported." }, 404, limits);

    const known = new Set(["filter", "requester_id", "email", "updated_since", "order_by", "order_type", "include", "page", "per_page"]);
    for (const name of url.searchParams.keys())
      if (!known.has(name)) return deskInvalid(name, "Unexpected/invalid field in request");
    for (const name of include) if (name !== "requester" && name !== "stats") return deskInvalid("include", "It should be one/more of: 'requester,stats'");
    const perPage = intParam(request, "per_page", 30);
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) return deskInvalid("per_page", "Has to be greater than 0 and less than 101");
    const pageNumber = intParam(request, "page", 1);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return deskInvalid("page", "Has to be greater than 0");
    const filter = url.searchParams.get("filter");
    if (filter && !["new_and_my_open", "watching", "spam", "deleted"].includes(filter))
      return deskInvalid("filter", "It should be one of these values: 'new_and_my_open,watching,spam,deleted'");
    const since = url.searchParams.get("updated_since");
    const sinceMs = since === null ? null : Date.parse(since);
    if (sinceMs !== null && Number.isNaN(sinceMs)) return deskInvalid("updated_since", "It should be in the 'valid date time' format");

    let tickets: DeskTicket[] =
      filter === "spam"
        ? deskTickets.filter((ticket) => ticket.spam && !ticket.deleted)
        : filter === "deleted"
          ? deskTickets.filter((ticket) => ticket.deleted)
          : filter === "new_and_my_open"
            ? deskListed.filter((ticket) => ticket.status === 2)
            : filter === "watching"
              ? []
              : [...deskListed];
    if (sinceMs !== null) tickets = tickets.filter((ticket) => ticket.updated >= sinceMs);
    else if (!filter) tickets = tickets.filter((ticket) => ticket.created >= BENCH_NOW - 30 * DAY);
    const requester = url.searchParams.get("requester_id");
    if (requester) tickets = tickets.filter((ticket) => ticket.requesterId === Number(requester));
    const email = url.searchParams.get("email");
    if (email) tickets = tickets.filter((ticket) => `c${ticket.requesterId}@example.com` === email.toLowerCase());

    const orderBy = url.searchParams.get("order_by") ?? "created_at";
    if (!["created_at", "due_by", "updated_at", "status"].includes(orderBy))
      return deskInvalid("order_by", "It should be one of these values: 'created_at,due_by,updated_at,status'");
    const orderType = url.searchParams.get("order_type") ?? "desc";
    if (orderType !== "asc" && orderType !== "desc") return deskInvalid("order_type", "It should be one of these values: 'asc,desc'");
    const key = (ticket: DeskTicket): number =>
      orderBy === "updated_at" ? ticket.updated : orderBy === "status" ? ticket.status : ticket.created;
    tickets.sort((a, b) => (key(a) - key(b) || a.id - b.id) * (orderType === "asc" ? 1 : -1));

    const start = (pageNumber - 1) * perPage;
    const slice = tickets.slice(start, start + perPage);
    const headers: Record<string, string> = { ...limits };
    if (start + perPage < tickets.length) {
      const nextUrl = new URL(url.toString());
      nextUrl.searchParams.set("page", String(pageNumber + 1));
      headers.link = `<${nextUrl.toString()}>; rel="next"`;
    }
    return json(slice.map((ticket) => deskTicketView(ticket, include)), 200, headers);
  },
};

/* ── Brightbooks: accounting whose documented paging is out of date ───── */

/*
 * An accounting API after the ones small businesses use for invoicing: a
 * personal token plus an organisation header, PascalCase records, Microsoft
 * JSON dates beside ISO ones, sales invoices and supplier bills in one list,
 * voided and deleted invoices still listed with their amounts — and a
 * specification that documents `page`/`pageSize` paging the API no longer
 * honours. Version 2 pages by `offset`/`limit` (at most 100), and quietly
 * ignores the old parameters, so following the documentation reads the
 * first page again and again.
 */

const B_API = "api.brightbooks.bench.test";
const B_DOCS = "developer.brightbooks.bench.test";
const B_TOKEN = "bbpat_8Hk2QmZr5Wc1Tn6Y";
const B_ORG = "3f9c2e71-0b4d-4a6e-9d2f-5c8a1e7b0d44";

interface BrightInvoice {
  readonly id: string;
  readonly number: string;
  readonly type: "ACCREC" | "ACCPAY";
  readonly status: "DRAFT" | "AUTHORISED" | "PAID" | "VOIDED" | "DELETED";
  readonly contact: { readonly ContactID: string; readonly Name: string };
  readonly date: number;
  readonly due: number;
  readonly updated: number;
  readonly totalCents: number;
  readonly taxCents: number;
  readonly paidCents: number;
  readonly dueCents: number;
}

const uuid = (next: () => number): string =>
  `${hex(next, 8)}-${hex(next, 4)}-4${hex(next, 3)}-${pick(next, ["8", "9", "a", "b"] as const)}${hex(next, 3)}-${hex(next, 12)}`;

const brightContacts = (() => {
  const next = random(12030);
  return COMPANIES.map((name) => ({ ContactID: uuid(next), Name: name }));
})();

const brightInvoices: readonly BrightInvoice[] = (() => {
  const next = random(12033);
  const count = 395;
  let sales = 0;
  return Array.from({ length: count }, (_, index): BrightInvoice => {
    const type = pick(next, ["ACCREC", "ACCREC", "ACCREC", "ACCPAY"] as const);
    const status = pick(next, ["DRAFT", "AUTHORISED", "AUTHORISED", "AUTHORISED", "PAID", "PAID", "PAID", "VOIDED", "DELETED"] as const);
    const date = Date.UTC(2025, 0, 1) + Math.floor(((count - index) / count) * 600) * DAY;
    const totalCents = cents(next, 60, 9_800);
    const taxCents = Math.round(totalCents * 0.0825 / 1.0825);
    const partly = status === "AUTHORISED" && next() < 0.3;
    const paidCents = status === "PAID" ? totalCents : partly ? Math.round(totalCents * (0.1 + next() * 0.6)) : 0;
    if (type === "ACCREC") sales++;
    return {
      id: uuid(next),
      number: type === "ACCREC" ? `INV-${String(4000 + sales).padStart(5, "0")}` : `BILL-${hex(next, 5).toUpperCase()}`,
      type,
      status,
      contact: pick(next, brightContacts),
      date,
      due: date + pick(next, [14, 30, 30, 45]) * DAY,
      updated: Math.min(BENCH_NOW - HOUR, date + Math.floor(next() * 40) * DAY + Math.floor(next() * DAY)),
      totalCents,
      taxCents,
      paidCents,
      dueCents: status === "PAID" ? 0 : totalCents - paidCents,
    };
  });
})();

const netDate = (ms: number): string => `/Date(${ms}+0000)/`;

const brightView = (invoice: BrightInvoice): Record<string, unknown> => ({
  Type: invoice.type,
  InvoiceID: invoice.id,
  InvoiceNumber: invoice.number,
  Reference: invoice.type === "ACCPAY" ? `PO-${invoice.number.slice(-5)}` : "",
  Contact: invoice.contact,
  Date: netDate(invoice.date),
  DateString: new Date(invoice.date).toISOString().slice(0, 19),
  DueDate: netDate(invoice.due),
  DueDateString: new Date(invoice.due).toISOString().slice(0, 19),
  Status: invoice.status,
  LineAmountTypes: "Inclusive",
  SubTotal: major(invoice.totalCents - invoice.taxCents),
  TotalTax: major(invoice.taxCents),
  Total: major(invoice.totalCents),
  AmountDue: major(invoice.dueCents),
  AmountPaid: major(invoice.paidCents),
  AmountCredited: 0,
  CurrencyCode: "USD",
  ...(invoice.status === "PAID" ? { FullyPaidOnDate: isoDay(invoice.updated) } : {}),
  UpdatedDateUTC: netDate(invoice.updated),
  HasAttachments: false,
});

const brightPaging = {
  name: "page",
  in: "query",
  schema: { type: "integer", default: 1, minimum: 1 },
  description: "The page to return, starting at 1.",
};
const brightPageSize = {
  name: "pageSize",
  in: "query",
  schema: { type: "integer", default: 50, maximum: 200 },
  description: "Records per page. The default is 50, the most 200.",
};
const brightPagination = {
  type: "object",
  properties: {
    page: { type: "integer" },
    pageSize: { type: "integer" },
    pageCount: { type: "integer" },
    itemCount: { type: "integer" },
  },
};

const brightbooksSpec = {
  openapi: "3.0.3",
  info: {
    title: "Brightbooks Accounting API",
    version: "2.0",
    description:
      "Read your organisation's invoices, bills and contacts. Every request needs a personal access token and the ID of the organisation to read. " +
      "Lists are paged: pass page (starting at 1) and pageSize (up to 200); the pagination object says how many pages there are.",
  },
  servers: [{ url: `https://${B_API}/v2` }],
  components: {
    securitySchemes: {
      token: {
        type: "http",
        scheme: "bearer",
        description: "A personal access token, from Settings → Developer → Personal access tokens.",
      },
      organisation: {
        type: "apiKey",
        in: "header",
        name: "Brightbooks-Organisation",
        description:
          "Which organisation to read: its Organisation ID, under Settings → Organisation details. One token reaches every organisation its user belongs to.",
      },
    },
    schemas: {
      Contact: { type: "object", properties: { ContactID: { type: "string", format: "uuid" }, Name: { type: "string" } } },
      Invoice: {
        type: "object",
        properties: {
          Type: {
            type: "string",
            enum: ["ACCREC", "ACCPAY"],
            description: "ACCREC is a sales invoice: money owed to you. ACCPAY is a bill from a supplier: money you owe.",
          },
          InvoiceID: { type: "string", format: "uuid" },
          InvoiceNumber: { type: "string" },
          Reference: { type: "string" },
          Contact: { $ref: "#/components/schemas/Contact" },
          Date: { type: "string", description: "The invoice date, as a Microsoft JSON date: /Date(1719792000000+0000)/." },
          DateString: { type: "string", description: "The invoice date as 2026-07-01T00:00:00." },
          DueDate: { type: "string", description: "Microsoft JSON date." },
          DueDateString: { type: "string" },
          Status: {
            type: "string",
            enum: ["DRAFT", "AUTHORISED", "PAID", "VOIDED", "DELETED"],
            description:
              "DRAFT: not yet approved or sent. AUTHORISED: approved and awaiting payment. PAID: paid in full. VOIDED: cancelled after approval. DELETED: a draft that was deleted. Voided and deleted invoices keep their amounts.",
          },
          SubTotal: { type: "number" },
          TotalTax: { type: "number" },
          Total: { type: "number" },
          AmountDue: { type: "number", description: "What is still to be paid." },
          AmountPaid: { type: "number" },
          AmountCredited: { type: "number" },
          CurrencyCode: { type: "string" },
          FullyPaidOnDate: { type: "string", format: "date" },
          UpdatedDateUTC: { type: "string", description: "Microsoft JSON date." },
        },
      },
      Pagination: brightPagination,
    },
  },
  security: [{ token: [], organisation: [] }],
  paths: {
    "/invoices": {
      get: {
        operationId: "getInvoices",
        summary: "List invoices and bills",
        description: "Sales invoices and supplier bills together, newest first.",
        parameters: [
          brightPaging,
          brightPageSize,
          {
            name: "statuses",
            in: "query",
            schema: { type: "string" },
            description: "Only these statuses, comma-separated, e.g. AUTHORISED,PAID.",
          },
          {
            name: "If-Modified-Since",
            in: "header",
            schema: { type: "string", format: "date-time" },
            description: "Only invoices changed since this time.",
          },
        ],
        responses: {
          "200": {
            description: "A page of invoices",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    Invoices: { type: "array", items: { $ref: "#/components/schemas/Invoice" } },
                    pagination: { $ref: "#/components/schemas/Pagination" },
                  },
                },
              },
            },
          },
          "401": { description: "The token is missing or wrong." },
          "403": { description: "The organisation header is missing, or names an organisation this token cannot reach." },
        },
      },
    },
    "/invoices/{InvoiceID}": {
      get: {
        operationId: "getInvoice",
        summary: "One invoice",
        parameters: [{ name: "InvoiceID", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The invoice", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/contacts": {
      get: {
        operationId: "getContacts",
        summary: "List contacts",
        parameters: [brightPaging, brightPageSize],
        responses: {
          "200": {
            description: "A page of contacts",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    Contacts: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
                    pagination: { $ref: "#/components/schemas/Pagination" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/organisation": {
      get: {
        operationId: "getOrganisation",
        summary: "The organisation the header names",
        responses: { "200": { description: "The organisation", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
};

/** What version 2 really does: `offset` and `limit`, the documented `page` and `pageSize` ignored. */
const brightPage = <T>(request: BenchRequest, items: readonly T[]): { slice: readonly T[]; pagination: Record<string, unknown> } => {
  const offset = Math.max(0, Math.floor(intParam(request, "offset", 0)));
  const limit = Math.min(100, Math.max(1, Math.floor(intParam(request, "limit", 50))));
  const pagination: Record<string, unknown> = { offset, limit, itemCount: items.length };
  if (offset + limit < items.length) pagination.next = `/v2${request.url.pathname.slice(3)}?offset=${offset + limit}&limit=${limit}`;
  return { slice: items.slice(offset, offset + limit), pagination };
};

export const brightbooks: MockProvider = {
  id: "brightbooks",
  split: "heldout",
  pattern:
    "Accounting API whose spec documents page/pageSize paging the API silently ignores (it pages by offset/limit, max 100); a token plus an organisation header; sales and bills in one list; voided and deleted invoices keep their amounts",
  hosts: [B_API, B_DOCS],
  docsUrl: `https://${B_DOCS}/openapi/accounting-v2.json`,
  credentials: [B_TOKEN, B_ORG],
  credentialLabels: ["Personal access token", "Organisation ID"],
  reference: {
    connection: {
      id: "brightbooks",
      title: "Brightbooks",
      kind: "rest",
      baseUrl: `https://${B_API}/v2`,
      auth: {
        type: "headers",
        parts: [
          { header: "Authorization", keyRef: "brightbooks-token", template: "Bearer {{key}}", label: "Personal access token" },
          { header: "Brightbooks-Organisation", keyRef: "brightbooks-org", label: "Organisation ID" },
        ],
      },
      ops: [
        {
          id: "invoices",
          title: "List invoices and bills",
          path: "/invoices",
          rowsPath: "$.Invoices",
          pagination: { kind: "offset", param: "offset", limitParam: "limit", pageSize: 100 },
          maxPages: 10,
        },
      ],
    },
    secrets: { "brightbooks-token": B_TOKEN, "brightbooks-org": B_ORG },
  },
  objectives: [
    {
      id: "owed-to-us",
      request: "How much do customers still owe us on invoices we've sent? Leave out drafts and anything voided or deleted.",
      answer: major(
        brightInvoices
          .filter((invoice) => invoice.type === "ACCREC" && invoice.status === "AUTHORISED")
          .reduce((sum, invoice) => sum + invoice.dueCents, 0),
      ),
      tolerance: 0.005,
      records: brightInvoices.length,
      scripted: { path: "/invoices", measure: { agg: "sum", field: "AmountDue", where: 'Type == "ACCREC" && Status == "AUTHORISED"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === B_DOCS) {
      if (url.pathname === "/openapi/accounting-v2.json") return json(brightbooksSpec);
      return notFound();
    }
    const problem = (status: number, title: string, detail: string): BenchResponse =>
      json({ Type: title.replace(/ /g, ""), Title: title, Status: status, Detail: detail }, status);
    if (request.headers.authorization !== `Bearer ${B_TOKEN}`)
      return problem(401, "Unauthorized", "AuthenticationUnsuccessful: the access token is missing, malformed or revoked.");
    if (request.headers["brightbooks-organisation"] !== B_ORG)
      return problem(403, "Forbidden", "AuthorizationUnsuccessful: send the Brightbooks-Organisation header with an organisation this token can reach.");
    if (request.method !== "GET") return problem(405, "Method Not Allowed", "This token can only read.");
    const envelope = { Id: "8d4b0f2e-1c7a-4e59-b3d6-2a9f5e8c1b70", Status: "OK", ProviderName: "Brightbooks", DateTimeUTC: netDate(BENCH_NOW) };

    if (url.pathname === "/v2/organisation")
      return json({ ...envelope, Organisations: [{ OrganisationID: B_ORG, Name: "Cedar Hollow Landscaping", BaseCurrency: "USD", CountryCode: "US" }] });
    if (url.pathname === "/v2/contacts") {
      const { slice, pagination } = brightPage(request, brightContacts);
      return json({ ...envelope, pagination, Contacts: slice });
    }
    const one = /^\/v2\/invoices\/([0-9a-f-]+)$/.exec(url.pathname);
    if (one) {
      const invoice = brightInvoices.find((each) => each.id === one[1]);
      return invoice ? json({ ...envelope, Invoices: [brightView(invoice)] }) : problem(404, "Not Found", "No invoice has that ID.");
    }
    if (url.pathname !== "/v2/invoices") return problem(404, "Not Found", "The resource you're looking for cannot be found.");

    let invoices = [...brightInvoices].sort((a, b) => b.date - a.date || a.number.localeCompare(b.number));
    const statuses = url.searchParams.get("statuses");
    if (statuses) {
      const wanted = new Set(statuses.split(",").map((one) => one.trim().toUpperCase()));
      invoices = invoices.filter((invoice) => wanted.has(invoice.status));
    }
    const since = request.headers["if-modified-since"];
    if (since) {
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) return problem(400, "Bad Request", "If-Modified-Since is not a date.");
      invoices = invoices.filter((invoice) => invoice.updated > sinceMs);
    }
    const { slice, pagination } = brightPage(request, invoices);
    return json({ ...envelope, pagination, Invoices: slice.map(brightView) });
  },
};

/* ── Leasewise: property management documented only in a help article ── */

/*
 * A property-management API with no specification — one help-centre
 * article, in prose. Two values in two headers, a page number handed back in
 * the body, rent as text, dates written three ways (the lease end month
 * first, as it appears on the signed lease), and archived leases — mistakes —
 * still listed, which the article says to leave out.
 */

const LW_API = "api.leasewise.bench.test";
const LW_HELP = "help.leasewise.bench.test";
const LW_KEY = "lw_live_83hd92kqXa7Pz";
const LW_PORTFOLIO = "P-20417";
const LW_PAGE = 50;

const lwProperties = [
  { id: 311, name: "Maple Court", address: "1180 Maple Ave", units: 24 },
  { id: 312, name: "The Linden", address: "42 Linden St", units: 36 },
  { id: 318, name: "Harbor View Lofts", address: "9 Pier Rd", units: 18 },
  { id: 324, name: "Birchwood Townhomes", address: "300 Birchwood Ln", units: 12 },
  { id: 327, name: "Sycamore Flats", address: "77 Sycamore Blvd", units: 30 },
  { id: 331, name: "Cedar Row", address: "15 Cedar Row", units: 8 },
] as const;

interface Lease {
  readonly id: string;
  readonly propertyId: number;
  readonly unit: string;
  readonly tenant: string;
  readonly rentCents: number;
  readonly start: number;
  readonly end: number;
  readonly moveIn: number;
  readonly status: string;
  readonly archived: boolean;
}

const usDate = (ms: number): string => {
  const day = new Date(ms);
  return `${String(day.getUTCMonth() + 1).padStart(2, "0")}/${String(day.getUTCDate()).padStart(2, "0")}/${day.getUTCFullYear()}`;
};

const leases: readonly Lease[] = (() => {
  const next = random(12044);
  const count = 318;
  const all = Array.from({ length: count }, (_, index): Lease => {
    const property = pick(next, lwProperties);
    const startMonth = Math.floor(next() * 42);
    const start = Date.UTC(2023, 5 + startMonth, 1);
    const term = pick(next, [6, 12, 12, 12, 18, 24]);
    const end = Date.UTC(2023, 5 + startMonth + term, 0);
    const moveIn = start + Math.floor(next() * 5) * DAY;
    const status =
      start > BENCH_NOW ? "future" : end < BENCH_NOW ? "ended" : end - BENCH_NOW < 60 * DAY && next() < 0.6 ? "notice" : "active";
    return {
      id: `L${40_100 + index}`,
      propertyId: property.id,
      unit: `${1 + Math.floor(next() * 4)}${pick(next, ["A", "B", "C", "D"] as const)}`,
      tenant: `${pick(next, FIRST_NAMES)} ${pick(next, LAST_NAMES)}`,
      rentCents: cents(next, 850, 3400),
      start,
      end,
      moveIn,
      status,
      archived: next() < 0.06,
    };
  });
  return all.sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
})();

const leaseView = (lease: Lease): Record<string, unknown> => ({
  id: lease.id,
  property_id: lease.propertyId,
  unit: lease.unit,
  tenant_name: lease.tenant,
  status: lease.status,
  monthly_rent: decimal(lease.rentCents),
  deposit: decimal(lease.rentCents),
  lease_start: isoDay(lease.start),
  lease_end: usDate(lease.end),
  move_in: Math.floor(lease.moveIn / 1000),
  archived: lease.archived,
});

const leasewiseArticle = page(
  "Connecting to the Leasewise API | Leasewise Help Center",
  `<header><a href="/">Leasewise Help Center</a> › Integrations</header>
<article>
<h1>Connecting to the Leasewise API</h1>
<p><em>Updated March 2026 · 6 minute read</em></p>
<p>The Leasewise API lets you read your portfolio's properties and leases from your own tools and spreadsheets. It is read-only: nothing you do through it changes your data.</p>
<h2>Before you start</h2>
<p>An account owner can create an API key under <strong>Settings → Integrations → API access</strong>. That page shows two values. The first is the <strong>API key</strong> itself, which is shown only once, so copy it somewhere safe. The second is your <strong>Portfolio number</strong>, which looks like P-12345 and never changes. You need both.</p>
<h2>Making a request</h2>
<p>All requests go to <code>https://${LW_API}/v2</code>. Send your API key in a header called <code>X-Leasewise-Key</code>, and your portfolio number in a header called <code>X-Portfolio</code>. A request without the key is refused with a 401 error; a request without the portfolio number is refused with a 400 error that says so.</p>
<h2>Leases</h2>
<p>To read leases, send a GET request to <code>/leases</code>. Leases come back in a list called <code>leases</code>, fifty at a time, starting with the most recent. Each response also carries a <code>next_page</code> number: send it back as the <code>page</code> query parameter to get the next fifty. On the last page, <code>next_page</code> is null.</p>
<p>If you only want leases in one state, add <code>status=active</code> — or <code>notice</code> (the tenant has given notice), <code>ended</code> or <code>future</code>.</p>
<p>Each lease has an <code>id</code>, the <code>property_id</code> and <code>unit</code> it is for, the <code>tenant_name</code>, its <code>status</code>, and the <code>monthly_rent</code> and <code>deposit</code> in dollars, written as text such as "1450.00".</p>
<p>Dates are written the way our older import tools wrote them, so they differ from one field to the next. <code>lease_start</code> is a date like 2025-03-01. <code>lease_end</code> is written the way it appears on the signed lease, month first, like 03/31/2026. <code>move_in</code> is a Unix timestamp in seconds.</p>
<p>Leases that have been archived are still returned, with <code>archived</code> set to true. Archiving is how a lease that was entered by mistake is removed, so archived leases should be left out of any totals or counts.</p>
<h2>Properties</h2>
<p>A GET request to <code>/properties</code> returns every property in the portfolio in one response, as a list called <code>properties</code>, with each property's <code>id</code>, <code>name</code>, <code>address</code> and number of <code>units</code>.</p>
<h2>Limits</h2>
<p>You can make up to 60 requests a minute. If you go over, wait a minute and try again.</p>
<h2>Still need help?</h2>
<p>Our support team can't write integrations for you, but they're happy to check that your key works. Write to us from the chat bubble in the corner.</p>
</article>`,
);

export const leasewise: MockProvider = {
  id: "leasewise",
  split: "heldout",
  pattern:
    "Property management documented only in a prose help article: two headers, a page number handed back in the body, rent as text, dates in three formats, archived leases listed but to be left out",
  hosts: [LW_API, LW_HELP],
  docsUrl: `https://${LW_HELP}/articles/connecting-to-the-leasewise-api`,
  credentials: [LW_KEY, LW_PORTFOLIO],
  credentialLabels: ["API key", "Portfolio number"],
  reference: {
    connection: {
      id: "leasewise",
      title: "Leasewise",
      kind: "rest",
      baseUrl: `https://${LW_API}/v2`,
      auth: {
        type: "headers",
        parts: [
          { header: "X-Leasewise-Key", keyRef: "leasewise-key", label: "API key" },
          { header: "X-Portfolio", keyRef: "leasewise-portfolio", label: "Portfolio number" },
        ],
      },
      ops: [
        {
          id: "leases",
          title: "Leases",
          path: "/leases",
          rowsPath: "$.leases",
          pagination: { kind: "cursor", param: "page", cursorPath: "$.next_page" },
          maxPages: 10,
        },
      ],
    },
    secrets: { "leasewise-key": LW_KEY, "leasewise-portfolio": LW_PORTFOLIO },
  },
  objectives: [
    {
      id: "rent-ending-2026",
      request: "What's the total monthly rent across all leases whose end date falls in 2026?",
      answer: major(
        leases
          .filter((lease) => !lease.archived && new Date(lease.end).getUTCFullYear() === 2026)
          .reduce((sum, lease) => sum + lease.rentCents, 0),
      ),
      tolerance: 0.005,
      records: leases.length,
      scripted: {
        path: "/leases",
        measure: { agg: "sum", field: "monthly_rent", where: 'endsWith(lease_end, "/2026") && archived != true' },
      },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === LW_HELP) {
      if (url.pathname === "/articles/connecting-to-the-leasewise-api") return leasewiseArticle;
      if (url.pathname === "/") return page("Leasewise Help Center", `<h1>Leasewise Help Center</h1><ul><li><a href="/articles/connecting-to-the-leasewise-api">Connecting to the Leasewise API</a></li></ul>`);
      return notFound();
    }
    if (request.headers["x-leasewise-key"] !== LW_KEY) return json({ error: "unauthorized", message: "Missing or invalid API key." }, 401);
    const portfolio = request.headers["x-portfolio"];
    if (!portfolio) return json({ error: "portfolio_required", message: "Send your portfolio number in the X-Portfolio header." }, 400);
    if (portfolio !== LW_PORTFOLIO) return json({ error: "forbidden", message: "This key cannot read that portfolio." }, 403);
    if (request.method !== "GET") return json({ error: "method_not_allowed", message: "The API is read-only." }, 405);
    if (url.pathname === "/v2/properties") return json({ portfolio: LW_PORTFOLIO, properties: lwProperties });
    if (url.pathname !== "/v2/leases") return json({ error: "not_found", message: "No such endpoint." }, 404);
    const status = url.searchParams.get("status");
    if (status && !["active", "notice", "ended", "future"].includes(status))
      return json({ error: "bad_request", message: "status must be active, notice, ended or future." }, 400);
    const matching = status ? leases.filter((lease) => lease.status === status) : leases;
    const pageNumber = Math.max(1, Math.floor(intParam(request, "page", 1)));
    const start = (pageNumber - 1) * LW_PAGE;
    return json({
      portfolio: LW_PORTFOLIO,
      page: pageNumber,
      next_page: start + LW_PAGE < matching.length ? pageNumber + 1 : null,
      leases: matching.slice(start, start + LW_PAGE).map(leaseView),
    });
  },
};

/* ── Chargebolt: a card gateway's XML reporting API ───────────────────── */

/*
 * A payment gateway's transaction reporting, after the long-lived XML card
 * gateways: one address, every request an XML POST with the credentials in
 * its body, every answer HTTP 200 (errors included) with a byte-order mark,
 * settled batches listed only for windows of at most 31 days (the last day,
 * by default), and transactions read batch by batch in pages whose `offset`
 * is a page number starting at 1.
 */

const C_API = "api.chargebolt.bench.test";
const C_DOCS = "developer.chargebolt.bench.test";
const C_LOGIN = "7xK9mQ2vPw";
const C_KEY = "4Fz8R2t6Hq9Lw3Yp";
const C_NS = "urn:chargebolt:api:v1";
const C_PAGE_MAX = 100;

interface ChargeTransaction {
  readonly transId: string;
  readonly submitted: number;
  readonly status: string;
  readonly amountCents: number;
  readonly invoice: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly accountType: string;
  readonly last4: string;
}

interface ChargeBatch {
  readonly id: number;
  readonly settled: number;
  readonly transactions: readonly ChargeTransaction[];
}

const chargeBatches: readonly ChargeBatch[] = (() => {
  const next = random(12055);
  const batches: ChargeBatch[] = [];
  let counter = 0;
  for (let day = Date.UTC(2026, 5, 1); day <= Date.UTC(2026, 7, 31); day += DAY) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const count = day === Date.UTC(2026, 6, 3) ? 137 : 1 + Math.floor(next() * 6);
    const transactions = Array.from({ length: count }, (): ChargeTransaction => {
      counter++;
      return {
        transId: String(62_140_000_000 + counter * 17),
        submitted: day + 13 * HOUR + Math.floor(next() * 8 * HOUR),
        status: pick(next, [
          "settledSuccessfully", "settledSuccessfully", "settledSuccessfully", "settledSuccessfully",
          "settledSuccessfully", "settledSuccessfully", "settledSuccessfully", "refundSettledSuccessfully",
          "declined", "voided",
        ] as const),
        amountCents: cents(next, 12, 480),
        invoice: `W${String(20_000 + counter)}`,
        firstName: pick(next, FIRST_NAMES),
        lastName: pick(next, LAST_NAMES),
        accountType: pick(next, ["Visa", "Visa", "MasterCard", "MasterCard", "AmericanExpress", "Discover"] as const),
        last4: String(1000 + Math.floor(next() * 9000)),
      };
    }).sort((a, b) => a.submitted - b.submitted);
    batches.push({ id: 18_400_000 + batches.length * 3, settled: day + 22 * HOUR + Math.floor(next() * 40) * 60_000, transactions });
  }
  return batches;
})();

const chargeTransactions = chargeBatches.flatMap((batch) => batch.transactions);

const xmlTag = (xml: string, name: string): string | null => {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? match[1]!.trim() : null;
};

const utcStamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** The merchant's own time: Pacific, daylight saving all summer. */
const localStamp = (ms: number): string => new Date(ms - 7 * HOUR).toISOString().slice(0, 19);

const chargeXml = (root: string, inner: string, ok = true, code = "I00001", text = "Successful."): BenchResponse =>
  textAs(
    "text/xml; charset=utf-8",
    `\ufeff<?xml version="1.0" encoding="utf-8"?><${root} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="${C_NS}"><messages><resultCode>${ok ? "Ok" : "Error"}</resultCode><message><code>${code}</code><text>${text}</text></message></messages>${inner}</${root}>`,
  );

const chargeError = (root: string, code: string, text: string): BenchResponse => chargeXml(root, "", false, code, text);

const batchXml = (batch: ChargeBatch): string =>
  `<batch><batchId>${batch.id}</batchId><settlementTimeUTC>${utcStamp(batch.settled)}</settlementTimeUTC><settlementTimeLocal>${localStamp(batch.settled)}</settlementTimeLocal><settlementState>settledSuccessfully</settlementState><paymentMethod>creditCard</paymentMethod><marketType>eCommerce</marketType><product>Card Not Present</product></batch>`;

const transactionXml = (one: ChargeTransaction): string =>
  `<transaction><transId>${one.transId}</transId><submitTimeUTC>${utcStamp(one.submitted)}</submitTimeUTC><submitTimeLocal>${localStamp(one.submitted)}</submitTimeLocal><transactionStatus>${one.status}</transactionStatus><invoiceNumber>${one.invoice}</invoiceNumber><firstName>${one.firstName}</firstName><lastName>${one.lastName}</lastName><accountType>${one.accountType}</accountType><accountNumber>XXXX${one.last4}</accountNumber><settleAmount>${decimal(one.amountCents)}</settleAmount><marketType>eCommerce</marketType><product>Card Not Present</product></transaction>`;

/** A dateTime as the gateway reads it: UTC unless it says otherwise. */
const gatewayTime = (value: string): number =>
  Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);

const handleCharge = (body: string): BenchResponse => {
  const text = body.replace(/^\ufeff/, "").trim();
  if (!text.startsWith("<")) return chargeError("ErrorResponse", "E00002", "The content-type specified is not supported. Requests are XML.");
  const root = /^(?:<\?xml[^>]*\?>\s*)?<([A-Za-z]+)([^>]*)>/.exec(text);
  if (!root) return chargeError("ErrorResponse", "E00003", "The request could not be read as XML.");
  const [, name = "", attributes = ""] = root;
  if (!attributes.includes(`xmlns="${C_NS}"`))
    return chargeError("ErrorResponse", "E00045", "The root node does not reference a valid XML namespace.");
  const answer = name.replace(/Request$/, "Response");
  const known = [
    "authenticateTestRequest",
    "getSettledBatchListRequest",
    "getTransactionListRequest",
    "getTransactionDetailsRequest",
    "getUnsettledTransactionListRequest",
  ];
  if (!known.includes(name)) return chargeError("ErrorResponse", "E00003", `The element '${name}' is not a request this API accepts.`);
  const credentials = xmlTag(text, "merchantAuthentication");
  if (!credentials || xmlTag(credentials, "name") !== C_LOGIN || xmlTag(credentials, "transactionKey") !== C_KEY)
    return chargeError(answer, "E00007", "User authentication failed due to invalid authentication values.");

  switch (name) {
    case "authenticateTestRequest":
    case "getUnsettledTransactionListRequest":
      return name === "authenticateTestRequest" ? chargeXml(answer, "") : chargeXml(answer, "", true, "I00004", "No records found.");
    case "getSettledBatchListRequest": {
      const first = xmlTag(text, "firstSettlementDate");
      const last = xmlTag(text, "lastSettlementDate");
      let from = BENCH_NOW - DAY;
      let to = BENCH_NOW;
      if (first || last) {
        if (!first || !last)
          return chargeError(answer, "E00013", "firstSettlementDate and lastSettlementDate must be given together.");
        from = gatewayTime(first);
        to = gatewayTime(last);
        for (const [label, value, ms] of [["firstSettlementDate", first, from], ["lastSettlementDate", last, to]] as const)
          if (Number.isNaN(ms))
            return chargeError(answer, "E00003", `The '${C_NS}:${label}' element is invalid - The value '${value}' is invalid according to its datatype 'dateTime'.`);
        if (to < from) return chargeError(answer, "E00013", "lastSettlementDate is before firstSettlementDate.");
        if (to - from > 31 * DAY) return chargeError(answer, "E00060", "The date range cannot exceed 31 days.");
      }
      const found = chargeBatches.filter((batch) => batch.settled >= from && batch.settled <= to);
      return found.length === 0
        ? chargeXml(answer, "", true, "I00004", "No records found.")
        : chargeXml(answer, `<batchList>${found.map(batchXml).join("")}</batchList>`);
    }
    case "getTransactionListRequest": {
      const batchId = xmlTag(text, "batchId");
      if (!batchId) return chargeError(answer, "E00013", "batchId is required.");
      const batch = chargeBatches.find((one) => String(one.id) === batchId);
      if (!batch) return chargeError(answer, "E00040", "The record cannot be found.");
      const paging = xmlTag(text, "paging");
      let limit = C_PAGE_MAX;
      let offset = 1;
      if (paging) {
        limit = Number(xmlTag(paging, "limit"));
        offset = Number(xmlTag(paging, "offset"));
        if (!Number.isInteger(limit) || limit < 1 || limit > C_PAGE_MAX)
          return chargeError(answer, "E00013", `Paging limit must be between 1 and ${C_PAGE_MAX}.`);
        if (!Number.isInteger(offset) || offset < 1) return chargeError(answer, "E00013", "Paging offset is invalid.");
      }
      const sorting = xmlTag(text, "sorting");
      const descending = sorting ? xmlTag(sorting, "orderDescending") === "true" : false;
      const ordered = descending ? [...batch.transactions].reverse() : batch.transactions;
      const slice = ordered.slice((offset - 1) * limit, offset * limit);
      const total = `<totalNumInResultSet>${batch.transactions.length}</totalNumInResultSet>`;
      return slice.length === 0
        ? chargeXml(answer, total, true, "I00004", "No records found.")
        : chargeXml(answer, `<transactions>${slice.map(transactionXml).join("")}</transactions>${total}`);
    }
    default: {
      const transId = xmlTag(text, "transId");
      const batch = chargeBatches.find((one) => one.transactions.some((each) => each.transId === transId));
      const found = batch?.transactions.find((each) => each.transId === transId);
      if (!batch || !found) return chargeError(answer, "E00040", "The record cannot be found.");
      return chargeXml(
        answer,
        `<transaction><transId>${found.transId}</transId><submitTimeUTC>${utcStamp(found.submitted)}</submitTimeUTC><transactionType>authCaptureTransaction</transactionType><transactionStatus>${found.status}</transactionStatus><batch><batchId>${batch.id}</batchId><settlementTimeUTC>${utcStamp(batch.settled)}</settlementTimeUTC><settlementState>settledSuccessfully</settlementState></batch><order><invoiceNumber>${found.invoice}</invoiceNumber></order><authAmount>${decimal(found.amountCents)}</authAmount><settleAmount>${decimal(found.amountCents)}</settleAmount><payment><creditCard><cardNumber>XXXX${found.last4}</cardNumber><cardType>${found.accountType}</cardType></creditCard></payment><billTo><firstName>${found.firstName}</firstName><lastName>${found.lastName}</lastName></billTo></transaction>`,
      );
    }
  }
};

const CHARGE_AUTH = `<merchantAuthentication>
    <name>API_LOGIN_ID</name>
    <transactionKey>TRANSACTION_KEY</transactionKey>
  </merchantAuthentication>`;

const chargeboltDocs = page(
  "Chargebolt API Reference — Transaction Reporting",
  `<header><p>Chargebolt Developer Center</p><h1>API Reference</h1></header>
<nav><a href="#basics">Basics</a> · <a href="#auth">Authentication</a> · <a href="#responses">Responses</a> · <a href="#batches">Settled batches</a> · <a href="#transactions">Transactions in a batch</a> · <a href="#details">Transaction details</a> · <a href="#statuses">Statuses</a></nav>
<main>
<h2 id="basics">Basics</h2>
<p>Every request is an XML document sent with <code>POST</code> to one address:</p>
<pre>POST https://${C_API}/xml/v1/request.api
Content-Type: text/xml</pre>
<p>The root element names the request, and must carry the namespace <code>xmlns="${C_NS}"</code>; a request without it is refused.</p>
<h2 id="auth">Authentication</h2>
<p>Every request carries a <code>merchantAuthentication</code> element with your <b>API Login ID</b> and <b>Transaction Key</b>. Find both in the merchant interface under <b>Account → Settings → Security Settings → API Credentials &amp; Keys</b>. The Transaction Key is shown once, when it is generated.</p>
<pre>${esc(`<authenticateTestRequest xmlns="${C_NS}">\n  ${CHARGE_AUTH}\n</authenticateTestRequest>`)}</pre>
<h2 id="responses">Responses</h2>
<p>Every response is HTTP 200, errors included, and begins with a UTF-8 byte-order mark. Check <code>messages/resultCode</code>: <code>Ok</code> or <code>Error</code>, with a code and text in <code>messages/message</code>. <code>I00004</code> "No records found." is a success with nothing in it.</p>
<h2 id="batches">getSettledBatchListRequest</h2>
<p>Lists the batches settled between two times. Settlement happens once a business day. <code>firstSettlementDate</code> and <code>lastSettlementDate</code> are dateTime values in UTC; they are optional, but must be given together, and <strong>may be at most 31 days apart</strong>. Without them, the batches of the last 24 hours are returned.</p>
<pre>${esc(`<getSettledBatchListRequest xmlns="${C_NS}">\n  ${CHARGE_AUTH}\n  <firstSettlementDate>2026-05-01T00:00:00Z</firstSettlementDate>\n  <lastSettlementDate>2026-05-31T23:59:59Z</lastSettlementDate>\n</getSettledBatchListRequest>`)}</pre>
<pre>${esc(`<getSettledBatchListResponse xmlns="${C_NS}">\n  <messages><resultCode>Ok</resultCode><message><code>I00001</code><text>Successful.</text></message></messages>\n  <batchList>\n    <batch>\n      <batchId>18399871</batchId>\n      <settlementTimeUTC>2026-05-29T22:14:00Z</settlementTimeUTC>\n      <settlementTimeLocal>2026-05-29T15:14:00</settlementTimeLocal>\n      <settlementState>settledSuccessfully</settlementState>\n      <paymentMethod>creditCard</paymentMethod>\n    </batch>\n  </batchList>\n</getSettledBatchListResponse>`)}</pre>
<h2 id="transactions">getTransactionListRequest</h2>
<p>Lists the transactions in one batch. <code>paging</code> is optional: <code>limit</code> is 1 to ${C_PAGE_MAX} (and ${C_PAGE_MAX} without paging), and <code>offset</code> is the <em>page number</em>, starting at 1. <code>totalNumInResultSet</code> says how many transactions the batch holds. <code>sorting</code> takes <code>orderBy</code> (<code>submitTimeUTC</code>) and <code>orderDescending</code>.</p>
<pre>${esc(`<getTransactionListRequest xmlns="${C_NS}">\n  ${CHARGE_AUTH}\n  <batchId>18399871</batchId>\n  <sorting><orderBy>submitTimeUTC</orderBy><orderDescending>false</orderDescending></sorting>\n  <paging><limit>100</limit><offset>1</offset></paging>\n</getTransactionListRequest>`)}</pre>
<pre>${esc(`<getTransactionListResponse xmlns="${C_NS}">\n  <messages><resultCode>Ok</resultCode><message><code>I00001</code><text>Successful.</text></message></messages>\n  <transactions>\n    <transaction>\n      <transId>62139998774</transId>\n      <submitTimeUTC>2026-05-29T16:02:11Z</submitTimeUTC>\n      <submitTimeLocal>2026-05-29T09:02:11</submitTimeLocal>\n      <transactionStatus>settledSuccessfully</transactionStatus>\n      <invoiceNumber>W19871</invoiceNumber>\n      <firstName>Ava</firstName>\n      <lastName>Chen</lastName>\n      <accountType>Visa</accountType>\n      <accountNumber>XXXX4242</accountNumber>\n      <settleAmount>86.40</settleAmount>\n      <marketType>eCommerce</marketType>\n      <product>Card Not Present</product>\n    </transaction>\n  </transactions>\n  <totalNumInResultSet>1</totalNumInResultSet>\n</getTransactionListResponse>`)}</pre>
<h2 id="details">getTransactionDetailsRequest</h2>
<p>One transaction by <code>transId</code>, with its batch, order and billing details.</p>
<h2>getUnsettledTransactionListRequest</h2>
<p>Transactions not yet settled.</p>
<h2 id="statuses">Transaction statuses</h2>
<table>
<tr><th>transactionStatus</th><th>Meaning</th></tr>
<tr><td>settledSuccessfully</td><td>A charge that settled: the money was collected.</td></tr>
<tr><td>refundSettledSuccessfully</td><td>A refund that settled. <code>settleAmount</code> is positive for refunds too.</td></tr>
<tr><td>declined</td><td>Declined by the card issuer; nothing was collected.</td></tr>
<tr><td>voided</td><td>Cancelled before settlement; nothing was collected.</td></tr>
</table>
<p>Amounts are decimal strings in US dollars.</p>
</main>`,
);

const CHARGEBOLT_CODE = `var API = "https://${C_API}/xml/v1/request.api";
var NS = "${C_NS}";
var WINDOWS = [
  ["2026-06-01T00:00:00Z", "2026-06-30T23:59:59Z"],
  ["2026-07-01T00:00:00Z", "2026-07-31T23:59:59Z"],
  ["2026-08-01T00:00:00Z", "2026-08-31T23:59:59Z"]
];

function all(xml, name) {
  var found = [];
  var pattern = new RegExp("<" + name + ">([^]*?)</" + name + ">", "g");
  var match;
  while ((match = pattern.exec(xml)) !== null) found.push(match[1]);
  return found;
}

function one(xml, name) {
  var found = all(xml, name);
  return found.length > 0 ? found[0] : null;
}

async function call(root, inner) {
  var body = "<" + root + ' xmlns="' + NS + '">' +
    "<merchantAuthentication><name>{{secret:login_id}}</name><transactionKey>{{secret:transaction_key}}</transactionKey></merchantAuthentication>" +
    inner + "</" + root + ">";
  var response = await http.request({ method: "POST", url: API, headers: { "content-type": "text/xml" }, body: body, as: "text" });
  if (response.status !== 200) throw new Error(root + " answered HTTP " + response.status);
  var text = String(response.body);
  if (one(text, "resultCode") !== "Ok") throw new Error(root + ": " + one(text, "code") + " " + one(text, "text"));
  return text;
}

async function read(ctx) {
  var rows = [];
  for (var w = 0; w < WINDOWS.length; w++) {
    var list = await call("getSettledBatchListRequest",
      "<firstSettlementDate>" + WINDOWS[w][0] + "</firstSettlementDate><lastSettlementDate>" + WINDOWS[w][1] + "</lastSettlementDate>");
    var batches = all(list, "batch");
    for (var b = 0; b < batches.length; b++) {
      var batchId = one(batches[b], "batchId");
      for (var page = 1; ; page++) {
        var text = await call("getTransactionListRequest",
          "<batchId>" + batchId + "</batchId><paging><limit>100</limit><offset>" + page + "</offset></paging>");
        var found = all(text, "transaction");
        for (var t = 0; t < found.length; t++) {
          rows.push({
            transId: one(found[t], "transId"),
            batchId: batchId,
            submitTimeUTC: one(found[t], "submitTimeUTC"),
            transactionStatus: one(found[t], "transactionStatus"),
            settleAmount: Number(one(found[t], "settleAmount")),
            accountType: one(found[t], "accountType")
          });
        }
        var total = Number(one(text, "totalNumInResultSet") || 0);
        if (found.length < 100 || page * 100 >= total) break;
      }
    }
  }
  return { rows: rows, complete: true };
}
`;

export const chargebolt: MockProvider = {
  id: "chargebolt",
  split: "heldout",
  pattern:
    "Card gateway reporting in XML over POST: credentials inside the body, HTTP 200 for errors, settled batches in windows of at most 31 days, then transactions batch by batch with a 1-based page number",
  hosts: [C_API, C_DOCS],
  docsUrl: `https://${C_DOCS}/api/reference/`,
  credentials: [C_LOGIN, C_KEY],
  credentialLabels: ["API Login ID", "Transaction Key"],
  reference: {
    connection: {
      id: "chargebolt",
      title: "Chargebolt",
      kind: "rest",
      baseUrl: `https://${C_API}`,
      auth: {
        type: "connector",
        credentials: [
          { name: "login_id", keyRef: "chargebolt-login", label: "API Login ID" },
          { name: "transaction_key", keyRef: "chargebolt-key", label: "Transaction Key" },
        ],
      },
      ops: [
        {
          id: "transactions",
          title: "Settled transactions",
          method: "POST",
          path: "/xml/v1/request.api",
          readSafety: { basis: "docs-inferred", note: "getSettledBatchListRequest and getTransactionListRequest are reporting requests" },
          servedBy: "connector",
          maxPages: 50,
        },
      ],
      connector: {
        code: CHARGEBOLT_CODE,
        hash: connectorHash(CHARGEBOLT_CODE),
        hooks: ["read"],
        serves: ["transactions"],
        authority: {
          destinations: [{ host: C_API, methods: ["POST"], credentials: ["login_id", "transaction_key"] }],
          requests: 200,
        },
        summary:
          "Lists settled batches a month at a time since the account opened on 2026-06-01, then reads every batch's transactions 100 to a page.",
        author: { by: "person", at: "2026-09-28T00:00:00.000Z" },
      },
    },
    secrets: { "chargebolt-login": C_LOGIN, "chargebolt-key": C_KEY },
  },
  objectives: [
    {
      id: "settled-charges",
      request: "How much have we collected in settled card charges since June 1, 2026? Not refunds, voids or declines.",
      answer: major(
        chargeTransactions
          .filter((one) => one.status === "settledSuccessfully")
          .reduce((sum, one) => sum + one.amountCents, 0),
      ),
      tolerance: 0.005,
      records: chargeTransactions.length,
      scripted: {
        path: "/xml/v1/request.api",
        measure: { agg: "sum", field: "settleAmount", where: 'transactionStatus == "settledSuccessfully"' },
      },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === C_DOCS) {
      if (url.pathname === "/api/reference/" || url.pathname === "/api/reference") return chargeboltDocs;
      return notFound();
    }
    if (url.pathname !== "/xml/v1/request.api") return textAs("text/html", "<h1>404 Not Found</h1>", 404);
    if (request.method !== "POST")
      return chargeError("ErrorResponse", "E00002", "The content-type specified is not supported. Send an XML request with POST.");
    return handleCharge(request.body ?? "");
  },
};

/* ── Trackwell: issue tracking with a query language that must be bounded ─ */

/*
 * A project tracker after the big hosted issue trackers: an address per
 * site, Basic auth with an email and an API token, a query language in a
 * parameter that refuses an unbounded query, the older search endpoint
 * removed (410) but still in the specification, token paging with no
 * total, and only issue ids returned unless `fields` asks for more.
 */

const T_SITE = "northwind";
const T_HOST = `${T_SITE}.trackwell.bench.test`;
const T_DOCS = "developer.trackwell.bench.test";
const T_EMAIL = "ops-lead@northwind.example";
const T_TOKEN = "TWATT3xFfGF0z8Qe4LpR7Vm2";

const T_PROJECTS = [
  { id: "10001", key: "PLAT", name: "Platform", count: 264 },
  { id: "10002", key: "WEB", name: "Storefront", count: 171 },
  { id: "10003", key: "OPS", name: "Operations", count: 118 },
] as const;

const CATEGORY = {
  new: { id: 2, key: "new", colorName: "blue-gray", name: "To Do" },
  indeterminate: { id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" },
  done: { id: 3, key: "done", colorName: "green", name: "Done" },
} as const;

const T_STATUSES = [
  { id: "10000", name: "Backlog", category: CATEGORY.new },
  { id: "10001", name: "To Do", category: CATEGORY.new },
  { id: "3", name: "In Progress", category: CATEGORY.indeterminate },
  { id: "10002", name: "In Review", category: CATEGORY.indeterminate },
  { id: "10003", name: "Blocked", category: CATEGORY.indeterminate },
  { id: "10004", name: "Done", category: CATEGORY.done },
  { id: "10005", name: "Won't Do", category: CATEGORY.done },
] as const;

const T_TYPES = [
  { id: "10004", name: "Bug", subtask: false, hierarchyLevel: 0 },
  { id: "10005", name: "Story", subtask: false, hierarchyLevel: 0 },
  { id: "10006", name: "Task", subtask: false, hierarchyLevel: 0 },
  { id: "10000", name: "Epic", subtask: false, hierarchyLevel: 1 },
  { id: "10007", name: "Sub-task", subtask: true, hierarchyLevel: -1 },
] as const;

const T_PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"] as const;

const T_PEOPLE = [
  { accountId: "5b10a2844c20165700ede21g", displayName: "Mara Okafor", emailAddress: "mara@northwind.example" },
  { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Theo Lindqvist", emailAddress: "theo@northwind.example" },
  { accountId: "60e3f1a2b9c8d70069a1b2c3", displayName: "Priya Raman", emailAddress: "priya@northwind.example" },
  { accountId: "61a2b3c4d5e6f70071b2c3d4", displayName: "Jonah Weiss", emailAddress: "jonah@northwind.example" },
  { accountId: "62b3c4d5e6f7a80072c3d4e5", displayName: "Ines Duarte", emailAddress: "ines@northwind.example" },
  { accountId: "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077", displayName: "Automation for Trackwell", emailAddress: "" },
] as const;

type TProject = (typeof T_PROJECTS)[number];
type TStatus = (typeof T_STATUSES)[number];
type TType = (typeof T_TYPES)[number];
type TPerson = (typeof T_PEOPLE)[number];

interface TIssue {
  readonly id: string;
  readonly key: string;
  readonly project: TProject;
  readonly summary: string;
  readonly type: TType;
  readonly status: TStatus;
  readonly priority: string;
  readonly assignee: TPerson | null;
  readonly reporter: TPerson;
  readonly created: number;
  readonly updated: number;
  readonly resolved: number | null;
  readonly labels: readonly string[];
  readonly points: number | null;
}

const T_SUMMARIES = [
  "Checkout times out under load", "Add retry to webhook sender", "Audit log misses bulk edits", "Upgrade the database driver",
  "Search ignores accents", "Nightly export fails on large tenants", "Rotate signing keys", "Dark mode for the dashboard",
  "Flaky test in payments suite", "Rate limiter counts retries twice", "Document the SSO setup", "Cache invalidation on price change",
] as const;

const trackIssues: readonly TIssue[] = (() => {
  const next = random(12066);
  const issues: TIssue[] = [];
  for (const project of T_PROJECTS) {
    for (let n = 1; n <= project.count; n++) {
      const created = BENCH_NOW - Math.floor(next() * 600 * DAY);
      const status = pick(next, [
        T_STATUSES[0], T_STATUSES[1], T_STATUSES[1], T_STATUSES[2], T_STATUSES[3], T_STATUSES[4],
        T_STATUSES[5], T_STATUSES[5], T_STATUSES[5], T_STATUSES[6],
      ]);
      const type = pick(next, [T_TYPES[0], T_TYPES[0], T_TYPES[1], T_TYPES[1], T_TYPES[1], T_TYPES[2], T_TYPES[2], T_TYPES[3], T_TYPES[4]]);
      const updated = Math.min(BENCH_NOW - HOUR, created + Math.floor(next() * 90 * DAY));
      issues.push({
        id: String(10_000 + issues.length),
        key: `${project.key}-${n}`,
        project,
        summary: pick(next, T_SUMMARIES),
        type,
        status,
        priority: pick(next, T_PRIORITIES),
        assignee: next() < 0.25 ? null : pick(next, T_PEOPLE.slice(0, 5)),
        reporter: pick(next, T_PEOPLE),
        created,
        updated,
        resolved: status.category.key === "done" ? updated : null,
        labels: next() < 0.3 ? [pick(next, ["backend", "frontend", "infra", "customer-reported"] as const)] : [],
        points: type.name === "Story" || type.name === "Task" ? pick(next, [1, 2, 3, 5, 8, null]) : null,
      });
    }
  }
  return issues;
})();

const trackStamp = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");

const trackSelf = (path: string): string => `https://${T_HOST}/rest/api/3/${path}`;

const trackPerson = (person: TPerson | null): Record<string, unknown> | null =>
  person
    ? { self: trackSelf(`user?accountId=${person.accountId}`), accountId: person.accountId, displayName: person.displayName, active: true, timeZone: "Europe/London", accountType: "atlassian" }
    : null;

const TRACK_FIELD_NAMES: Readonly<Record<string, string>> = {
  summary: "Summary",
  status: "Status",
  issuetype: "Issue Type",
  project: "Project",
  priority: "Priority",
  assignee: "Assignee",
  reporter: "Reporter",
  created: "Created",
  updated: "Updated",
  resolutiondate: "Resolved",
  labels: "Labels",
  customfield_10016: "Story point estimate",
  customfield_10020: "Sprint",
};

const trackFields = (issue: TIssue): Record<string, unknown> => ({
  summary: issue.summary,
  status: {
    self: trackSelf(`status/${issue.status.id}`),
    id: issue.status.id,
    name: issue.status.name,
    statusCategory: { self: trackSelf(`statuscategory/${issue.status.category.id}`), ...issue.status.category },
  },
  issuetype: { self: trackSelf(`issuetype/${issue.type.id}`), ...issue.type },
  project: { self: trackSelf(`project/${issue.project.id}`), id: issue.project.id, key: issue.project.key, name: issue.project.name, projectTypeKey: "software" },
  priority: { self: trackSelf("priority/3"), name: issue.priority },
  assignee: trackPerson(issue.assignee),
  reporter: trackPerson(issue.reporter),
  created: trackStamp(issue.created),
  updated: trackStamp(issue.updated),
  resolutiondate: issue.resolved === null ? null : trackStamp(issue.resolved),
  labels: issue.labels,
  customfield_10016: issue.points,
  customfield_10020: issue.status.category.key === "indeterminate" ? [{ id: 41, name: "NW Sprint 41", state: "active", boardId: 7 }] : null,
});

class JqlError extends Error {}

type JqlNode =
  | { readonly kind: "and"; readonly parts: readonly JqlNode[] }
  | { readonly kind: "or"; readonly parts: readonly JqlNode[] }
  | { readonly kind: "not"; readonly part: JqlNode }
  | { readonly kind: "clause"; readonly field: string; readonly op: string; readonly values: readonly string[] };

const jqlTokens = (source: string): string[] => {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\") j++;
        value += source[j] ?? "";
        j++;
      }
      if (j >= source.length) throw new JqlError(`Error in the JQL Query: The quoted string '${value}' has not been completed.`);
      tokens.push(`"${value}`);
      i = j + 1;
      continue;
    }
    const op = /^(?:!=|!~|>=|<=|=|~|>|<|\(|\)|,)/.exec(source.slice(i));
    if (op) {
      tokens.push(op[0]);
      i += op[0].length;
      continue;
    }
    const word = /^[^\s"'(),=!~<>]+(?:\(\))?/.exec(source.slice(i));
    if (!word) throw new JqlError(`Error in the JQL Query: The character '${ch}' is a reserved JQL character.`);
    tokens.push(word[0]);
    i += word[0].length;
  }
  return tokens;
};

const JQL_OPERATORS = ["=", "!=", "~", "!~", ">", ">=", "<", "<=", "IN", "NOT IN", "IS", "IS NOT"];

const parseJql = (source: string): { where: JqlNode | null; order: { field: string; desc: boolean }[] } => {
  const tokens = jqlTokens(source);
  let at = 0;
  const upper = (): string | undefined => tokens[at]?.toUpperCase();
  const take = (): string => {
    const token = tokens[at];
    if (token === undefined) throw new JqlError("Error in the JQL Query: Expecting more of the query.");
    at++;
    return token;
  };
  const valueOf = (token: string): string => (token.startsWith('"') ? token.slice(1) : token);
  const operand = (): string[] => {
    if (tokens[at] === "(") {
      take();
      const values: string[] = [];
      while (tokens[at] !== ")") {
        values.push(valueOf(take()));
        if (tokens[at] === ",") take();
      }
      take();
      return values;
    }
    return [valueOf(take())];
  };
  const clause = (): JqlNode => {
    const fieldToken = take();
    if (["(", ")", ",", "="].includes(fieldToken))
      throw new JqlError(`Error in the JQL Query: Expecting a field name but got '${fieldToken}'.`);
    let op = take().toUpperCase();
    if (op === "NOT") {
      if (take().toUpperCase() !== "IN") throw new JqlError("Error in the JQL Query: Expecting 'IN' after 'NOT'.");
      op = "NOT IN";
    } else if (op === "IS" && upper() === "NOT") {
      take();
      op = "IS NOT";
    }
    if (!JQL_OPERATORS.includes(op))
      throw new JqlError(
        `Error in the JQL Query: Expecting operator but got '${op}'. The valid operators are '=', '!=', '<', '>', '<=', '>=', '~', '!~', 'IN', 'NOT IN', 'IS' and 'IS NOT'.`,
      );
    return { kind: "clause", field: valueOf(fieldToken).toLowerCase(), op, values: operand() };
  };
  const factor = (): JqlNode => {
    if (upper() === "NOT") {
      take();
      return { kind: "not", part: factor() };
    }
    if (tokens[at] === "(") {
      take();
      const inner = expression();
      if (take() !== ")") throw new JqlError("Error in the JQL Query: Expecting ')'.");
      return inner;
    }
    return clause();
  };
  const term = (): JqlNode => {
    const parts = [factor()];
    while (upper() === "AND") {
      take();
      parts.push(factor());
    }
    return parts.length === 1 ? parts[0]! : { kind: "and", parts };
  };
  const expression = (): JqlNode => {
    const parts = [term()];
    while (upper() === "OR") {
      take();
      parts.push(term());
    }
    return parts.length === 1 ? parts[0]! : { kind: "or", parts };
  };
  const where = at < tokens.length && upper() !== "ORDER" ? expression() : null;
  const order: { field: string; desc: boolean }[] = [];
  if (upper() === "ORDER") {
    take();
    if (take().toUpperCase() !== "BY") throw new JqlError("Error in the JQL Query: Expecting 'BY' after 'ORDER'.");
    for (;;) {
      const field = valueOf(take()).toLowerCase();
      let desc = false;
      if (upper() === "ASC" || upper() === "DESC") desc = take().toUpperCase() === "DESC";
      order.push({ field, desc });
      if (tokens[at] !== ",") break;
      take();
    }
  }
  if (at < tokens.length)
    throw new JqlError(`Error in the JQL Query: Expecting either 'OR' or 'AND' but got '${valueOf(tokens[at]!)}'.`);
  return { where, order };
};

/** A JQL date: absolute, relative to now (`-30d`), or a start-of function. */
const jqlDate = (raw: string): number => {
  const relative = /^([+-]?\d+)([yMwdhm])$/.exec(raw);
  if (relative) {
    const units: Record<string, number> = { y: 365 * DAY, M: 30 * DAY, w: 7 * DAY, d: DAY, h: HOUR, m: 60_000 };
    return BENCH_NOW + Number(relative[1]) * units[relative[2]!]!;
  }
  const now = new Date(BENCH_NOW);
  switch (raw.toLowerCase()) {
    case "now()":
      return BENCH_NOW;
    case "startofday()":
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    case "startofmonth()":
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    case "startofyear()":
      return Date.UTC(now.getUTCFullYear(), 0, 1);
  }
  const absolute = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:\s+(\d{2}):(\d{2}))?$/.exec(raw);
  if (!absolute)
    throw new JqlError(
      `Date value '${raw}' is invalid. Valid formats include: 'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', or a period format e.g. '-5d', '4w 2d'.`,
    );
  const [, y, mo, d, h = "0", mi = "0"] = absolute;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
};

const JQL_DATES: Readonly<Record<string, (issue: TIssue) => number | null>> = {
  created: (issue) => issue.created,
  createddate: (issue) => issue.created,
  updated: (issue) => issue.updated,
  updateddate: (issue) => issue.updated,
  resolved: (issue) => issue.resolved,
  resolutiondate: (issue) => issue.resolved,
};

const JQL_VALUES: Readonly<Record<string, (issue: TIssue) => readonly string[]>> = {
  project: (issue) => [issue.project.key, issue.project.name, issue.project.id],
  status: (issue) => [issue.status.name, issue.status.id],
  statuscategory: (issue) => [issue.status.category.name, issue.status.category.key, String(issue.status.category.id)],
  issuetype: (issue) => [issue.type.name, issue.type.id],
  type: (issue) => [issue.type.name, issue.type.id],
  priority: (issue) => [issue.priority],
  assignee: (issue) => (issue.assignee ? [issue.assignee.displayName, issue.assignee.accountId] : []),
  reporter: (issue) => [issue.reporter.displayName, issue.reporter.accountId],
  labels: (issue) => issue.labels,
  key: (issue) => [issue.key, issue.id],
  issuekey: (issue) => [issue.key, issue.id],
  id: (issue) => [issue.key, issue.id],
  summary: (issue) => [issue.summary],
  text: (issue) => [issue.summary],
  "story point estimate": (issue) => (issue.points === null ? [] : [String(issue.points)]),
  "cf[10016]": (issue) => (issue.points === null ? [] : [String(issue.points)]),
};

/** Values JQL checks exist, as the tracker does, before running a query. */
const JQL_KNOWN: Readonly<Record<string, readonly string[]>> = {
  project: T_PROJECTS.flatMap((one) => [one.key, one.name, one.id]),
  status: T_STATUSES.flatMap((one) => [one.name, one.id]),
  statuscategory: Object.values(CATEGORY).flatMap((one) => [one.name, one.key, String(one.id)]),
  issuetype: T_TYPES.flatMap((one) => [one.name, one.id]),
  type: T_TYPES.flatMap((one) => [one.name, one.id]),
  priority: [...T_PRIORITIES],
};

const jqlMatches = (node: JqlNode, issue: TIssue): boolean => {
  if (node.kind === "and") return node.parts.every((part) => jqlMatches(part, issue));
  if (node.kind === "or") return node.parts.some((part) => jqlMatches(part, issue));
  if (node.kind === "not") return !jqlMatches(node.part, issue);
  const { field, op, values } = node;
  const date = JQL_DATES[field];
  if (date) {
    const actual = date(issue);
    if (op === "IS" || op === "IS NOT") return (actual === null) === (op === "IS");
    if (actual === null) return false;
    const wanted = jqlDate(values[0] ?? "");
    switch (op) {
      case "=":
        return actual === wanted;
      case "!=":
        return actual !== wanted;
      case ">":
        return actual > wanted;
      case ">=":
        return actual >= wanted;
      case "<":
        return actual < wanted;
      case "<=":
        return actual <= wanted;
      default:
        throw new JqlError(`The operator '${op}' is not supported by the '${field}' field.`);
    }
  }
  const read = JQL_VALUES[field];
  if (!read) throw new JqlError(`Field '${field}' does not exist or you do not have permission to view it.`);
  const actual = read(issue).map((one) => one.toLowerCase());
  const wanted = values.map((one) => one.toLowerCase());
  const empty = wanted.length === 1 && (wanted[0] === "empty" || wanted[0] === "null");
  switch (op) {
    case "IS":
    case "IS NOT":
      if (!empty) throw new JqlError(`The operator '${op}' is only used with EMPTY or NULL.`);
      return (actual.length === 0) === (op === "IS");
    case "=":
      return empty ? actual.length === 0 : wanted.some((one) => actual.includes(one));
    case "IN":
      return wanted.some((one) => actual.includes(one));
    case "!=":
      return empty ? actual.length > 0 : actual.length > 0 && !wanted.some((one) => actual.includes(one));
    case "NOT IN":
      return actual.length > 0 && !wanted.some((one) => actual.includes(one));
    case "~":
      return actual.some((one) => wanted.some((word) => one.includes(word)));
    case "!~":
      return !actual.some((one) => wanted.some((word) => one.includes(word)));
    default: {
      const left = Number(actual[0]);
      const right = Number(wanted[0]);
      if (Number.isNaN(left) || Number.isNaN(right)) return false;
      return op === ">" ? left > right : op === ">=" ? left >= right : op === "<" ? left < right : left <= right;
    }
  }
};

const jqlCheckValues = (node: JqlNode | null): void => {
  if (!node) return;
  if (node.kind === "and" || node.kind === "or") return node.parts.forEach(jqlCheckValues);
  if (node.kind === "not") return jqlCheckValues(node.part);
  const known = JQL_KNOWN[node.field];
  if (!known || node.op === "~" || node.op === "!~" || node.op === "IS" || node.op === "IS NOT") return;
  for (const value of node.values) {
    if (!known.some((one) => one.toLowerCase() === value.toLowerCase()))
      throw new JqlError(`The value '${value}' does not exist for the field '${node.field}'.`);
  }
};

const trackError = (status: number, message: string): BenchResponse => json({ errorMessages: [message], errors: {} }, status);

const trackSort = (issues: TIssue[], order: readonly { field: string; desc: boolean }[]): TIssue[] => {
  const keyOf = (issue: TIssue, field: string): string | number => {
    const date = JQL_DATES[field];
    if (date) return date(issue) ?? 0;
    if (field === "key" || field === "id" || field === "issuekey") return Number(issue.id);
    if (field === "priority") return T_PRIORITIES.indexOf(issue.priority as (typeof T_PRIORITIES)[number]);
    const read = JQL_VALUES[field];
    if (!read) throw new JqlError(`Not able to sort using field '${field}'.`);
    return read(issue)[0] ?? "";
  };
  return issues.sort((a, b) => {
    for (const { field, desc } of order) {
      const left = keyOf(a, field);
      const right = keyOf(b, field);
      if (left !== right) return (left < right ? -1 : 1) * (desc ? -1 : 1);
    }
    return Number(a.id) - Number(b.id);
  });
};

const trackSearch = (input: {
  jql: string | null;
  nextPageToken: string | null;
  maxResults: number;
  fields: readonly string[] | null;
  expand: string;
}): BenchResponse => {
  let parsed: ReturnType<typeof parseJql>;
  try {
    parsed = parseJql(input.jql ?? "");
    if (!parsed.where)
      return trackError(400, "Unbounded JQL queries are not allowed here. Please add a search restriction to your query.");
    jqlCheckValues(parsed.where);
    const where = parsed.where;
    const matching = trackSort(trackIssues.filter((issue) => jqlMatches(where, issue)), parsed.order);
    let offset = 0;
    if (input.nextPageToken) {
      try {
        const decoded = JSON.parse(Buffer.from(input.nextPageToken, "base64url").toString("utf8")) as { o?: number; q?: string };
        if (decoded.q !== input.jql || typeof decoded.o !== "number") throw new Error("mismatch");
        offset = decoded.o;
      } catch {
        return trackError(400, "The provided next page token is invalid or expired.");
      }
    }
    const fields = input.fields ?? ["id"];
    const everything = fields.includes("*all") || fields.includes("*navigable");
    const wanted = everything ? Object.keys(TRACK_FIELD_NAMES) : fields.filter((one) => one in TRACK_FIELD_NAMES);
    const onlyIds = wanted.length === 0;
    const size = Math.max(1, Math.min(onlyIds ? 5000 : 100, input.maxResults));
    const slice = matching.slice(offset, offset + size);
    const end = offset + slice.length;
    const issues = slice.map((issue) => {
      if (onlyIds) return { id: issue.id };
      const all = trackFields(issue);
      return {
        expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
        id: issue.id,
        self: trackSelf(`issue/${issue.id}`),
        key: issue.key,
        fields: Object.fromEntries(wanted.map((name) => [name, all[name] ?? null])),
      };
    });
    return json({
      issues,
      ...(end < matching.length
        ? { nextPageToken: Buffer.from(JSON.stringify({ o: end, q: input.jql })).toString("base64url") }
        : {}),
      isLast: end >= matching.length,
      ...(input.expand.split(",").includes("names") && !onlyIds
        ? { names: Object.fromEntries(wanted.map((name) => [name, TRACK_FIELD_NAMES[name]])) }
        : {}),
    });
  } catch (error) {
    if (error instanceof JqlError) return trackError(400, error.message);
    throw error;
  }
};

const trackIssueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    self: { type: "string" },
    fields: { type: "object", additionalProperties: true, description: "The fields asked for, by field ID. Custom fields are named customfield_NNNNN; GET /rest/api/3/field lists them." },
  },
};

const trackwellSpec = {
  openapi: "3.0.1",
  info: {
    title: "Trackwell Cloud platform REST API",
    version: "1001.0.0-SNAPSHOT",
    description:
      "The Trackwell Cloud platform REST API, version 3. Each site has its own address.\n\n" +
      "**Authentication.** Basic auth with your account's email address as the username and an API token as the password. " +
      `Create API tokens at https://id.trackwell.bench.test/manage-profile/security/api-tokens. Your password is not accepted.`,
  },
  servers: [
    {
      url: "https://{your-site}.trackwell.bench.test",
      variables: { "your-site": { default: "your-domain", description: "The name of your Trackwell site" } },
    },
  ],
  components: {
    securitySchemes: { basicAuth: { type: "http", scheme: "basic", description: "Email address and API token." } },
    schemas: { IssueBean: trackIssueSchema },
  },
  security: [{ basicAuth: [] }],
  paths: {
    "/rest/api/3/search": {
      get: {
        operationId: "searchForIssuesUsingJql",
        deprecated: true,
        summary: "Search for issues using JQL (GET)",
        description: "Deprecated. Use Search for issues using JQL enhanced search (GET /rest/api/3/search/jql).",
        parameters: [
          { name: "jql", in: "query", schema: { type: "string" } },
          { name: "startAt", in: "query", schema: { type: "integer", default: 0 } },
          { name: "maxResults", in: "query", schema: { type: "integer", default: 50 } },
          { name: "fields", in: "query", schema: { type: "array", items: { type: "string" } }, style: "form", explode: false },
        ],
        responses: {
          "200": {
            description: "Returned if the request is successful.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    startAt: { type: "integer" },
                    maxResults: { type: "integer" },
                    total: { type: "integer" },
                    issues: { type: "array", items: { $ref: "#/components/schemas/IssueBean" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/rest/api/3/search/jql": {
      get: {
        operationId: "searchAndReconsileIssuesUsingJql",
        summary: "Search for issues using JQL enhanced search (GET)",
        description:
          "Searches for issues using JQL. The query must be bounded: a query with no search restriction — empty, or only an ORDER BY clause — is refused. " +
          "Pages are read with nextPageToken; the response has no total. Recently updated issues may take a moment to appear.",
        parameters: [
          {
            name: "jql",
            in: "query",
            schema: { type: "string" },
            description: 'A JQL expression, e.g. project = HSP AND statusCategory != Done ORDER BY created DESC. It must contain a search restriction.',
          },
          { name: "nextPageToken", in: "query", schema: { type: "string" }, description: "The token for a page to fetch that is not the first page." },
          {
            name: "maxResults",
            in: "query",
            schema: { type: "integer", default: 50 },
            description: "The maximum number of items to return per page. Up to 5000 when only IDs are requested; otherwise at most 100.",
          },
          {
            name: "fields",
            in: "query",
            schema: { type: "array", items: { type: "string" } },
            style: "form",
            explode: false,
            description: "The fields to return for each issue. By default only the issue ID is returned. *all returns every field, *navigable the navigable ones.",
          },
          { name: "expand", in: "query", schema: { type: "string" }, description: "names adds the display name of each returned field." },
        ],
        responses: {
          "200": {
            description: "Returned if the request is successful.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    issues: { type: "array", items: { $ref: "#/components/schemas/IssueBean" } },
                    nextPageToken: { type: "string", description: "Absent on the last page." },
                    isLast: { type: "boolean" },
                    names: { type: "object" },
                  },
                },
              },
            },
          },
          "400": { description: "Returned if the JQL query is invalid or unbounded." },
          "401": { description: "Returned if the authentication credentials are incorrect or missing." },
        },
      },
    },
    "/rest/api/3/field": {
      get: {
        operationId: "getFields",
        summary: "Get fields",
        description: "Returns system and custom fields, with their IDs and names.",
        responses: { "200": { description: "Fields", content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } } },
      },
    },
    "/rest/api/3/project/search": {
      get: {
        operationId: "searchProjects",
        summary: "Get projects paginated",
        responses: { "200": { description: "Projects", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/rest/api/3/issue/{issueIdOrKey}": {
      get: {
        operationId: "getIssue",
        summary: "Get issue",
        parameters: [{ name: "issueIdOrKey", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The issue", content: { "application/json": { schema: { $ref: "#/components/schemas/IssueBean" } } } } },
      },
    },
    "/rest/api/3/myself": {
      get: { operationId: "getCurrentUser", summary: "Get current user", responses: { "200": { description: "The user" } } },
    },
  },
};

const TRACK_FIELD_LIST = Object.entries(TRACK_FIELD_NAMES).map(([id, name]) => ({
  id,
  key: id,
  name,
  custom: id.startsWith("customfield_"),
  navigable: true,
  searchable: true,
  clauseNames: id === "customfield_10016" ? ["cf[10016]", "Story point estimate"] : id === "customfield_10020" ? ["cf[10020]", "Sprint"] : [id],
  schema:
    id === "customfield_10016"
      ? { type: "number", custom: "com.trackwell.jira-software:story-points", customId: 10016 }
      : id === "customfield_10020"
        ? { type: "array", items: "json", custom: "com.trackwell.jira-software:gh-sprint", customId: 10020 }
        : { type: "string", system: id },
}));

export const trackwell: MockProvider = {
  id: "trackwell",
  split: "heldout",
  pattern:
    "Issue tracker on a per-site host: a query language in a parameter that must be bounded, the old search endpoint removed (410) but still in the spec, token pages with no total, only ids returned unless fields are asked for",
  hosts: [T_HOST, T_DOCS],
  docsUrl: `https://${T_DOCS}/cloud/platform/rest/v3/openapi.json`,
  credentials: [T_SITE, T_EMAIL, T_TOKEN],
  credentialLabels: ["Site name", "Email address", "API token"],
  reference: {
    connection: {
      id: "trackwell",
      title: "Trackwell",
      kind: "rest",
      baseUrl: `https://${T_HOST}/rest/api/3`,
      auth: { type: "basic", usernameRef: "trackwell-email", keyRef: "trackwell-token", usernameLabel: "Email address", label: "API token" },
      ops: [
        {
          id: "issues",
          title: "Search for issues using JQL",
          path: "/search/jql",
          query: { jql: "project = PLAT", fields: "issuetype,status", maxResults: 100 },
          rowsPath: "$.issues",
          pagination: { kind: "cursor", param: "nextPageToken", cursorPath: "$.nextPageToken" },
          maxPages: 10,
        },
      ],
    },
    secrets: { "trackwell-email": T_EMAIL, "trackwell-token": T_TOKEN },
  },
  objectives: [
    {
      id: "open-platform-bugs",
      request: "How many bugs are still open in the Platform project?",
      answer: trackIssues.filter(
        (issue) => issue.project.key === "PLAT" && issue.type.name === "Bug" && issue.status.category.key !== "done",
      ).length,
      tolerance: 0,
      records: trackIssues.filter((issue) => issue.project.key === "PLAT").length,
      scripted: {
        path: "/search/jql",
        measure: { agg: "count", where: 'fields.issuetype.name == "Bug" && fields.status.statusCategory.key != "done"' },
      },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === T_DOCS) {
      if (url.pathname === "/cloud/platform/rest/v3/openapi.json") return json(trackwellSpec);
      return notFound();
    }
    const authorization = request.headers.authorization ?? "";
    if (/^bearer /i.test(authorization)) return trackError(401, "Failed to parse Connect Session Auth Token");
    const pair = basicPair(request);
    if (!pair || pair[0].toLowerCase() !== T_EMAIL || pair[1] !== T_TOKEN)
      return textAs("text/plain;charset=UTF-8", "Client must be authenticated to access this resource.", 401, {
        "x-seraph-loginreason": "AUTHENTICATED_FAILED",
        "www-authenticate": 'Basic realm="protected-area"',
      });
    const { pathname } = url;
    if (pathname === "/rest/api/3/search" || pathname === "/rest/api/2/search")
      return trackError(
        410,
        `The requested API has been removed. Please migrate to the /rest/api/3/search/jql API. A full migration guideline is available at https://${T_DOCS}/changelog/#CHANGE-2046`,
      );
    if (pathname === "/rest/api/3/search/jql") {
      if (request.method === "POST") {
        const body = bodyJson(request.body);
        return trackSearch({
          jql: typeof body.jql === "string" ? body.jql : null,
          nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
          maxResults: typeof body.maxResults === "number" ? body.maxResults : 50,
          fields: Array.isArray(body.fields) ? body.fields.map(String) : null,
          expand: typeof body.expand === "string" ? body.expand : "",
        });
      }
      const fields = url.searchParams.getAll("fields").flatMap((one) => one.split(",")).map((one) => one.trim()).filter(Boolean);
      return trackSearch({
        jql: url.searchParams.get("jql"),
        nextPageToken: url.searchParams.get("nextPageToken"),
        maxResults: intParam(request, "maxResults", 50),
        fields: fields.length > 0 ? fields : null,
        expand: url.searchParams.get("expand") ?? "",
      });
    }
    if (request.method !== "GET") return trackError(405, "Method not allowed.");
    if (pathname === "/rest/api/3/field") return json(TRACK_FIELD_LIST);
    if (pathname === "/rest/api/3/myself")
      return json({ ...trackPerson(T_PEOPLE[0]), emailAddress: T_EMAIL });
    if (pathname === "/rest/api/3/project/search")
      return json({
        self: trackSelf("project/search"),
        maxResults: 50,
        startAt: 0,
        total: T_PROJECTS.length,
        isLast: true,
        values: T_PROJECTS.map((project) => ({ self: trackSelf(`project/${project.id}`), id: project.id, key: project.key, name: project.name, projectTypeKey: "software" })),
      });
    const one = /^\/rest\/api\/3\/issue\/([A-Za-z]+-\d+|\d+)$/.exec(pathname);
    if (one) {
      const issue = trackIssues.find((each) => each.key === one[1]!.toUpperCase() || each.id === one[1]);
      return issue
        ? json({ id: issue.id, self: trackSelf(`issue/${issue.id}`), key: issue.key, fields: trackFields(issue) })
        : trackError(404, "Issue does not exist or you do not have permission to see it.");
    }
    return trackError(404, "null for uri: " + url.toString());
  },
};

/* ── Pipeforce: a CRM whose records are read with a query language ────── */

/*
 * A CRM after the enterprise one small businesses end up on: an org on its
 * own "My Domain" host, OAuth client credentials that only that host will
 * issue (the spec's generic login host refuses them), records read with a
 * SQL-like query in a parameter, batches continued by following a path the
 * last batch gives (`nextRecordsUrl`) rather than a parameter, and deleted
 * records visible only through `queryAll`.
 */

const P_DOMAIN = "harbor-ridge";
const P_HOST = `${P_DOMAIN}.my.pipeforce.bench.test`;
const P_LOGIN = "login.pipeforce.bench.test";
const P_DOCS = "developer.pipeforce.bench.test";
const P_KEY = "3MVG9pRZq8Xk2fTbY.hQ4wNc7LdSe";
const P_SECRET = "E7C1F0A9B3D24C6E8F1A0B9C7D6E5F4A";
const P_VERSIONS = ["58.0", "59.0", "60.0", "61.0"] as const;
const P_DEFAULT_BATCH = 2000;

type SoqlType = "id" | "string" | "picklist" | "currency" | "percent" | "date" | "datetime" | "boolean" | "reference";

interface SObjectDef {
  readonly fields: Readonly<Record<string, SoqlType>>;
  readonly relationships: Readonly<Record<string, string>>;
  readonly records: () => readonly Readonly<Record<string, unknown>>[];
  readonly prefix: string;
}

const pfId = (prefix: string, index: number): string => `${prefix}Hs00000${index.toString(36).toUpperCase().padStart(5, "0")}IAQ`;

const pfAccounts = (() => {
  const next = random(12070);
  return Array.from({ length: 64 }, (_, index) => ({
    Id: pfId("001", index + 1),
    Name: `${pick(next, COMPANIES)}${index % 3 === 0 ? "" : ` ${pick(next, ["Group", "Co.", "LLC", "Partners"] as const)}`}`,
    Industry: pick(next, ["Retail", "Healthcare", "Construction", "Hospitality", "Manufacturing", "Professional Services"] as const),
    BillingCountry: pick(next, ["United States", "United States", "Canada", "United Kingdom"] as const),
    CreatedDate: `${new Date(Date.UTC(2022, 0, 1) + Math.floor(next() * 900) * DAY).toISOString().slice(0, 19)}.000+0000`,
    IsDeleted: false,
  }));
})();

const pfUsers = [
  { Id: pfId("005", 1), Name: "Dana Whitfield", Email: "dana@harborridge.example" },
  { Id: pfId("005", 2), Name: "Marcus Bell", Email: "marcus@harborridge.example" },
  { Id: pfId("005", 3), Name: "Lena Ortiz", Email: "lena@harborridge.example" },
  { Id: pfId("005", 4), Name: "Sunil Rao", Email: "sunil@harborridge.example" },
] as const;

const PF_STAGES = [
  ["Prospecting", 10], ["Qualification", 20], ["Needs Analysis", 30], ["Proposal/Price Quote", 60],
  ["Negotiation/Review", 80], ["Closed Won", 100], ["Closed Won", 100], ["Closed Lost", 0],
] as const;

type PfOpportunity = {
  readonly Id: string;
  readonly Name: string;
  readonly AccountId: string;
  readonly OwnerId: string;
  readonly StageName: string;
  readonly Amount: number | null;
  readonly Probability: number;
  readonly CloseDate: string;
  readonly Type: string;
  readonly LeadSource: string;
  readonly IsClosed: boolean;
  readonly IsWon: boolean;
  readonly IsDeleted: boolean;
  readonly CreatedDate: string;
  readonly LastModifiedDate: string;
  readonly amountCents: number | null;
};

const pfOpportunities: readonly PfOpportunity[] = (() => {
  const next = random(12077);
  return Array.from({ length: 2370 }, (_, index): PfOpportunity => {
    const account = pick(next, pfAccounts);
    const [stage, probability] = pick(next, PF_STAGES);
    const closed = stage.startsWith("Closed");
    const close = closed
      ? BENCH_NOW - Math.floor(next() * 800) * DAY - DAY
      : BENCH_NOW + Math.floor(next() * 220) * DAY - 20 * DAY;
    const created = close - (10 + Math.floor(next() * 150)) * DAY;
    const amountCents = next() < 0.06 ? null : cents(next, 1500, 180_000);
    const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}.000+0000`;
    return {
      Id: pfId("006", index + 1),
      Name: `${account.Name} — ${pick(next, ["Renewal", "Expansion", "New Business", "Add-on", "Pilot"] as const)}`,
      AccountId: account.Id,
      OwnerId: pick(next, pfUsers).Id,
      StageName: stage,
      Amount: amountCents === null ? null : major(amountCents),
      Probability: probability,
      CloseDate: isoDay(close),
      Type: pick(next, ["New Customer", "Existing Customer - Upgrade", "Existing Customer - Renewal"] as const),
      LeadSource: pick(next, ["Web", "Partner Referral", "Trade Show", "Phone Inquiry", "Other"] as const),
      IsClosed: closed,
      IsWon: stage === "Closed Won",
      IsDeleted: next() < 0.03,
      CreatedDate: stamp(created),
      LastModifiedDate: stamp(Math.min(BENCH_NOW - HOUR, Math.max(created, close - DAY))),
      amountCents,
    };
  });
})();

const pfLive = pfOpportunities.filter((one) => !one.IsDeleted);

const SOBJECTS: Readonly<Record<string, SObjectDef>> = {
  Opportunity: {
    prefix: "006",
    fields: {
      Id: "id", Name: "string", AccountId: "reference", OwnerId: "reference", StageName: "picklist", Amount: "currency",
      Probability: "percent", CloseDate: "date", Type: "picklist", LeadSource: "picklist", IsClosed: "boolean",
      IsWon: "boolean", IsDeleted: "boolean", CreatedDate: "datetime", LastModifiedDate: "datetime",
    },
    relationships: { Account: "Account", Owner: "User" },
    records: () => pfOpportunities,
  },
  Account: {
    prefix: "001",
    fields: { Id: "id", Name: "string", Industry: "picklist", BillingCountry: "string", CreatedDate: "datetime", IsDeleted: "boolean" },
    relationships: {},
    records: () => pfAccounts,
  },
  User: {
    prefix: "005",
    fields: { Id: "id", Name: "string", Email: "string" },
    relationships: {},
    records: () => pfUsers,
  },
};

const REFERENCE_KEYS: Readonly<Record<string, string>> = { Account: "AccountId", Owner: "OwnerId" };

class SoqlError extends Error {
  constructor(message: string, readonly errorCode = "MALFORMED_QUERY") {
    super(message);
  }
}

type SoqlLiteral =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" }
  | { readonly kind: "date"; readonly start: number; readonly end: number; readonly text: string };

type SoqlCondition =
  | { readonly kind: "and"; readonly parts: readonly SoqlCondition[] }
  | { readonly kind: "or"; readonly parts: readonly SoqlCondition[] }
  | { readonly kind: "not"; readonly part: SoqlCondition }
  | { readonly kind: "cmp"; readonly path: string; readonly op: string; readonly values: readonly SoqlLiteral[] };

type SoqlSelect =
  | { readonly kind: "field"; readonly path: string }
  | { readonly kind: "agg"; readonly fn: string; readonly path: string | null; readonly alias: string | null }
  | { readonly kind: "fields" };

interface SoqlQuery {
  readonly select: readonly SoqlSelect[];
  readonly from: string;
  readonly where: SoqlCondition | null;
  readonly groupBy: string | null;
  readonly order: readonly { readonly path: string; readonly desc: boolean; readonly nullsFirst: boolean }[];
  readonly limit: number | null;
  readonly offset: number | null;
}

const soqlTokens = (source: string): string[] => {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== "'") {
        if (source[j] === "\\") j++;
        value += source[j] ?? "";
        j++;
      }
      if (j >= source.length) throw new SoqlError(`unexpected token: '${source.slice(i)}'`);
      tokens.push(`'${value}`);
      i = j + 1;
      continue;
    }
    const date = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?/.exec(source.slice(i));
    if (date) {
      tokens.push(`#${date[0]}`);
      i += date[0].length;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(source.slice(i));
    if (number) {
      tokens.push(number[0]);
      i += number[0].length;
      continue;
    }
    const op = /^(?:!=|<>|<=|>=|=|<|>|\(|\)|,)/.exec(source.slice(i));
    if (op) {
      tokens.push(op[0]);
      i += op[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*(?::\d+)?/.exec(source.slice(i));
    if (!word) throw new SoqlError(`unexpected token: '${ch}'`);
    tokens.push(word[0]);
    i += word[0].length;
  }
  return tokens;
};

const utcDay = (year: number, month: number, day = 1): number => Date.UTC(year, month, day);

/** A date literal as the range it names. */
const soqlDateLiteral = (token: string): SoqlLiteral | null => {
  const now = new Date(BENCH_NOW);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = utcDay(y, m, now.getUTCDate());
  const quarter = Math.floor(m / 3) * 3;
  const upper = token.toUpperCase();
  const range = (start: number, end: number): SoqlLiteral => ({ kind: "date", start, end, text: token });
  const n = /^(LAST|NEXT)_N_DAYS:(\d+)$/.exec(upper);
  if (n) return n[1] === "LAST" ? range(today - Number(n[2]) * DAY, today + DAY) : range(today, today + (Number(n[2]) + 1) * DAY);
  switch (upper) {
    case "TODAY":
      return range(today, today + DAY);
    case "YESTERDAY":
      return range(today - DAY, today);
    case "TOMORROW":
      return range(today + DAY, today + 2 * DAY);
    case "THIS_MONTH":
      return range(utcDay(y, m), utcDay(y, m + 1));
    case "LAST_MONTH":
      return range(utcDay(y, m - 1), utcDay(y, m));
    case "THIS_QUARTER":
      return range(utcDay(y, quarter), utcDay(y, quarter + 3));
    case "LAST_QUARTER":
      return range(utcDay(y, quarter - 3), utcDay(y, quarter));
    case "THIS_YEAR":
      return range(utcDay(y, 0), utcDay(y + 1, 0));
    case "LAST_YEAR":
      return range(utcDay(y - 1, 0), utcDay(y, 0));
    case "NEXT_YEAR":
      return range(utcDay(y + 1, 0), utcDay(y + 2, 0));
  }
  if (token.startsWith("#")) {
    const text = token.slice(1);
    if (text.length === 10) {
      const start = Date.parse(`${text}T00:00:00Z`);
      return range(start, start + DAY);
    }
    const at = Date.parse(text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return range(at, at);
  }
  return null;
};

const parseSoql = (source: string): SoqlQuery => {
  const tokens = soqlTokens(source);
  let at = 0;
  const upper = (): string | undefined => tokens[at]?.toUpperCase();
  const take = (): string => {
    const token = tokens[at];
    if (token === undefined) throw new SoqlError("unexpected token: '<EOF>'");
    at++;
    return token;
  };
  const expect = (word: string): void => {
    const token = take();
    if (token.toUpperCase() !== word) throw new SoqlError(`unexpected token: '${token}'`);
  };
  if (take().toUpperCase() !== "SELECT") throw new SoqlError("unexpected token: the query must start with SELECT");
  const select: SoqlSelect[] = [];
  for (;;) {
    const token = take();
    if (tokens[at] === "(") {
      take();
      const fn = token.toUpperCase();
      if (fn === "FIELDS") {
        const which = take().toUpperCase();
        if (!["ALL", "STANDARD", "CUSTOM"].includes(which)) throw new SoqlError(`unexpected token: '${which}'`);
        expect(")");
        select.push({ kind: "fields" });
      } else {
        if (!["COUNT", "SUM", "AVG", "MIN", "MAX", "COUNT_DISTINCT"].includes(fn)) throw new SoqlError(`Unknown function: ${token}`);
        const path = tokens[at] === ")" ? null : take();
        expect(")");
        const alias = tokens[at] !== "," && upper() !== "FROM" ? take() : null;
        select.push({ kind: "agg", fn, path, alias });
      }
    } else select.push({ kind: "field", path: token });
    if (tokens[at] !== ",") break;
    take();
  }
  expect("FROM");
  const fromToken = take();
  const from = Object.keys(SOBJECTS).find((name) => name.toLowerCase() === fromToken.toLowerCase());
  if (!from)
    throw new SoqlError(
      `sObject type '${fromToken}' is not supported. If you are attempting to use a custom object, be sure to append the '__c' after the entity name.`,
      "INVALID_TYPE",
    );

  const literal = (): SoqlLiteral => {
    const token = take();
    if (token.startsWith("'")) return { kind: "string", value: token.slice(1) };
    if (/^-?\d/.test(token)) return { kind: "number", value: Number(token) };
    const word = token.toUpperCase();
    if (word === "TRUE" || word === "FALSE") return { kind: "boolean", value: word === "TRUE" };
    if (word === "NULL") return { kind: "null" };
    const date = soqlDateLiteral(token);
    if (date) return date;
    throw new SoqlError(`unexpected token: '${token}'`);
  };
  const comparison = (): SoqlCondition => {
    const path = take();
    let op = take().toUpperCase();
    if (op === "NOT") {
      expect("IN");
      op = "NOT IN";
    }
    if (op === "<>") op = "!=";
    if (!["=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "NOT IN"].includes(op)) throw new SoqlError(`unexpected token: '${op}'`);
    if (op === "IN" || op === "NOT IN") {
      expect("(");
      const values: SoqlLiteral[] = [];
      while (tokens[at] !== ")") {
        values.push(literal());
        if (tokens[at] === ",") take();
      }
      take();
      return { kind: "cmp", path, op, values };
    }
    return { kind: "cmp", path, op, values: [literal()] };
  };
  const factor = (): SoqlCondition => {
    if (upper() === "NOT") {
      take();
      return { kind: "not", part: factor() };
    }
    if (tokens[at] === "(") {
      take();
      const inner = condition();
      expect(")");
      return inner;
    }
    return comparison();
  };
  const condition = (): SoqlCondition => {
    const first = factor();
    const joiner = upper();
    if (joiner !== "AND" && joiner !== "OR") return first;
    const parts = [first];
    while (upper() === joiner) {
      take();
      parts.push(factor());
    }
    if (upper() === "AND" || upper() === "OR")
      throw new SoqlError("unexpected token: mixing AND and OR without parentheses is not allowed");
    return { kind: joiner === "AND" ? "and" : "or", parts };
  };

  let where: SoqlCondition | null = null;
  let groupBy: string | null = null;
  const order: { path: string; desc: boolean; nullsFirst: boolean }[] = [];
  let limit: number | null = null;
  let offset: number | null = null;
  if (upper() === "WHERE") {
    take();
    where = condition();
  }
  if (upper() === "GROUP") {
    take();
    expect("BY");
    groupBy = take();
  }
  if (upper() === "ORDER") {
    take();
    expect("BY");
    for (;;) {
      const path = take();
      let desc = false;
      if (upper() === "ASC" || upper() === "DESC") desc = take().toUpperCase() === "DESC";
      let nullsFirst = !desc;
      if (upper() === "NULLS") {
        take();
        nullsFirst = take().toUpperCase() === "FIRST";
      }
      order.push({ path, desc, nullsFirst });
      if (tokens[at] !== ",") break;
      take();
    }
  }
  if (upper() === "LIMIT") {
    take();
    limit = Number(take());
  }
  if (upper() === "OFFSET") {
    take();
    offset = Number(take());
  }
  if (at < tokens.length) throw new SoqlError(`unexpected token: '${tokens[at]}'`);
  return { select, from, where, groupBy, order, limit, offset };
};

/** A field path on an object, resolved to its canonical spelling and type. */
const soqlField = (object: string, path: string): { readonly parts: readonly string[]; readonly type: SoqlType } => {
  const segments = path.split(".");
  const def = SOBJECTS[object]!;
  if (segments.length === 2) {
    const relation = Object.keys(def.relationships).find((name) => name.toLowerCase() === segments[0]!.toLowerCase());
    if (relation) {
      const inner = soqlField(def.relationships[relation]!, segments[1]!);
      return { parts: [relation, ...inner.parts], type: inner.type };
    }
  }
  const name = segments.length === 1 ? Object.keys(def.fields).find((field) => field.toLowerCase() === path.toLowerCase()) : undefined;
  if (!name)
    throw new SoqlError(
      `No such column '${path}' on entity '${object}'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name. Please reference your WSDL or the describe call for the appropriate names.`,
      "INVALID_FIELD",
    );
  return { parts: [name], type: def.fields[name]! };
};

const soqlRead = (object: string, record: Readonly<Record<string, unknown>>, parts: readonly string[]): unknown => {
  if (parts.length === 1) return record[parts[0]!] ?? null;
  const relation = SOBJECTS[object]!.relationships[parts[0]!]!;
  const target = SOBJECTS[relation]!.records().find((one) => one.Id === record[REFERENCE_KEYS[parts[0]!]!]);
  return target ? soqlRead(relation, target, parts.slice(1)) : null;
};

const soqlCompare = (object: string, record: Readonly<Record<string, unknown>>, condition: SoqlCondition): boolean => {
  if (condition.kind === "and") return condition.parts.every((part) => soqlCompare(object, record, part));
  if (condition.kind === "or") return condition.parts.some((part) => soqlCompare(object, record, part));
  if (condition.kind === "not") return !soqlCompare(object, record, condition.part);
  const field = soqlField(object, condition.path);
  const value = soqlRead(object, record, field.parts);
  const one = (literal: SoqlLiteral): boolean => {
    const quoted = literal.kind === "string";
    if (literal.kind === "null") return condition.op === "=" ? value === null : condition.op === "!=" ? value !== null : false;
    if (field.type === "date" || field.type === "datetime") {
      if (literal.kind !== "date")
        throw new SoqlError(
          `value of filter criterion for field '${condition.path}' must be of type ${field.type} and should not be enclosed in quotes`,
          "INVALID_QUERY_FILTER_OPERATOR",
        );
      if (value === null) return condition.op === "!=";
      const ms = Date.parse(field.type === "date" ? `${String(value)}T00:00:00Z` : String(value).replace(/\+0000$/, "Z"));
      const exact = literal.start === literal.end;
      switch (condition.op) {
        case "=":
          return exact ? ms === literal.start : ms >= literal.start && ms < literal.end;
        case "!=":
          return exact ? ms !== literal.start : ms < literal.start || ms >= literal.end;
        case "<":
          return ms < literal.start;
        case "<=":
          return exact ? ms <= literal.start : ms < literal.end;
        case ">":
          return exact ? ms > literal.start : ms >= literal.end;
        case ">=":
          return ms >= literal.start;
        default:
          return false;
      }
    }
    if (field.type === "currency" || field.type === "percent") {
      if (literal.kind !== "number")
        throw new SoqlError(
          `value of filter criterion for field '${condition.path}' must be of type double and should not be enclosed in quotes`,
          "INVALID_QUERY_FILTER_OPERATOR",
        );
      if (value === null) return condition.op === "!=";
      const n = Number(value);
      const op = condition.op;
      return op === "=" || op === "IN" ? n === literal.value : op === "!=" || op === "NOT IN" ? n !== literal.value : op === "<" ? n < literal.value : op === "<=" ? n <= literal.value : op === ">" ? n > literal.value : n >= literal.value;
    }
    if (field.type === "boolean") {
      if (literal.kind !== "boolean")
        throw new SoqlError(
          `value of filter criterion for field '${condition.path}' must be of type boolean and should not be enclosed in quotes`,
          "INVALID_QUERY_FILTER_OPERATOR",
        );
      return condition.op === "!=" ? value !== literal.value : value === literal.value;
    }
    if (!quoted)
      throw new SoqlError(`value of filter criterion for field '${condition.path}' must be of type string and should be enclosed in quotes`, "INVALID_QUERY_FILTER_OPERATOR");
    const text = String(value ?? "").toLowerCase();
    const wanted = literal.value.toLowerCase();
    switch (condition.op) {
      case "LIKE": {
        const pattern = new RegExp(`^${likePattern(wanted)}$`, "s");
        return value !== null && pattern.test(text);
      }
      case "=":
      case "IN":
        return value !== null && text === wanted;
      case "!=":
      case "NOT IN":
        return value === null || text !== wanted;
      case "<":
        return value !== null && text < wanted;
      case "<=":
        return value !== null && text <= wanted;
      case ">":
        return value !== null && text > wanted;
      default:
        return value !== null && text >= wanted;
    }
  };
  if (condition.op === "IN") return condition.values.some(one);
  if (condition.op === "NOT IN") return condition.values.every(one);
  return one(condition.values[0]!);
};

const pfAttributes = (object: string, id: unknown, version: string): Record<string, unknown> => ({
  type: object,
  url: `/services/data/v${version}/sobjects/${object}/${String(id)}`,
});

/** Run a query: the matching records, shaped as the API returns them. */
const runSoql = (source: string, all: boolean, version: string): { rows: Record<string, unknown>[]; countOnly: boolean } => {
  const query = parseSoql(source);
  const object = query.from;
  const def = SOBJECTS[object]!;
  if (query.offset !== null && query.offset > 2000)
    throw new SoqlError("Maximum SOQL offset allowed is 2000", "NUMBER_OUTSIDE_VALID_RANGE");
  if (query.select.some((one) => one.kind === "fields") && (query.limit === null || query.limit > 200))
    throw new SoqlError("The SOQL FIELDS function must have a LIMIT of at most 200");
  let records = def.records().filter((record) => all || record.IsDeleted !== true);
  if (query.where) {
    const where = query.where;
    records = records.filter((record) => soqlCompare(object, record, where));
  }
  const aggregates = query.select.filter((one): one is Extract<SoqlSelect, { kind: "agg" }> => one.kind === "agg");
  if (aggregates.length > 0) {
    const plain = query.select.filter((one) => one.kind === "field");
    if (aggregates.length === 1 && aggregates[0]!.fn === "COUNT" && !aggregates[0]!.path && plain.length === 0 && !query.groupBy)
      return { rows: records.map((record) => ({ ...record })), countOnly: true };
    const group = query.groupBy ? soqlField(object, query.groupBy) : null;
    for (const one of plain)
      if (!group || soqlField(object, (one as { path: string }).path).parts.join(".") !== group.parts.join("."))
        throw new SoqlError(`Field must be grouped or aggregated: ${(one as { path: string }).path}`);
    const groups = new Map<string, Readonly<Record<string, unknown>>[]>();
    for (const record of records) {
      const key = group ? String(soqlRead(object, record, group.parts)) : "";
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    const rows = [...groups.entries()].map(([key, members]) => {
      const row: Record<string, unknown> = { attributes: { type: "AggregateResult" } };
      if (group) row[group.parts[group.parts.length - 1]!] = key;
      aggregates.forEach((agg, index) => {
        const name = agg.alias ?? `expr${index}`;
        const values = agg.path
          ? members.map((member) => soqlRead(object, member, soqlField(object, agg.path!).parts)).filter((one) => one !== null)
          : members;
        const numbers = values.map(Number);
        row[name] =
          agg.fn === "COUNT"
            ? values.length
            : agg.fn === "COUNT_DISTINCT"
              ? new Set(values.map(String)).size
              : numbers.length === 0
                ? null
                : agg.fn === "SUM"
                  ? Math.round(numbers.reduce((sum, n) => sum + n, 0) * 100) / 100
                  : agg.fn === "AVG"
                    ? numbers.reduce((sum, n) => sum + n, 0) / numbers.length
                    : agg.fn === "MIN"
                      ? Math.min(...numbers)
                      : Math.max(...numbers);
      });
      return row;
    });
    return { rows, countOnly: false };
  }
  if (query.order.length > 0) {
    const keys = query.order.map((one) => ({ ...one, field: soqlField(object, one.path) }));
    records = [...records].sort((a, b) => {
      for (const key of keys) {
        const left = soqlRead(object, a, key.field.parts);
        const right = soqlRead(object, b, key.field.parts);
        if (left === right) continue;
        if (left === null) return key.nullsFirst ? -1 : 1;
        if (right === null) return key.nullsFirst ? 1 : -1;
        return ((left as string | number) < (right as string | number) ? -1 : 1) * (key.desc ? -1 : 1);
      }
      return 0;
    });
  }
  const start = query.offset ?? 0;
  records = records.slice(start, query.limit === null ? undefined : start + query.limit);
  const fields = query.select.some((one) => one.kind === "fields")
    ? Object.keys(def.fields).map((name) => ({ parts: [name] as readonly string[] }))
    : query.select.map((one) => soqlField(object, (one as { path: string }).path));
  const rows = records.map((record) => {
    const row: Record<string, unknown> = { attributes: pfAttributes(object, record.Id, version) };
    for (const field of fields) {
      if (field.parts.length === 1) row[field.parts[0]!] = record[field.parts[0]!] ?? null;
      else {
        const [relation, name] = field.parts as [string, string];
        const target = SOBJECTS[def.relationships[relation]!]!.records().find((one) => one.Id === record[REFERENCE_KEYS[relation]!]);
        const existing = (row[relation] as Record<string, unknown> | null | undefined) ?? (target ? { attributes: pfAttributes(def.relationships[relation]!, target.Id, version) } : null);
        if (existing && target) existing[name] = target[name] ?? null;
        row[relation] = existing;
      }
    }
    return row;
  });
  return { rows, countOnly: false };
};

/** A LIKE pattern as a regular expression: % any run, _ any one character. */
const likePattern = (value: string): string =>
  value
    .split("")
    .map((ch) => (ch === "%" ? ".*" : ch === "_" ? "." : /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch))
    .join("");

const pfError = (status: number, errorCode: string, message: string): BenchResponse => json([{ message, errorCode }], status);

const pfLocators = new Map<string, { readonly rows: readonly Record<string, unknown>[]; readonly size: number }>();
const pfTokens = new Set<string>();

const pfBatch = (version: string, locator: string | null, rows: readonly Record<string, unknown>[], from: number, size: number) => {
  const end = Math.min(rows.length, from + size);
  return {
    totalSize: rows.length,
    done: end >= rows.length,
    ...(end < rows.length ? { nextRecordsUrl: `/services/data/v${version}/query/${locator}-${end}` } : {}),
    records: rows.slice(from, end),
  };
};

const pfDescribe = (object: string): Record<string, unknown> => ({
  name: object,
  label: object,
  queryable: true,
  fields: Object.entries(SOBJECTS[object]!.fields).map(([name, type]) => ({
    name,
    label: name.replace(/([a-z])([A-Z])/g, "$1 $2"),
    type,
    nillable: !["Id", "Name", "IsDeleted", "IsClosed", "IsWon"].includes(name),
    ...(name === "StageName"
      ? { picklistValues: [...new Set(PF_STAGES.map(([stage]) => stage))].map((value) => ({ value, label: value, active: true })) }
      : {}),
  })),
});

const pipeforceSpec = {
  openapi: "3.0.3",
  info: {
    title: "Pipeforce REST API",
    version: "61.0",
    description:
      "Read and query records in your Pipeforce org. Every org has its own address, its My Domain: https://{mydomain}.my.pipeforce.bench.test.\n\n" +
      "**Signing in.** Create a Connected App (Setup → App Manager → New Connected App), enable OAuth, enable the Client Credentials Flow and choose a run-as user. " +
      "Its Consumer Key and Consumer Secret are the client ID and secret. Request tokens from your My Domain's token endpoint, " +
      "https://{mydomain}.my.pipeforce.bench.test/services/oauth2/token. Token responses give the instance_url to call; they do not say when the token expires.\n\n" +
      "**Queries.** Records are read with SOQL, a SQL-like language, sent in the q parameter of /query. " +
      "A query's records come in batches (2,000 by default; the Sforce-Query-Options header can ask for batchSize=200 to 2000). " +
      "When done is false, get the next batch by requesting the nextRecordsUrl path the response gives, on the same host. " +
      "Deleted records are left out; /queryAll includes them, with IsDeleted true.",
  },
  servers: [
    {
      url: "https://{mydomain}.my.pipeforce.bench.test/services/data/v61.0",
      variables: { mydomain: { default: "yourdomain", description: "Your org's My Domain name" } },
    },
  ],
  components: {
    securitySchemes: {
      oauth: {
        type: "oauth2",
        flows: {
          clientCredentials: {
            tokenUrl: `https://${P_LOGIN}/services/oauth2/token`,
            scopes: { api: "Access and manage your data" },
          },
        },
      },
    },
    schemas: {
      QueryResult: {
        type: "object",
        properties: {
          totalSize: { type: "integer" },
          done: { type: "boolean" },
          nextRecordsUrl: { type: "string", description: "The path of the next batch, e.g. /services/data/v61.0/query/01gHs0000000001IAQ-2000. Absent when done is true." },
          records: { type: "array", items: { type: "object", description: "Each record has an attributes object with its type and url, then the fields selected." } },
        },
      },
    },
  },
  security: [{ oauth: ["api"] }],
  paths: {
    "/query": {
      get: {
        operationId: "query",
        summary: "Execute a SOQL query",
        description:
          "Runs a SOQL query, e.g. SELECT Id, Name, Amount, StageName, CloseDate FROM Opportunity WHERE IsClosed = true. " +
          "String values are quoted with single quotes; dates, numbers and booleans are not. Date literals such as THIS_YEAR and LAST_N_DAYS:30 are supported.",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string" }, description: "A SOQL query." },
          { name: "Sforce-Query-Options", in: "header", schema: { type: "string" }, description: "batchSize=N, from 200 to 2000. A request, not a guarantee." },
        ],
        responses: {
          "200": { description: "The first batch", content: { "application/json": { schema: { $ref: "#/components/schemas/QueryResult" } } } },
          "400": { description: "The query is malformed: an array of { message, errorCode }." },
          "401": { description: "The session is invalid or has expired." },
        },
      },
    },
    "/query/{queryLocator}": {
      get: {
        operationId: "queryMore",
        summary: "The next batch of a query",
        description: "Request the nextRecordsUrl of the previous batch.",
        parameters: [{ name: "queryLocator", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The next batch", content: { "application/json": { schema: { $ref: "#/components/schemas/QueryResult" } } } } },
      },
    },
    "/queryAll": {
      get: {
        operationId: "queryAll",
        summary: "Execute a SOQL query, including deleted records",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The first batch", content: { "application/json": { schema: { $ref: "#/components/schemas/QueryResult" } } } } },
      },
    },
    "/sobjects": {
      get: { operationId: "describeGlobal", summary: "List the objects in the org", responses: { "200": { description: "Objects" } } },
    },
    "/sobjects/{sObject}/describe": {
      get: {
        operationId: "describeSObject",
        summary: "Describe an object's fields",
        parameters: [{ name: "sObject", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The object's fields and their types" } },
      },
    },
    "/sobjects/{sObject}/{id}": {
      get: {
        operationId: "getSObject",
        summary: "One record",
        parameters: [
          { name: "sObject", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "The record" } },
      },
    },
  },
};

const PIPEFORCE_CODE = `var INSTANCE = "https://${P_HOST}";
var VERSION = "/services/data/v61.0";
var SOQL = "SELECT Id, Name, Amount, StageName, CloseDate, IsWon FROM Opportunity";

async function authenticate(ctx) {
  await auth.exchange({
    name: "session",
    request: {
      method: "POST",
      url: INSTANCE + "/services/oauth2/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&client_id={{secret:consumer_key}}&client_secret={{secret:consumer_secret}}"
    },
    token: "$.access_token"
  });
}

async function read(ctx) {
  var headers = { authorization: "Bearer {{secret:session}}" };
  var rows = [];
  var response = await http.request({ method: "GET", url: INSTANCE + VERSION + "/query", query: { q: SOQL }, headers: headers, as: "json" });
  for (var batch = 0; batch < 50; batch++) {
    if (response.status !== 200) throw new Error("query answered HTTP " + response.status + ": " + JSON.stringify(response.body).slice(0, 300));
    var body = response.body;
    for (var i = 0; i < body.records.length; i++) {
      var record = body.records[i];
      var row = {};
      for (var key in record) if (key !== "attributes") row[key] = record[key];
      rows.push(row);
    }
    if (body.done || !body.nextRecordsUrl) return { rows: rows, total: body.totalSize, complete: true };
    response = await http.request({ method: "GET", url: INSTANCE + body.nextRecordsUrl, headers: headers, as: "json" });
  }
  return { rows: rows, complete: false };
}
`;

export const pipeforce: MockProvider = {
  id: "pipeforce",
  split: "heldout",
  pattern:
    "CRM on a per-org host: client credentials only its own host issues (the spec's login host refuses them), a SQL-like query in a parameter, batches continued by a path the last batch gives rather than a parameter, deleted records only via queryAll",
  hosts: [P_HOST, P_LOGIN, P_DOCS],
  docsUrl: `https://${P_DOCS}/docs/rest-api/openapi.json`,
  credentials: [P_DOMAIN, P_KEY, P_SECRET],
  credentialLabels: ["My Domain name", "Consumer Key", "Consumer Secret"],
  reset() {
    pfLocators.clear();
    pfTokens.clear();
  },
  reference: {
    connection: {
      id: "pipeforce",
      title: "Pipeforce",
      kind: "rest",
      baseUrl: `https://${P_HOST}/services/data/v61.0`,
      auth: {
        type: "connector",
        credentials: [
          { name: "consumer_key", keyRef: "pipeforce-key", label: "Consumer Key" },
          { name: "consumer_secret", keyRef: "pipeforce-secret", label: "Consumer Secret" },
        ],
        tokens: [{ name: "session", keyRef: "pipeforce-session" }],
      },
      ops: [{ id: "opportunities", title: "Opportunities (SOQL query)", path: "/query", servedBy: "connector", maxPages: 50 }],
      connector: {
        code: PIPEFORCE_CODE,
        hash: connectorHash(PIPEFORCE_CODE),
        hooks: ["authenticate", "read"],
        serves: ["opportunities"],
        authority: {
          destinations: [{ host: P_HOST, methods: ["GET", "POST"], credentials: ["consumer_key", "consumer_secret", "session"] }],
          exchanges: [{ name: "session", fields: [] }],
        },
        summary: "Signs in with client credentials at the org's My Domain, runs one SOQL query over opportunities and follows nextRecordsUrl to the last batch.",
        author: { by: "person", at: "2026-09-28T00:00:00.000Z" },
      },
    },
    secrets: { "pipeforce-key": P_KEY, "pipeforce-secret": P_SECRET },
  },
  objectives: [
    {
      id: "won-2026",
      request: "What's the total amount of the opportunities we won in 2026?",
      answer: major(
        pfLive
          .filter((one) => one.StageName === "Closed Won" && one.CloseDate.startsWith("2026"))
          .reduce((sum, one) => sum + (one.amountCents ?? 0), 0),
      ),
      tolerance: 0.005,
      records: pfLive.length,
      scripted: {
        path: "/query",
        measure: { agg: "sum", field: "Amount", where: 'StageName == "Closed Won" && startsWith(CloseDate, "2026")' },
      },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === P_DOCS) {
      if (url.pathname === "/docs/rest-api/openapi.json") return json(pipeforceSpec);
      return notFound();
    }
    if (url.pathname === "/services/oauth2/token") {
      if (request.method !== "POST") return json({ error: "invalid_request", error_description: "must use HTTP POST" }, 400);
      const fields = form(request.body);
      const pair = basicPair(request);
      const id = fields.get("client_id") ?? pair?.[0];
      const secret = fields.get("client_secret") ?? pair?.[1];
      const grant = fields.get("grant_type");
      if (url.hostname === P_LOGIN) {
        if (grant === "client_credentials")
          return json({ error: "unsupported_grant_type", error_description: "grant type not supported on this domain; request client credentials tokens from your My Domain" }, 400);
        return json({ error: "invalid_grant", error_description: "authentication failure" }, 400);
      }
      if (grant !== "client_credentials") return json({ error: "unsupported_grant_type", error_description: "grant type not supported" }, 400);
      if (id !== P_KEY || secret !== P_SECRET) return json({ error: "invalid_client", error_description: "invalid client credentials" }, 400);
      const token = `00DHs000000bXyz!AR8AQ${hex(random(pfTokens.size + 1), 24)}`;
      pfTokens.add(token);
      return json({
        access_token: token,
        signature: Buffer.from(token).toString("base64").slice(0, 44),
        scope: "api",
        instance_url: `https://${P_HOST}`,
        id: `https://${P_LOGIN}/id/00DHs000000bXyzMAE/${pfUsers[0].Id}`,
        token_type: "Bearer",
        issued_at: String(BENCH_NOW),
      });
    }
    if (url.hostname === P_LOGIN) return notFound();
    if (url.pathname === "/services/data" || url.pathname === "/services/data/")
      return json(P_VERSIONS.map((version) => ({ label: `v${version}`, url: `/services/data/v${version}`, version })));
    const route = /^\/services\/data\/v(\d+\.\d)(\/.*)?$/.exec(url.pathname);
    if (!route) return pfError(404, "NOT_FOUND", "The requested resource does not exist");
    const version = route[1]!;
    if (!(P_VERSIONS as readonly string[]).includes(version)) return pfError(404, "NOT_FOUND", "The requested resource does not exist");
    const token = (request.headers.authorization ?? "").replace(/^(?:Bearer|OAuth) /i, "");
    if (!pfTokens.has(token)) return pfError(401, "INVALID_SESSION_ID", "Session expired or invalid");
    if (request.method !== "GET") return pfError(405, "METHOD_NOT_ALLOWED", `HTTP Method '${request.method}' not allowed. Allowed are GET,HEAD`);
    const rest = route[2] ?? "/";
    if (rest === "/" || rest === "")
      return json({ sobjects: `/services/data/v${version}/sobjects`, query: `/services/data/v${version}/query`, queryAll: `/services/data/v${version}/queryAll` });
    if (rest === "/sobjects" || rest === "/sobjects/")
      return json({
        encoding: "UTF-8",
        maxBatchSize: 200,
        sobjects: Object.keys(SOBJECTS).map((name) => ({ name, label: name, queryable: true, urls: { describe: `/services/data/v${version}/sobjects/${name}/describe` } })),
      });
    const describe = /^\/sobjects\/([A-Za-z]+)\/describe\/?$/.exec(rest);
    if (describe) {
      const object = Object.keys(SOBJECTS).find((name) => name.toLowerCase() === describe[1]!.toLowerCase());
      return object ? json(pfDescribe(object)) : pfError(404, "NOT_FOUND", `The requested resource does not exist`);
    }
    const record = /^\/sobjects\/([A-Za-z]+)\/([A-Za-z0-9]{15,18})$/.exec(rest);
    if (record) {
      const object = Object.keys(SOBJECTS).find((name) => name.toLowerCase() === record[1]!.toLowerCase());
      const found = object ? SOBJECTS[object]!.records().find((one) => one.Id === record[2] && one.IsDeleted !== true) : undefined;
      if (!object || !found) return pfError(404, "NOT_FOUND", "The requested resource does not exist");
      const visible = Object.fromEntries(Object.entries(found).filter(([name]) => name in SOBJECTS[object]!.fields));
      return json({ attributes: pfAttributes(object, found.Id, version), ...visible });
    }
    const more = /^\/query\/([A-Za-z0-9]+)-(\d+)$/.exec(rest);
    if (more) {
      const kept = pfLocators.get(more[1]!);
      if (!kept) return pfError(400, "INVALID_QUERY_LOCATOR", "invalid query locator");
      return json(pfBatch(version, more[1]!, kept.rows, Number(more[2]), kept.size));
    }
    if (rest === "/query" || rest === "/query/" || rest === "/queryAll" || rest === "/queryAll/") {
      const q = url.searchParams.get("q");
      if (!q) return pfError(400, "MALFORMED_QUERY", "A query string must be provided in the q parameter");
      let result: ReturnType<typeof runSoql>;
      try {
        result = runSoql(q, rest.startsWith("/queryAll"), version);
      } catch (error) {
        if (error instanceof SoqlError) return pfError(400, error.errorCode, error.message);
        throw error;
      }
      if (result.countOnly) return json({ totalSize: result.rows.length, done: true, records: [] });
      const asked = /batchSize=(\d+)/i.exec(request.headers["sforce-query-options"] ?? "");
      const size = asked ? Math.min(2000, Math.max(200, Number(asked[1]))) : P_DEFAULT_BATCH;
      let locator: string | null = null;
      if (result.rows.length > size) {
        locator = `01gHs${String(pfLocators.size + 1).padStart(10, "0")}IAQ`;
        pfLocators.set(locator, { rows: result.rows, size });
      }
      return json(pfBatch(version, locator, result.rows, 0, size));
    }
    return pfError(404, "NOT_FOUND", "The requested resource does not exist");
  },
};
