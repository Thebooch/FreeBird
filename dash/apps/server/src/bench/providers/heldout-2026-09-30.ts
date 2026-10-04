import { connectorHash } from "../../connector/adapter.js";
import { BENCH_NOW, cents, html, intParam, json, major, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Held-out providers written on 2026-09-29 to replace harborline, shopwell and
 * cashloom, which moved to the dev set after checkpoint 4. Written by the
 * author of `heldout-2026-09-28.ts` and `heldout-2026-09-29.ts`, under
 * the same rules (`dash/bench/HELDOUT-AUTHORING.md`): without reading the
 * integration loop, the importers, any result, or the dev set's providers.
 *
 * Nothing here may be read while tuning the loop, a prompt or a repair; they
 * run only at a checkpoint (`dash/bench/PROTOCOL.md`).
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/* ── shared ───────────────────────────────────────────────────────────── */

const page = (title: string, content: string): BenchResponse =>
  html(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n${content}\n</body></html>`);

const esc = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const decimal = (amountCents: number): string => (amountCents / 100).toFixed(2);

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const FIRST_NAMES = [
  "Ada", "Bram", "Cleo", "Dario", "Esme", "Felix", "Gia", "Hank", "Ines", "Jude", "Kofi", "Lena", "Milo",
  "Nia", "Omar", "Pia", "Reza", "Sofia", "Tomas", "Vera", "Wes", "Xena", "Yusuf", "Zora",
] as const;
const LAST_NAMES = [
  "Almeida", "Brooks", "Castillo", "Dubois", "Eriksen", "Flores", "Gill", "Hughes", "Iqbal", "Jovanovic", "Kowalski",
  "Lindgren", "Murphy", "Nguyen", "Olsen", "Park", "Reyes", "Schmidt", "Thompson", "Usman", "Vasquez", "Wright",
] as const;

/* ── Payrail: a related record reachable only by expanding it ─────────── */

/*
 * A card-payments API after the developer-first processors: a secret key,
 * newest-first lists paged by the last object's id with `has_more`, unknown
 * parameters refused, and related objects returned as bare ids unless the
 * request expands them — on a list, only with the `data.` prefix. A deleted
 * customer expands to a stub. The question is about the customer, so the
 * answer is in the expansion.
 */

const PR_API = "api.payrail.bench.test";
const PR_DOCS = "docs.payrail.bench.test";
const PR_KEY = "prl_sk_live_7Qm2Xc9Vb4Nz8Kt1Hw";

interface PrCustomer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly country: string | null;
  readonly city: string;
  readonly created: number;
  readonly deleted: boolean;
}

const PR_CITIES: Readonly<Record<string, readonly string[]>> = {
  US: ["Austin", "Denver", "Portland", "Columbus", "Raleigh"],
  CA: ["Toronto", "Calgary", "Halifax", "Montréal", "Victoria"],
  GB: ["Leeds", "Bristol", "Glasgow"],
  AU: ["Perth", "Brisbane"],
};

const prCustomers: readonly PrCustomer[] = (() => {
  const next = random(13011);
  return Array.from({ length: 260 }, (_, index): PrCustomer => {
    const country =
      next() < 0.05
        ? null
        : pick(next, ["US", "US", "US", "US", "US", "US", "US", "US", "US", "US", "US", "CA", "CA", "CA", "CA", "CA", "GB", "GB", "AU"] as const);
    const first = pick(next, FIRST_NAMES);
    const last = pick(next, LAST_NAMES);
    return {
      id: `cus_R${(0x3c1f00 + index * 5_471).toString(36)}${index.toString(36).padStart(2, "0")}`,
      name: `${first} ${last}`,
      email: `${first}.${last}${index}@example.com`.toLowerCase(),
      country,
      city: country ? pick(next, PR_CITIES[country]!) : "",
      created: Math.floor((BENCH_NOW - (560 - index * 2) * DAY) / 1000),
      deleted: next() < 0.06,
    };
  });
})();

interface PrCharge {
  readonly id: string;
  readonly amount: number;
  readonly status: "succeeded" | "failed" | "pending";
  readonly customer: string | null;
  readonly created: number;
  readonly description: string;
  readonly failureCode: string | null;
}

const prCharges: readonly PrCharge[] = (() => {
  const next = random(13022);
  const count = 1150;
  const all = Array.from({ length: count }, (_, index): PrCharge => {
    const status = pick(next, [
      "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded",
      "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "failed", "failed", "pending",
    ] as const);
    const guest = next() < 0.1;
    const customer = guest ? null : pick(next, prCustomers).id;
    return {
      id: `ch_3R${(0x7a0000 + index * 7_919).toString(36)}${index.toString(36).padStart(3, "0")}`,
      amount: cents(next, 6, 740),
      status,
      customer,
      created: Math.floor((BENCH_NOW - 400 * DAY) / 1000) + Math.floor((index * 399 * 86_400) / count) + Math.floor(next() * 3_600),
      description: pick(next, ["Order payment", "Subscription", "Invoice payment", "Deposit", "Gift card"] as const),
      failureCode: status === "failed" ? pick(next, ["card_declined", "insufficient_funds", "expired_card", "incorrect_cvc"] as const) : null,
    };
  });
  /* Newest first, the way every list answers. */
  return all.sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
})();

const prCustomerView = (customer: PrCustomer): Record<string, unknown> =>
  customer.deleted
    ? { id: customer.id, object: "customer", deleted: true }
    : {
        id: customer.id,
        object: "customer",
        name: customer.name,
        email: customer.email,
        address: customer.country
          ? { line1: `${10 + (customer.created % 890)} Main St`, city: customer.city, postal_code: null, state: null, country: customer.country }
          : null,
        created: customer.created,
        livemode: true,
        metadata: {},
      };

const prChargeView = (charge: PrCharge, expandCustomer: boolean): Record<string, unknown> => {
  const customer = charge.customer ? prCustomers.find((one) => one.id === charge.customer) : undefined;
  return {
    id: charge.id,
    object: "charge",
    amount: charge.amount,
    amount_captured: charge.status === "succeeded" ? charge.amount : 0,
    currency: "usd",
    status: charge.status,
    paid: charge.status === "succeeded",
    captured: charge.status === "succeeded",
    customer: customer ? (expandCustomer ? prCustomerView(customer) : customer.id) : null,
    description: charge.description,
    failure_code: charge.failureCode,
    created: charge.created,
    livemode: true,
    metadata: {},
  };
};

const prError = (status: number, message: string, param?: string, type = "invalid_request_error"): BenchResponse =>
  json({ error: { type, message, ...(param ? { param } : {}) } }, status);

/** The `expand` values a request asked for: `expand[]` or `expand[0]`, never a bare `expand`. */
const prExpansions = (url: URL): string[] | BenchResponse => {
  const asked: string[] = [];
  for (const [name, value] of url.searchParams) {
    if (name === "expand") return prError(400, "Invalid array", "expand");
    if (name === "expand[]" || /^expand\[\d+\]$/.test(name)) asked.push(value);
  }
  return asked;
};

const prCustomerSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    object: { type: "string", enum: ["customer"] },
    name: { type: "string", nullable: true },
    email: { type: "string", nullable: true },
    address: {
      type: "object",
      nullable: true,
      properties: {
        line1: { type: "string" },
        city: { type: "string" },
        state: { type: "string", nullable: true },
        postal_code: { type: "string", nullable: true },
        country: { type: "string", description: "Two-letter country code (ISO 3166-1 alpha-2)." },
      },
    },
    created: { type: "integer" },
    livemode: { type: "boolean" },
    metadata: { type: "object" },
  },
};

const payrailSpec = {
  openapi: "3.0.0",
  info: {
    title: "Payrail API",
    version: "2026-06-15",
    description:
      "The Payrail API is organised around REST. Authenticate with your secret key (Dashboard → Developers → API keys) as a bearer token. " +
      "Amounts are integers in the smallest currency unit.\n\n" +
      "**Pagination.** List endpoints return objects newest first, inside a list object with data and has_more. " +
      "Pass limit (1 to 100, default 10) and, for the next page, starting_after with the ID of the last object you received.\n\n" +
      "**Expanding responses.** Many objects hold the ID of a related object. You can have the related object returned in its place with the expand[] " +
      "parameter. On list endpoints the expansion applies to each item, so prefix the field with data. — for example expand[]=data.customer. " +
      "A deleted object expands to a stub with deleted: true. Expansions can be nested up to four levels deep.\n\n" +
      "**Errors.** A parameter the endpoint does not accept is refused with 400.",
  },
  servers: [{ url: `https://${PR_API}/` }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Your secret key." } },
    schemas: {
      Customer: prCustomerSchema,
      DeletedCustomer: {
        type: "object",
        properties: { id: { type: "string" }, object: { type: "string", enum: ["customer"] }, deleted: { type: "boolean", enum: [true] } },
      },
      Charge: {
        type: "object",
        properties: {
          id: { type: "string" },
          object: { type: "string", enum: ["charge"] },
          amount: { type: "integer", description: "In the smallest currency unit: 1250 is $12.50." },
          amount_captured: { type: "integer" },
          currency: { type: "string" },
          status: { type: "string", enum: ["succeeded", "pending", "failed"] },
          paid: { type: "boolean" },
          captured: { type: "boolean" },
          customer: {
            nullable: true,
            description: "ID of the customer this charge is for, if one exists.",
            anyOf: [{ type: "string" }, { $ref: "#/components/schemas/Customer" }, { $ref: "#/components/schemas/DeletedCustomer" }],
            "x-expandableFields": true,
          },
          description: { type: "string", nullable: true },
          failure_code: { type: "string", nullable: true },
          created: { type: "integer", description: "Unix time, in seconds." },
          livemode: { type: "boolean" },
          metadata: { type: "object" },
        },
        "x-expandableFields": ["customer"],
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/v1/charges": {
      get: {
        operationId: "GetCharges",
        summary: "List all charges",
        description: "Returns a list of charges you've previously created, most recent first.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 10, minimum: 1, maximum: 100 } },
          {
            name: "starting_after",
            in: "query",
            schema: { type: "string" },
            description: "A cursor for pagination: the ID of the last object in the previous page, to fetch the next page.",
          },
          { name: "ending_before", in: "query", schema: { type: "string" }, description: "A cursor for pagination, to fetch the previous page." },
          { name: "customer", in: "query", schema: { type: "string" }, description: "Only charges for the customer with this ID." },
          {
            name: "created",
            in: "query",
            style: "deepObject",
            explode: true,
            schema: { type: "object", properties: { gt: { type: "integer" }, gte: { type: "integer" }, lt: { type: "integer" }, lte: { type: "integer" } } },
          },
          {
            name: "expand",
            in: "query",
            style: "deepObject",
            explode: true,
            schema: { type: "array", items: { type: "string", maxLength: 5000 } },
            description: "Specifies which fields in the response should be expanded.",
          },
        ],
        responses: {
          "200": {
            description: "Successful response.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["object", "data", "has_more", "url"],
                  properties: {
                    object: { type: "string", enum: ["list"] },
                    data: { type: "array", items: { $ref: "#/components/schemas/Charge" } },
                    has_more: { type: "boolean", description: "True if this list has another page of items after this one." },
                    url: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { description: "Error response." },
        },
      },
    },
    "/v1/charges/{charge}": {
      get: {
        operationId: "GetChargesCharge",
        summary: "Retrieve a charge",
        parameters: [
          { name: "charge", in: "path", required: true, schema: { type: "string" } },
          { name: "expand", in: "query", style: "deepObject", explode: true, schema: { type: "array", items: { type: "string" } } },
        ],
        responses: { "200": { description: "Successful response.", content: { "application/json": { schema: { $ref: "#/components/schemas/Charge" } } } } },
      },
    },
    "/v1/customers": {
      get: {
        operationId: "GetCustomers",
        summary: "List all customers",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 10, minimum: 1, maximum: 100 } },
          { name: "starting_after", in: "query", schema: { type: "string" } },
          { name: "ending_before", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Successful response.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    object: { type: "string" },
                    data: { type: "array", items: { $ref: "#/components/schemas/Customer" } },
                    has_more: { type: "boolean" },
                    url: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/customers/{customer}": {
      get: {
        operationId: "GetCustomersCustomer",
        summary: "Retrieve a customer",
        parameters: [{ name: "customer", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Successful response.", content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } } } },
      },
    },
  },
};

/** A newest-first list, paged by object ID. */
const prPage = <T extends { readonly id: string }>(
  url: URL,
  items: readonly T[],
  known: ReadonlySet<string>,
  kind: string,
): { slice: readonly T[]; hasMore: boolean } | BenchResponse => {
  for (const name of url.searchParams.keys())
    if (!known.has(name) && !/^expand\[\d*\]$/.test(name) && name !== "expand")
      return prError(400, `Received unknown parameter: ${name}`, name);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 10 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return prError(400, "Invalid integer: limit must be between 1 and 100", "limit");
  const after = url.searchParams.get("starting_after");
  const before = url.searchParams.get("ending_before");
  if (after && before) return prError(400, "You may only specify one of these parameters: starting_after, ending_before.");
  const position = (id: string): number => items.findIndex((item) => item.id === id);
  if (after !== null) {
    const at = position(after);
    if (at < 0) return prError(400, `No such ${kind}: '${after}'`, "starting_after");
    return { slice: items.slice(at + 1, at + 1 + limit), hasMore: at + 1 + limit < items.length };
  }
  if (before !== null) {
    const at = position(before);
    if (at < 0) return prError(400, `No such ${kind}: '${before}'`, "ending_before");
    return { slice: items.slice(Math.max(0, at - limit), at), hasMore: at - limit > 0 };
  }
  return { slice: items.slice(0, limit), hasMore: limit < items.length };
};

export const payrail: MockProvider = {
  id: "payrail",
  split: "heldout",
  pattern:
    "Card payments whose question is about a related record returned only as an id unless expanded — on a list, only with the data. prefix; deleted records expand to stubs; newest-first pages by last id; unknown parameters refused",
  hosts: [PR_API, PR_DOCS],
  docsUrl: `https://${PR_DOCS}/api/openapi.json`,
  credentials: [PR_KEY],
  credentialLabels: ["Secret key"],
  reference: {
    connection: {
      id: "payrail",
      title: "Payrail",
      kind: "rest",
      baseUrl: `https://${PR_API}/v1`,
      auth: { type: "bearer", keyRef: "payrail-key", label: "Secret key" },
      ops: [
        {
          id: "charges",
          title: "List all charges",
          path: "/charges",
          query: { limit: 100, "expand[]": "data.customer" },
          rowsPath: "$.data",
          pagination: { kind: "cursor", param: "starting_after", cursorPath: "$.data[last].id", hasMorePath: "$.has_more" },
          maxPages: 20,
        },
      ],
    },
    secrets: { "payrail-key": PR_KEY },
  },
  objectives: [
    {
      id: "canadian-payments",
      request: "How many successful payments came from customers based in Canada?",
      answer: prCharges.filter((charge) => {
        const customer = charge.customer ? prCustomers.find((one) => one.id === charge.customer) : undefined;
        return charge.status === "succeeded" && customer !== undefined && !customer.deleted && customer.country === "CA";
      }).length,
      tolerance: 0,
      records: prCharges.length,
      scripted: { path: "/charges", measure: { agg: "count", where: 'status == "succeeded" && customer.address.country == "CA"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === PR_DOCS) {
      if (url.pathname === "/api/openapi.json") return json(payrailSpec);
      return notFound();
    }
    const authorization = request.headers.authorization ?? "";
    if (!authorization)
      return prError(401, "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth.", undefined, "authentication_error");
    const key = authorization.replace(/^Bearer\s+/i, "");
    if (key !== PR_KEY)
      return prError(401, `Invalid API Key provided: ${key.slice(0, 12)}${"*".repeat(Math.max(0, key.length - 16))}${key.slice(-4)}`, undefined, "authentication_error");
    if (request.method !== "GET") return prError(405, "This key can only read.");
    const expansions = prExpansions(url);
    if (!Array.isArray(expansions)) return expansions;

    if (url.pathname === "/v1/charges") {
      for (const one of expansions) {
        if (one === "customer")
          return prError(400, "This property cannot be expanded (customer). You may want to try expanding 'data.customer' instead.", "expand");
        if (one !== "data.customer") return prError(400, `This property cannot be expanded (${one}).`, "expand");
      }
      const customer = url.searchParams.get("customer");
      const bound = (name: string): number | null => {
        const raw = url.searchParams.get(`created[${name}]`);
        return raw === null ? null : Number(raw);
      };
      const [gt, gte, lt, lte] = [bound("gt"), bound("gte"), bound("lt"), bound("lte")];
      for (const [name, value] of [["gt", gt], ["gte", gte], ["lt", lt], ["lte", lte]] as const)
        if (value !== null && !Number.isInteger(value)) return prError(400, `Invalid integer: created[${name}]`, `created[${name}]`);
      const matching = prCharges.filter(
        (charge) =>
          (customer === null || charge.customer === customer) &&
          (gt === null || charge.created > gt) &&
          (gte === null || charge.created >= gte) &&
          (lt === null || charge.created < lt) &&
          (lte === null || charge.created <= lte),
      );
      const known = new Set(["limit", "starting_after", "ending_before", "customer", "created[gt]", "created[gte]", "created[lt]", "created[lte]"]);
      const paged = prPage(url, matching, known, "charge");
      if ("status" in paged) return paged;
      return json({
        object: "list",
        data: paged.slice.map((charge) => prChargeView(charge, expansions.length > 0)),
        has_more: paged.hasMore,
        url: "/v1/charges",
      });
    }
    const oneCharge = /^\/v1\/charges\/(ch_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (oneCharge) {
      for (const one of expansions) if (one !== "customer") return prError(400, `This property cannot be expanded (${one}).`, "expand");
      const charge = prCharges.find((each) => each.id === oneCharge[1]);
      return charge ? json(prChargeView(charge, expansions.length > 0)) : prError(404, `No such charge: '${oneCharge[1]}'`, "id");
    }
    if (url.pathname === "/v1/customers") {
      if (expansions.length > 0) return prError(400, `This property cannot be expanded (${expansions[0]}).`, "expand");
      const listed = prCustomers.filter((one) => !one.deleted).sort((a, b) => b.created - a.created);
      const paged = prPage(url, listed, new Set(["limit", "starting_after", "ending_before"]), "customer");
      if ("status" in paged) return paged;
      return json({ object: "list", data: paged.slice.map(prCustomerView), has_more: paged.hasMore, url: "/v1/customers" });
    }
    const oneCustomer = /^\/v1\/customers\/(cus_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (oneCustomer) {
      const customer = prCustomers.find((each) => each.id === oneCustomer[1]);
      return customer ? json(prCustomerView(customer)) : prError(404, `No such customer: '${oneCustomer[1]}'`, "id");
    }
    return prError(404, `Unrecognized request URL (GET: ${url.pathname}).`);
  },
};

/* ── Marketlane: a marketplace whose next page must be asked for alone ── */

/*
 * A marketplace seller API after the largest online marketplaces: a Swagger 2
 * model, an access token in its own header, a marketplace ID required on
 * every call (the seller's own is listed by another endpoint), a date filter
 * required on the first page and refused beside the `NextToken` that asks for
 * every later one, the token nested in a `payload` envelope, and order totals
 * as nested decimal strings that pending and cancelled orders do not have.
 */

const ML_API = "sellingpartner.marketlane.bench.test";
const ML_DOCS = "developer.marketlane.bench.test";
const ML_TOKEN = "Mlza|IwEBIK7c2Qp9vXr4Tn8Wm3Hs6Jd1Fb5Lg0Ye";
const ML_MARKETPLACE = "MLUS01";
const ML_MARKETPLACES = [
  { id: "MLUS01", country: "US", name: "Marketlane.com", currency: "USD" },
  { id: "MLCA02", country: "CA", name: "Marketlane.ca", currency: "CAD" },
  { id: "MLMX03", country: "MX", name: "Marketlane.com.mx", currency: "MXN" },
  { id: "MLUK04", country: "GB", name: "Marketlane.co.uk", currency: "GBP" },
] as const;
const ML_FILTERS = [
  "CreatedAfter", "CreatedBefore", "LastUpdatedAfter", "LastUpdatedBefore", "OrderStatuses", "FulfillmentChannels", "MaxResultsPerPage",
] as const;

interface MlOrder {
  readonly id: string;
  readonly purchased: number;
  readonly updated: number;
  readonly status: "Pending" | "Unshipped" | "Shipped" | "Canceled";
  readonly channel: "AFN" | "MFN";
  readonly totalCents: number;
  readonly items: number;
  readonly prime: boolean;
  readonly business: boolean;
}

const mlOrders: readonly MlOrder[] = (() => {
  const next = random(13033);
  const count = 1260;
  const start = Date.UTC(2025, 2, 1);
  const span = BENCH_NOW - DAY - start;
  return Array.from({ length: count }, (_, index): MlOrder => {
    const purchased = start + Math.floor((index * span) / count) + Math.floor(next() * 6 * HOUR);
    const recent = BENCH_NOW - purchased < 4 * DAY;
    const status = recent
      ? pick(next, ["Pending", "Unshipped", "Unshipped", "Shipped"] as const)
      : pick(next, [
          "Shipped", "Shipped", "Shipped", "Shipped", "Shipped", "Shipped", "Shipped", "Shipped", "Shipped", "Shipped",
          "Shipped", "Shipped", "Shipped", "Shipped", "Shipped", "Shipped", "Shipped", "Canceled", "Canceled", "Unshipped",
        ] as const);
    const digits = (n: number): string => String(Math.floor(next() * 10 ** n)).padStart(n, "0");
    return {
      id: `${pick(next, ["111", "112", "113", "114"] as const)}-${digits(7)}-${digits(7)}`,
      purchased,
      updated: Math.min(BENCH_NOW - HOUR, purchased + Math.floor(next() * 6 * DAY)),
      status,
      channel: pick(next, ["AFN", "MFN", "MFN"] as const),
      totalCents: cents(next, 8, 260),
      items: 1 + Math.floor(next() * 3),
      prime: next() < 0.35,
      business: next() < 0.08,
    };
  });
})();

const mlOrderView = (order: MlOrder): Record<string, unknown> => ({
  MarketlaneOrderId: order.id,
  PurchaseDate: stamp(order.purchased),
  LastUpdateDate: stamp(order.updated),
  OrderStatus: order.status,
  FulfillmentChannel: order.channel,
  SalesChannel: "Marketlane.com",
  ShipServiceLevel: order.prime ? "Expedited" : "Std US D2D Dom",
  ...(order.status === "Pending" || order.status === "Canceled"
    ? {}
    : { OrderTotal: { CurrencyCode: "USD", Amount: decimal(order.totalCents) } }),
  NumberOfItemsShipped: order.status === "Shipped" ? order.items : 0,
  NumberOfItemsUnshipped: order.status === "Shipped" || order.status === "Canceled" ? 0 : order.items,
  PaymentMethod: "Other",
  PaymentMethodDetails: ["Standard"],
  MarketplaceId: ML_MARKETPLACE,
  ShipmentServiceLevelCategory: order.prime ? "Expedited" : "Standard",
  OrderType: "StandardOrder",
  EarliestShipDate: stamp(order.purchased + DAY),
  LatestShipDate: stamp(order.purchased + 3 * DAY),
  IsBusinessOrder: order.business,
  IsPrime: order.prime,
  IsPremiumOrder: false,
  IsGlobalExpressEnabled: false,
  IsReplacementOrder: false,
  IsSoldByAB: false,
});

const mlError = (status: number, code: string, message: string, details = ""): BenchResponse =>
  json({ errors: [{ code, message, details }] }, status, { "x-marketlane-ratelimit-limit": "0.0167" });

const mlDateParam = { type: "string", format: "date-time" };

const marketlaneSpec = {
  swagger: "2.0",
  info: {
    title: "Marketlane Selling Partner API for Orders",
    version: "v0",
    description:
      "The Marketlane Selling Partner API for Orders returns your orders.\n\n" +
      "**Authorization.** Send the access token from Seller Central (Apps and Services → Develop Apps → your app → Access token) in the x-marketlane-access-token header.\n\n" +
      "**Marketplace IDs.** US: MLUS01 · Canada: MLCA02 · Mexico: MLMX03 · United Kingdom: MLUK04. " +
      "GET /sellers/v1/marketplaceParticipations lists the marketplaces your account sells in.\n\n" +
      "**Usage plan.** getOrders: rate 0.0167 requests per second, burst 20. The x-marketlane-ratelimit-limit response header gives the rate that applied.",
    contact: { name: "Selling Partner API Developer Support", url: `https://${ML_DOCS}/support` },
  },
  host: ML_API,
  schemes: ["https"],
  consumes: ["application/json"],
  produces: ["application/json"],
  securityDefinitions: { accessToken: { type: "apiKey", in: "header", name: "x-marketlane-access-token" } },
  security: [{ accessToken: [] }],
  paths: {
    "/orders/v0/orders": {
      get: {
        tags: ["ordersV0"],
        operationId: "getOrders",
        description: "Returns orders created or updated during the time frame indicated by the specified parameters. Orders are returned oldest first.",
        parameters: [
          {
            name: "CreatedAfter",
            in: "query",
            ...mlDateParam,
            description:
              "A date used for selecting orders created after (or at) a specified time. Only orders placed after the specified time are returned. Either the CreatedAfter parameter or the LastUpdatedAfter parameter is required. Both cannot be empty. The date must be in ISO 8601 format.",
          },
          { name: "CreatedBefore", in: "query", ...mlDateParam, description: "Orders placed before (or at) this time. Must be at least two minutes before the time of the request." },
          { name: "LastUpdatedAfter", in: "query", ...mlDateParam, description: "Orders last updated after (or at) this time. Either this or CreatedAfter is required." },
          { name: "LastUpdatedBefore", in: "query", ...mlDateParam },
          {
            name: "OrderStatuses",
            in: "query",
            type: "array",
            items: { type: "string", enum: ["Pending", "Unshipped", "Shipped", "Canceled"] },
            collectionFormat: "csv",
            description: "A list of OrderStatus values used to filter the results.",
          },
          {
            name: "MarketplaceIds",
            in: "query",
            required: true,
            type: "array",
            items: { type: "string" },
            maxItems: 50,
            collectionFormat: "csv",
            description: "A list of MarketplaceId values. Used to select orders that were placed in the specified marketplaces.",
          },
          {
            name: "FulfillmentChannels",
            in: "query",
            type: "array",
            items: { type: "string", enum: ["AFN", "MFN"] },
            collectionFormat: "csv",
            description: "AFN: fulfilled by Marketlane. MFN: fulfilled by the seller.",
          },
          { name: "MaxResultsPerPage", in: "query", type: "integer", description: "A number that indicates the maximum number of orders that can be returned per page. Value must be 1 - 100. Default 100." },
          { name: "NextToken", in: "query", type: "string", description: "A string token returned in the response of your previous request." },
        ],
        responses: {
          "200": {
            description: "Success.",
            schema: { $ref: "#/definitions/GetOrdersResponse" },
            headers: { "x-marketlane-ratelimit-limit": { type: "string", description: "Your rate limit (requests per second) for this operation." } },
          },
          "400": { description: "Request has missing or invalid parameters and cannot be parsed.", schema: { $ref: "#/definitions/GetOrdersResponse" } },
          "403": { description: "Indicates that access to the resource is forbidden.", schema: { $ref: "#/definitions/GetOrdersResponse" } },
          "429": { description: "The frequency of requests was greater than allowed.", schema: { $ref: "#/definitions/GetOrdersResponse" } },
        },
      },
    },
    "/orders/v0/orders/{orderId}": {
      get: {
        tags: ["ordersV0"],
        operationId: "getOrder",
        description: "Returns the order that you specify.",
        parameters: [{ name: "orderId", in: "path", required: true, type: "string", description: "A Marketlane-defined order identifier, in 3-7-7 format." }],
        responses: { "200": { description: "Success.", schema: { $ref: "#/definitions/GetOrderResponse" } } },
      },
    },
    "/sellers/v1/marketplaceParticipations": {
      get: {
        tags: ["sellers"],
        operationId: "getMarketplaceParticipations",
        description: "Returns a list of marketplaces that the seller submitting the request can sell in.",
        responses: { "200": { description: "Success.", schema: { type: "object" } } },
      },
    },
  },
  definitions: {
    GetOrdersResponse: {
      type: "object",
      properties: { payload: { $ref: "#/definitions/OrdersList" }, errors: { $ref: "#/definitions/ErrorList" } },
    },
    GetOrderResponse: { type: "object", properties: { payload: { $ref: "#/definitions/Order" }, errors: { $ref: "#/definitions/ErrorList" } } },
    OrdersList: {
      type: "object",
      required: ["Orders"],
      properties: {
        Orders: { type: "array", items: { $ref: "#/definitions/Order" } },
        NextToken: { type: "string", description: "When present and not empty, pass this string token in the next request to return the next response page." },
        LastUpdatedBefore: { type: "string" },
        CreatedBefore: { type: "string" },
      },
    },
    Money: {
      type: "object",
      properties: { CurrencyCode: { type: "string" }, Amount: { type: "string", description: "A decimal number, e.g. 25.99." } },
    },
    Order: {
      type: "object",
      required: ["MarketlaneOrderId", "PurchaseDate", "LastUpdateDate", "OrderStatus"],
      properties: {
        MarketlaneOrderId: { type: "string" },
        PurchaseDate: { type: "string" },
        LastUpdateDate: { type: "string" },
        OrderStatus: {
          type: "string",
          enum: ["Pending", "Unshipped", "Shipped", "Canceled"],
          description: "Pending: placed but payment not yet authorised; not ready for shipment. Unshipped: payment authorised, awaiting shipment. Shipped: all items shipped. Canceled.",
        },
        FulfillmentChannel: { type: "string", enum: ["AFN", "MFN"] },
        SalesChannel: { type: "string" },
        OrderTotal: { $ref: "#/definitions/Money", description: "The total charge for this order. Not returned for Pending or Canceled orders." },
        NumberOfItemsShipped: { type: "integer" },
        NumberOfItemsUnshipped: { type: "integer" },
        MarketplaceId: { type: "string" },
        IsPrime: { type: "boolean" },
        IsBusinessOrder: { type: "boolean" },
      },
    },
    ErrorList: {
      type: "array",
      items: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "string" } } },
    },
  },
};

interface MlQuery {
  readonly createdAfter: number | null;
  readonly createdBefore: number | null;
  readonly updatedAfter: number | null;
  readonly updatedBefore: number | null;
  readonly statuses: readonly string[] | null;
  readonly channels: readonly string[] | null;
  readonly size: number;
}

const mlSelect = (query: MlQuery): MlOrder[] =>
  mlOrders.filter(
    (order) =>
      (query.createdAfter === null || order.purchased >= query.createdAfter) &&
      (query.createdBefore === null || order.purchased <= query.createdBefore) &&
      (query.updatedAfter === null || order.updated >= query.updatedAfter) &&
      (query.updatedBefore === null || order.updated <= query.updatedBefore) &&
      (query.statuses === null || query.statuses.includes(order.status)) &&
      (query.channels === null || query.channels.includes(order.channel)),
  );

const MARKETLANE_CODE = `var API = "https://${ML_API}/orders/v0/orders";
var HEADERS = { "x-marketlane-access-token": "{{secret:access_token}}" };

async function read(ctx) {
  var rows = [];
  var query = { MarketplaceIds: "${ML_MARKETPLACE}", CreatedAfter: "2020-01-01T00:00:00Z", MaxResultsPerPage: "100" };
  for (var page = 0; page < 60; page++) {
    var response = await http.request({ method: "GET", url: API, query: query, headers: HEADERS, as: "json" });
    if (response.status !== 200) throw new Error("getOrders answered HTTP " + response.status + ": " + JSON.stringify(response.body).slice(0, 300));
    var payload = response.body.payload;
    for (var i = 0; i < payload.Orders.length; i++) {
      var order = payload.Orders[i];
      var row = {};
      for (var key in order) if (key !== "OrderTotal") row[key] = order[key];
      row.OrderTotalAmount = order.OrderTotal ? Number(order.OrderTotal.Amount) : null;
      row.OrderTotalCurrency = order.OrderTotal ? order.OrderTotal.CurrencyCode : null;
      rows.push(row);
    }
    if (!payload.NextToken) return { rows: rows, complete: true };
    /* A later page is asked for with the marketplace and the token alone. */
    query = { MarketplaceIds: "${ML_MARKETPLACE}", NextToken: payload.NextToken };
  }
  return { rows: rows, complete: false };
}
`;

export const marketlane: MockProvider = {
  id: "marketlane",
  split: "heldout",
  pattern:
    "Marketplace seller orders (Swagger 2): a required date filter on the first page that is refused beside the NextToken asking for every later page, the token nested in a payload envelope, a marketplace ID on every call, totals as nested decimal strings absent on pending and cancelled orders",
  hosts: [ML_API, ML_DOCS],
  docsUrl: `https://${ML_DOCS}/models/orders-api-model/ordersV0.json`,
  credentials: [ML_TOKEN],
  credentialLabels: ["Access token"],
  reference: {
    connection: {
      id: "marketlane",
      title: "Marketlane",
      kind: "rest",
      baseUrl: `https://${ML_API}/orders/v0`,
      auth: { type: "connector", credentials: [{ name: "access_token", keyRef: "marketlane-token", label: "Access token" }] },
      ops: [{ id: "orders", title: "getOrders", path: "/orders", servedBy: "connector", maxPages: 50 }],
      connector: {
        code: MARKETLANE_CODE,
        hash: connectorHash(MARKETLANE_CODE),
        hooks: ["read"],
        serves: ["orders"],
        authority: { destinations: [{ host: ML_API, methods: ["GET"], credentials: ["access_token"] }] },
        summary: "Reads every order since 2020 in the US marketplace, asking for each later page with the marketplace and NextToken alone, and flattens each order's total.",
        author: { by: "person", at: "2026-09-29T00:00:00.000Z" },
      },
    },
    secrets: { "marketlane-token": ML_TOKEN },
  },
  objectives: [
    {
      id: "shipped-sales",
      request: "What's the total value of all our shipped orders?",
      answer: major(mlOrders.filter((order) => order.status === "Shipped").reduce((sum, order) => sum + order.totalCents, 0)),
      tolerance: 0.005,
      records: mlOrders.length,
      scripted: { path: "/orders", measure: { agg: "sum", field: "OrderTotalAmount", where: 'OrderStatus == "Shipped"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === ML_DOCS) {
      if (url.pathname === "/models/orders-api-model/ordersV0.json") return json(marketlaneSpec);
      return notFound();
    }
    if (request.headers["x-marketlane-access-token"] !== ML_TOKEN)
      return mlError(403, "Unauthorized", "Access to requested resource is denied.", "The access token you provided is revoked, malformed or invalid.");
    if (request.method !== "GET") return mlError(405, "MethodNotAllowed", "This operation accepts GET only.");
    const headers = { "x-marketlane-ratelimit-limit": "0.0167" };

    if (url.pathname === "/sellers/v1/marketplaceParticipations")
      return json(
        {
          payload: [
            {
              marketplace: { id: ML_MARKETPLACE, countryCode: "US", name: "Marketlane.com", defaultCurrencyCode: "USD", defaultLanguageCode: "en_US", domainName: "www.marketlane.bench.test" },
              participation: { isParticipating: true, hasSuspendedListings: false },
            },
          ],
        },
        200,
        { "x-marketlane-ratelimit-limit": "0.016" },
      );
    const one = /^\/orders\/v0\/orders\/(\d{3}-\d{7}-\d{7})$/.exec(url.pathname);
    if (one) {
      const order = mlOrders.find((each) => each.id === one[1]);
      return order ? json({ payload: mlOrderView(order) }, 200, headers) : mlError(404, "NotFound", "Requested order not found.");
    }
    if (url.pathname !== "/orders/v0/orders") return mlError(404, "NotFound", "Resource not found.");

    const marketplaces = (url.searchParams.get("MarketplaceIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (marketplaces.length === 0) return mlError(400, "InvalidInput", "Missing required 'MarketplaceIds' parameter.");
    for (const id of marketplaces) {
      if (!ML_MARKETPLACES.some((each) => each.id === id)) return mlError(400, "InvalidInput", `Invalid MarketplaceId: ${id}.`);
      if (id !== ML_MARKETPLACE) return mlError(400, "InvalidInput", `The seller is not registered in marketplace ${id}.`);
    }

    const token = url.searchParams.get("NextToken");
    let query: MlQuery;
    let offset = 0;
    if (token !== null) {
      const alongside = ML_FILTERS.filter((name) => url.searchParams.has(name));
      if (alongside.length > 0)
        return mlError(400, "InvalidInput", `NextToken cannot be combined with other filter parameters: ${alongside.join(", ")}. Send MarketplaceIds and NextToken only.`);
      try {
        const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as { o: number; q: MlQuery };
        if (typeof decoded.o !== "number" || typeof decoded.q !== "object") throw new Error("bad token");
        query = decoded.q;
        offset = decoded.o;
      } catch {
        return mlError(400, "InvalidInput", "Invalid NextToken.");
      }
    } else {
      const date = (name: string): number | null | undefined => {
        const raw = url.searchParams.get(name);
        if (raw === null) return null;
        const ms = Date.parse(raw);
        return Number.isNaN(ms) ? undefined : ms;
      };
      const values: Record<string, number | null> = {};
      for (const name of ["CreatedAfter", "CreatedBefore", "LastUpdatedAfter", "LastUpdatedBefore"]) {
        const value = date(name);
        if (value === undefined) return mlError(400, "InvalidInput", `${name} is not a valid ISO 8601 date.`);
        values[name] = value;
      }
      if ((values.CreatedAfter === null) === (values.LastUpdatedAfter === null))
        return mlError(400, "InvalidInput", "Exactly one of CreatedAfter and LastUpdatedAfter must be specified.");
      for (const name of ["CreatedAfter", "CreatedBefore", "LastUpdatedAfter", "LastUpdatedBefore"])
        if (values[name] !== null && values[name]! > BENCH_NOW - 2 * 60_000)
          return mlError(400, "InvalidInput", `${name} must be no later than two minutes before the time of the request.`);
      const list = (name: string, allowed: readonly string[]): readonly string[] | null | string => {
        const raw = url.searchParams.get(name);
        if (raw === null) return null;
        const items = raw.split(",").map((one) => one.trim()).filter(Boolean);
        const bad = items.find((one) => !allowed.includes(one));
        return bad ?? items;
      };
      const statuses = list("OrderStatuses", ["Pending", "Unshipped", "Shipped", "Canceled"]);
      if (typeof statuses === "string") return mlError(400, "InvalidInput", `Invalid OrderStatuses value: ${statuses}.`);
      const channels = list("FulfillmentChannels", ["AFN", "MFN"]);
      if (typeof channels === "string") return mlError(400, "InvalidInput", `Invalid FulfillmentChannels value: ${channels}.`);
      const size = intParam(request, "MaxResultsPerPage", 100);
      if (!Number.isInteger(size) || size < 1 || size > 100) return mlError(400, "InvalidInput", "MaxResultsPerPage must be between 1 and 100.");
      query = {
        createdAfter: values.CreatedAfter ?? null,
        createdBefore: values.CreatedBefore ?? null,
        updatedAfter: values.LastUpdatedAfter ?? null,
        updatedBefore: values.LastUpdatedBefore ?? null,
        statuses,
        channels,
        size,
      };
    }
    const matching = mlSelect(query);
    const slice = matching.slice(offset, offset + query.size);
    const end = offset + slice.length;
    return json(
      {
        payload: {
          Orders: slice.map(mlOrderView),
          ...(end < matching.length ? { NextToken: Buffer.from(JSON.stringify({ o: end, q: query })).toString("base64") } : {}),
          CreatedBefore: stamp(BENCH_NOW - 2 * 60_000),
        },
      },
      200,
      headers,
    );
  },
};

/* ── Keyholder: work orders whose costs are only on each full record ──── */

/*
 * A property-maintenance API after the work-order modules of property
 * management suites: a Rails-style `Token token=` header, a list that
 * returns summaries only, and the costs, vendor and completion date on the
 * full work order — one at a time, or fifty at a time from a batch endpoint.
 * Money is a decimal string inside a costs object. Documented in an HTML
 * reference, with no specification.
 */

const KH_API = "api.keyholder.bench.test";
const KH_DOCS = "developers.keyholder.bench.test";
const KH_KEY = "khk_4d9T2mQx8Lw3Rz6Vb1Pn";
const KH_BATCH = 50;

const khProperties = [
  { id: 71, name: "Aspen Ridge Apartments", units: 48 },
  { id: 72, name: "Brookside Commons", units: 32 },
  { id: 74, name: "Canal Street Lofts", units: 20 },
  { id: 75, name: "Dogwood Terrace", units: 16 },
  { id: 78, name: "Elm Park Duplexes", units: 10 },
  { id: 79, name: "Foundry Row", units: 24 },
] as const;

const khVendors = [
  { id: 301, name: "Allbright Plumbing", trade: "plumbing" },
  { id: 302, name: "Coldline HVAC", trade: "hvac" },
  { id: 303, name: "Sparkwise Electric", trade: "electrical" },
  { id: 304, name: "Fixit Handyman Co.", trade: "general" },
  { id: 305, name: "Greenway Grounds", trade: "landscaping" },
  { id: 306, name: "Keystone Locksmiths", trade: "locks" },
] as const;

const KH_SUMMARIES = [
  "Kitchen sink leaking under cabinet", "No heat in bedroom", "Replace smoke detector batteries", "Garbage disposal jammed",
  "Front door lock sticking", "Ceiling light flickering", "Clogged bathtub drain", "AC not cooling", "Broken blind in living room",
  "Dishwasher not draining", "Hallway carpet stain", "Mow and edge common area",
] as const;

interface KhWorkOrder {
  readonly id: number;
  readonly number: string;
  readonly status: "new" | "assigned" | "scheduled" | "in_progress" | "completed" | "cancelled";
  readonly priority: "low" | "normal" | "high" | "emergency";
  readonly propertyId: number;
  readonly unit: string;
  readonly summary: string;
  readonly created: number;
  readonly scheduled: number | null;
  readonly completed: number | null;
  readonly vendor: (typeof khVendors)[number] | null;
  readonly laborCents: number;
  readonly materialsCents: number;
  readonly billedTo: "owner" | "tenant" | "reserve";
}

const khWorkOrders: readonly KhWorkOrder[] = (() => {
  const next = random(13044);
  const count = 420;
  return Array.from({ length: count }, (_, index): KhWorkOrder => {
    const created = BENCH_NOW - Math.floor(((count - index) / count) * 540 * DAY) + Math.floor(next() * 8 * HOUR);
    const age = BENCH_NOW - created;
    const status =
      age > 30 * DAY
        ? pick(next, ["completed", "completed", "completed", "completed", "completed", "completed", "completed", "cancelled"] as const)
        : pick(next, ["new", "assigned", "scheduled", "in_progress", "completed", "completed"] as const);
    const vendor = status === "new" ? null : pick(next, khVendors);
    const scheduled = status === "new" || status === "assigned" ? null : created + (1 + Math.floor(next() * 6)) * DAY;
    const completed =
      status === "completed" ? Math.min(BENCH_NOW - DAY, (scheduled ?? created) + Math.floor(next() * 4) * DAY) : null;
    const laborCents = status === "completed" ? cents(next, 45, 900) : status === "in_progress" ? cents(next, 0, 200) : 0;
    const materialsCents = status === "completed" || status === "in_progress" ? (next() < 0.3 ? 0 : cents(next, 5, 600)) : 0;
    return {
      id: 5_001 + index,
      number: `WO-${18_200 + index}`,
      status,
      priority: pick(next, ["low", "normal", "normal", "normal", "high", "emergency"] as const),
      propertyId: pick(next, khProperties).id,
      unit: `${1 + Math.floor(next() * 3)}${String(1 + Math.floor(next() * 12)).padStart(2, "0")}`,
      summary: pick(next, KH_SUMMARIES),
      created,
      scheduled,
      completed,
      vendor,
      laborCents,
      materialsCents: status === "cancelled" && next() < 0.4 ? 4_500 : materialsCents,
      billedTo: pick(next, ["owner", "owner", "owner", "tenant", "reserve"] as const),
    };
  });
})();

const khSummary = (order: KhWorkOrder): Record<string, unknown> => ({
  id: order.id,
  number: order.number,
  status: order.status,
  priority: order.priority,
  property_id: order.propertyId,
  unit: order.unit,
  summary: order.summary,
  created_at: stamp(order.created),
});

const khFull = (order: KhWorkOrder): Record<string, unknown> => ({
  ...khSummary(order),
  description: `${order.summary}. Tenant reports the issue started recently; access granted with 24 hours' notice.`,
  vendor: order.vendor ? { id: order.vendor.id, name: order.vendor.name, trade: order.vendor.trade } : null,
  scheduled_for: order.scheduled === null ? null : stamp(order.scheduled),
  completed_on: order.completed === null ? null : isoDay(order.completed),
  costs: {
    labor: decimal(order.laborCents),
    materials: decimal(order.materialsCents),
    total: decimal(order.laborCents + order.materialsCents),
  },
  billed_to: order.billedTo,
  invoice_number: order.status === "completed" ? `VI-${order.id * 3}` : null,
});

const khError = (status: number, message: string): BenchResponse => json({ error: message }, status);

const KH_LIST_SAMPLE = `{
  "work_orders": [
    { "id": 5417, "number": "WO-18616", "status": "scheduled", "priority": "normal",
      "property_id": 72, "unit": "204", "summary": "AC not cooling",
      "created_at": "2026-08-21T14:02:11Z" }
  ],
  "meta": { "page": 1, "per_page": 25, "total_pages": 17, "total_count": 420 }
}`;

const KH_FULL_SAMPLE = `{
  "work_order": {
    "id": 5417, "number": "WO-18616", "status": "completed", "priority": "normal",
    "property_id": 72, "unit": "204", "summary": "AC not cooling",
    "created_at": "2026-08-21T14:02:11Z",
    "description": "AC not cooling. Tenant reports the issue started recently; …",
    "vendor": { "id": 302, "name": "Coldline HVAC", "trade": "hvac" },
    "scheduled_for": "2026-08-23T14:02:11Z",
    "completed_on": "2026-08-24",
    "costs": { "labor": "240.00", "materials": "86.15", "total": "326.15" },
    "billed_to": "owner",
    "invoice_number": "VI-16251"
  }
}`;

const keyholderDocs = page(
  "Keyholder API Reference",
  `<header><p>Keyholder for Developers</p><h1>API Reference</h1><p>Version 1</p></header>
<nav><a href="#auth">Authentication</a> · <a href="#conventions">Conventions</a> · <a href="#work-orders">Work orders</a> · <a href="#properties">Properties</a> · <a href="#vendors">Vendors</a> · <a href="#limits">Rate limits</a></nav>
<main>
<h2 id="auth">Authentication</h2>
<p>Generate an API token under <b>Settings → Company → API access</b>. Send it with every request in the <code>Authorization</code> header, in the form</p>
<pre>Authorization: Token token="YOUR_API_TOKEN"</pre>
<p>A request without a valid token is answered <code>401</code>.</p>
<h2 id="conventions">Conventions</h2>
<p>Every request goes to <code>https://${KH_API}/v1</code>. Responses are JSON. Timestamps are ISO 8601 in UTC; dates are <code>YYYY-MM-DD</code>. Money is a decimal string in US dollars.</p>
<p>List endpoints are paged with <code>page</code> (from 1) and <code>per_page</code> (default 25, at most 100). The <code>meta</code> object gives <code>total_pages</code> and <code>total_count</code>.</p>
<h2 id="work-orders">Work orders</h2>
<table>
<tr><th>Method</th><th>Path</th><th>Returns</th></tr>
<tr><td>GET</td><td><code>/work_orders</code></td><td>Work orders, oldest first, as summaries. Filter with <code>status</code> and <code>property_id</code>.</td></tr>
<tr><td>GET</td><td><code>/work_orders/{id}</code></td><td>One work order in full.</td></tr>
<tr><td>GET</td><td><code>/work_orders/batch?ids=1,2,3</code></td><td>Up to ${KH_BATCH} work orders in full, by ID. IDs that do not exist are listed under <code>missing</code>.</td></tr>
</table>
<p>The list returns a summary of each work order. Its <strong>vendor, schedule, completion date and costs</strong> are only on the full work order.</p>
<h3>Statuses</h3>
<p><code>new</code>, <code>assigned</code> (a vendor has it), <code>scheduled</code>, <code>in_progress</code>, <code>completed</code>, <code>cancelled</code>. A cancelled work order can still carry a trip charge in its costs.</p>
<h3>List response</h3>
<pre>${esc(KH_LIST_SAMPLE)}</pre>
<h3>Full work order</h3>
<pre>${esc(KH_FULL_SAMPLE)}</pre>
<p><code>costs.total</code> is labor plus materials. <code>billed_to</code> says who pays: the <code>owner</code>, the <code>tenant</code> or the association's <code>reserve</code> fund.</p>
<h2 id="properties">Properties</h2>
<p><code>GET /properties</code> returns every property, with its <code>id</code>, <code>name</code> and number of <code>units</code>.</p>
<h2 id="vendors">Vendors</h2>
<p><code>GET /vendors</code> returns every vendor, with its <code>id</code>, <code>name</code> and <code>trade</code>.</p>
<h2 id="limits">Rate limits</h2>
<p>120 requests a minute per token. Every response carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and <code>RateLimit-Reset</code> (seconds until the window resets).</p>
</main>`,
);

const KEYHOLDER_CODE = `var API = "https://${KH_API}/v1";
var HEADERS = { authorization: 'Token token="{{secret:api_token}}"' };

async function get(path, query) {
  var response = await http.request({ method: "GET", url: API + path, query: query, headers: HEADERS, as: "json" });
  if (response.status !== 200) throw new Error(path + " answered HTTP " + response.status + ": " + JSON.stringify(response.body).slice(0, 300));
  return response.body;
}

async function read(ctx) {
  var ids = [];
  for (var page = 1; page <= 50; page++) {
    var list = await get("/work_orders", { page: String(page), per_page: "100" });
    for (var i = 0; i < list.work_orders.length; i++) ids.push(list.work_orders[i].id);
    if (page >= list.meta.total_pages) break;
  }
  var rows = [];
  for (var start = 0; start < ids.length; start += ${KH_BATCH}) {
    var batch = await get("/work_orders/batch", { ids: ids.slice(start, start + ${KH_BATCH}).join(",") });
    for (var j = 0; j < batch.work_orders.length; j++) {
      var order = batch.work_orders[j];
      rows.push({
        id: order.id,
        number: order.number,
        status: order.status,
        property_id: order.property_id,
        vendor: order.vendor ? order.vendor.name : null,
        completed_on: order.completed_on,
        labor_cost: Number(order.costs.labor),
        materials_cost: Number(order.costs.materials),
        total_cost: Number(order.costs.total),
        billed_to: order.billed_to
      });
    }
  }
  return { rows: rows, total: ids.length, complete: rows.length === ids.length };
}
`;

let khUsed = 0;

export const keyholder: MockProvider = {
  id: "keyholder",
  split: "heldout",
  pattern:
    "Property maintenance documented in an HTML reference: a Rails-style Token token= header, a list of summaries only, and costs and completion dates only on each full work order (singly or fifty at a time), as decimal strings inside a costs object",
  hosts: [KH_API, KH_DOCS],
  docsUrl: `https://${KH_DOCS}/reference`,
  credentials: [KH_KEY],
  credentialLabels: ["API token"],
  reset() {
    khUsed = 0;
  },
  reference: {
    connection: {
      id: "keyholder",
      title: "Keyholder",
      kind: "rest",
      baseUrl: `https://${KH_API}/v1`,
      auth: { type: "connector", credentials: [{ name: "api_token", keyRef: "keyholder-token", label: "API token" }] },
      ops: [{ id: "work-orders", title: "Work orders", path: "/work_orders", servedBy: "connector", maxPages: 50 }],
      connector: {
        code: KEYHOLDER_CODE,
        hash: connectorHash(KEYHOLDER_CODE),
        hooks: ["read"],
        serves: ["work-orders"],
        authority: { destinations: [{ host: KH_API, methods: ["GET"], credentials: ["api_token"] }] },
        summary: "Lists every work order, then reads them in full fifty at a time from the batch endpoint and flattens their costs.",
        author: { by: "person", at: "2026-09-29T00:00:00.000Z" },
      },
    },
    secrets: { "keyholder-token": KH_KEY },
  },
  objectives: [
    {
      id: "completed-2026-spend",
      request: "How much have we spent on work orders completed in 2026?",
      answer: major(
        khWorkOrders
          .filter((order) => order.status === "completed" && order.completed !== null && new Date(order.completed).getUTCFullYear() === 2026)
          .reduce((sum, order) => sum + order.laborCents + order.materialsCents, 0),
      ),
      tolerance: 0.005,
      records: khWorkOrders.length,
      scripted: {
        path: "/work_orders",
        measure: { agg: "sum", field: "total_cost", where: 'status == "completed" && startsWith(completed_on, "2026")' },
      },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === KH_DOCS) {
      if (url.pathname === "/reference" || url.pathname === "/reference/") return keyholderDocs;
      return notFound();
    }
    const token = /^Token\s+token="?([^"]*)"?$/i.exec(request.headers.authorization ?? "")?.[1];
    if (token !== KH_KEY) return { status: 401, headers: { "content-type": "text/plain; charset=utf-8", "www-authenticate": 'Token realm="Application"' }, body: "HTTP Token: Access denied.\n" };
    khUsed++;
    const limits = { "ratelimit-limit": "120", "ratelimit-remaining": String(Math.max(0, 120 - khUsed)), "ratelimit-reset": "60" };
    if (request.method !== "GET") return khError(405, "This token can only read.");
    const listed = <T>(items: readonly T[], key: string, view: (item: T) => unknown): BenchResponse => {
      const perPage = intParam(request, "per_page", 25);
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) return khError(422, "per_page must be between 1 and 100");
      const pageNumber = intParam(request, "page", 1);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) return khError(422, "page must be 1 or more");
      const start = (pageNumber - 1) * perPage;
      return json(
        {
          [key]: items.slice(start, start + perPage).map(view),
          meta: { page: pageNumber, per_page: perPage, total_pages: Math.ceil(items.length / perPage), total_count: items.length },
        },
        200,
        limits,
      );
    };

    if (url.pathname === "/v1/properties") return json({ properties: khProperties }, 200, limits);
    if (url.pathname === "/v1/vendors") return json({ vendors: khVendors }, 200, limits);
    if (url.pathname === "/v1/work_orders/batch") {
      const raw = url.searchParams.get("ids");
      if (!raw) return khError(422, "ids is required: a comma-separated list of work order IDs");
      const ids = raw.split(",").map((one) => one.trim()).filter(Boolean);
      if (ids.length > KH_BATCH) return khError(422, `ids may list at most ${KH_BATCH} work orders`);
      const found = ids.map((id) => khWorkOrders.find((order) => String(order.id) === id));
      return json(
        { work_orders: found.filter((order): order is KhWorkOrder => order !== undefined).map(khFull), missing: ids.filter((_, index) => !found[index]) },
        200,
        limits,
      );
    }
    const one = /^\/v1\/work_orders\/(\d+)$/.exec(url.pathname);
    if (one) {
      const order = khWorkOrders.find((each) => each.id === Number(one[1]));
      return order ? json({ work_order: khFull(order) }, 200, limits) : khError(404, "Work order not found");
    }
    if (url.pathname === "/v1/work_orders") {
      const status = url.searchParams.get("status");
      if (status && !["new", "assigned", "scheduled", "in_progress", "completed", "cancelled"].includes(status))
        return khError(422, "status must be one of new, assigned, scheduled, in_progress, completed, cancelled");
      const property = url.searchParams.get("property_id");
      const matching = khWorkOrders.filter(
        (order) => (!status || order.status === status) && (!property || String(order.propertyId) === property),
      );
      return listed(matching, "work_orders", khSummary);
    }
    return khError(404, "Not found");
  },
};
