import { connectorHash } from "../../connector/adapter.js";
import { BENCH_NOW, cents, intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * A held-out provider written on 2026-09-29 to replace chargebolt, which moved
 * to the dev set after checkpoint 3. Written by the session that wrote
 * `heldout-2026-09-28.ts`, under the same rules (`dash/bench/HELDOUT-AUTHORING.md`):
 * without reading the integration loop, the importers or any result.
 *
 * Nothing here may be read while tuning the loop, a prompt or a repair; it
 * runs only at a checkpoint (`dash/bench/PROTOCOL.md`).
 */

/* ── Cashloom: payments whose full history is only in a change export ─── */

/*
 * A payments API after the card processors small businesses sign up with
 * online: a secret key, amounts in the smallest currency unit, a list
 * endpoint that reaches only its first thousand results (while its total
 * counts them all), and an incremental export that does reach everything —
 * as a log of changes. A payment that changed appears once per change, pages
 * overlap at their boundary, and the stream never ends: `end_of_stream` says
 * the reader has caught up, while `next_page` is always there. Reading it
 * correctly means keeping the latest version of each payment.
 */

const CL_API = "api.cashloom.bench.test";
const CL_DOCS = "docs.cashloom.bench.test";
const CL_KEY = "sk_live_51Hc9Rt2Wq7Lp0Zm4Vx8";
const CL_EXPORT_PAGE = 1000;
const CL_LIST_WINDOW = 1000;
const NOW_S = Math.floor(BENCH_NOW / 1000);

interface CashVersion {
  readonly id: string;
  readonly created: number;
  readonly updated: number;
  readonly status: "pending" | "succeeded" | "failed" | "refunded";
  readonly amount: number;
  readonly refunded: number;
  readonly customer: string | null;
  readonly description: string;
  readonly brand: string;
  readonly last4: string;
}

const cashVersions: readonly CashVersion[] = (() => {
  const next = random(12099);
  const count = 1840;
  const first = NOW_S - 420 * 86_400;
  const log: CashVersion[] = [];
  for (let index = 0; index < count; index++) {
    const created = first + Math.floor((index * 400 * 86_400) / count) + Math.floor(next() * 3600);
    const base = {
      id: `py_3P${(0x1a2b3c + index * 7919).toString(36).toUpperCase()}${index.toString(36).padStart(3, "0")}`,
      created,
      amount: cents(next, 5, 900),
      customer: next() < 0.15 ? null : `cus_${(0x5f00 + Math.floor(next() * 600)).toString(36).toUpperCase()}Qk`,
      description: pick(next, ["Online order", "Invoice payment", "Subscription renewal", "In-store pickup", "Deposit"] as const),
      brand: pick(next, ["visa", "visa", "mastercard", "mastercard", "amex", "discover"] as const),
      last4: String(1000 + Math.floor(next() * 9000)),
    };
    const changes: { status: CashVersion["status"]; refunded: number; updated: number }[] = [];
    let at = created;
    if (next() < 0.3) {
      changes.push({ status: "pending", refunded: 0, updated: at });
      at += 60 + Math.floor(next() * 3 * 86_400);
    }
    if (next() < 0.08) changes.push({ status: "failed", refunded: 0, updated: at });
    else {
      changes.push({ status: "succeeded", refunded: 0, updated: at });
      if (next() < 0.16) {
        at += 3600 + Math.floor(next() * 20 * 86_400);
        const full = next() < 0.5;
        const part = Math.round(base.amount * (0.1 + next() * 0.6));
        changes.push({ status: full ? "refunded" : "succeeded", refunded: full ? base.amount : part, updated: at });
        if (!full && next() < 0.3) {
          at += 3600 + Math.floor(next() * 10 * 86_400);
          changes.push({ status: "refunded", refunded: base.amount, updated: at });
        }
      }
    }
    /* A change stamped after "now" has not happened yet. */
    for (const change of changes) if (change.updated <= NOW_S - 120) log.push({ ...base, ...change });
  }
  return log.sort((a, b) => a.updated - b.updated || a.id.localeCompare(b.id));
})();

/** Each payment as it stands now: its latest version. */
const cashPayments: readonly CashVersion[] = (() => {
  const latest = new Map<string, CashVersion>();
  for (const version of cashVersions) latest.set(version.id, version);
  return [...latest.values()].sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
})();

const cashView = (payment: CashVersion): Record<string, unknown> => ({
  id: payment.id,
  object: "payment",
  amount: payment.amount,
  amount_refunded: payment.refunded,
  currency: "usd",
  status: payment.status,
  refunded: payment.status === "refunded",
  created: payment.created,
  updated_at: payment.updated,
  customer: payment.customer,
  description: payment.description,
  payment_method_details: { type: "card", card: { brand: payment.brand, last4: payment.last4 } },
  livemode: true,
  metadata: {},
});

const cashError = (status: number, message: string, param?: string): BenchResponse =>
  json({ error: { type: status === 401 ? "authentication_error" : "invalid_request_error", message, ...(param ? { param } : {}) } }, status);

const cashPayment = {
  type: "object",
  properties: {
    id: { type: "string" },
    object: { type: "string", enum: ["payment"] },
    amount: { type: "integer", description: "The amount, in the smallest currency unit: 12500 is $125.00." },
    amount_refunded: { type: "integer", description: "How much of the amount has been refunded, in the smallest currency unit." },
    currency: { type: "string", description: "Three-letter ISO code, lowercase." },
    status: {
      type: "string",
      enum: ["pending", "succeeded", "failed", "refunded"],
      description: "refunded means refunded in full. A partly refunded payment stays succeeded, with amount_refunded above zero.",
    },
    refunded: { type: "boolean", description: "True when refunded in full." },
    created: { type: "integer", description: "Unix time, in seconds." },
    updated_at: { type: "integer", description: "Unix time of the latest change, in seconds." },
    customer: { type: "string", nullable: true },
    description: { type: "string" },
    payment_method_details: { type: "object" },
    livemode: { type: "boolean" },
    metadata: { type: "object" },
  },
};

const cashloomSpec = {
  openapi: "3.0.3",
  info: {
    title: "Cashloom API",
    version: "2026-04-01",
    description:
      "Accept and track card payments. Authenticate with your secret key, from Dashboard → Developers → API keys, " +
      "as a bearer token (or as the username of HTTP Basic authentication, with no password). " +
      "Amounts are integers in the smallest currency unit. Timestamps are Unix times in seconds.",
  },
  servers: [{ url: `https://${CL_API}/v1` }],
  components: {
    securitySchemes: {
      secretKey: { type: "http", scheme: "bearer", description: "Your secret key, beginning sk_live_." },
    },
    schemas: { Payment: cashPayment },
  },
  security: [{ secretKey: [] }],
  paths: {
    "/payments": {
      get: {
        operationId: "listPayments",
        summary: "List payments",
        description:
          `Payments, newest first, as each stands now. page and limit reach the first ${CL_LIST_WINDOW.toLocaleString("en-US")} results only; ` +
          "total_count still counts every payment that matches. For every payment, use the incremental export.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 10, minimum: 1, maximum: 100 } },
          { name: "page", in: "query", schema: { type: "integer", default: 1, minimum: 1 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "succeeded", "failed", "refunded"] } },
          { name: "created[gte]", in: "query", schema: { type: "integer" }, description: "Only payments created at or after this Unix time." },
          { name: "created[lt]", in: "query", schema: { type: "integer" }, description: "Only payments created before this Unix time." },
        ],
        responses: {
          "200": {
            description: "A page of payments",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    object: { type: "string", enum: ["list"] },
                    url: { type: "string" },
                    data: { type: "array", items: { $ref: "#/components/schemas/Payment" } },
                    page: { type: "integer" },
                    has_more: { type: "boolean" },
                    total_count: { type: "integer" },
                  },
                },
              },
            },
          },
          "400": { description: "A parameter is invalid, or the page lies beyond the first 1,000 results." },
        },
      },
    },
    "/payments/{id}": {
      get: {
        operationId: "retrievePayment",
        summary: "Retrieve a payment",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The payment", content: { "application/json": { schema: { $ref: "#/components/schemas/Payment" } } } } },
      },
    },
    "/incremental/payments": {
      get: {
        operationId: "exportPayments",
        summary: "Incremental payment export",
        description:
          `Every change to your payments since start_time, oldest first, ${CL_EXPORT_PAGE.toLocaleString("en-US")} changes a page. ` +
          "Each change is a full copy of the payment as it was after that change, so a payment that changed appears once for each change: " +
          "keep the latest version of each id. " +
          "A page's end_time is the updated_at of its last item; follow next_page (or pass end_time as start_time) for the next page. " +
          "Pages overlap: items stamped exactly end_time appear again at the top of the next page. " +
          "The export does not end. end_of_stream is true once you have caught up, and next_page is then where to resume later.",
        parameters: [
          {
            name: "start_time",
            in: "query",
            required: true,
            schema: { type: "integer" },
            description: "A Unix time in seconds, at least one minute in the past. 0 exports everything.",
          },
        ],
        responses: {
          "200": {
            description: "A page of changes",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    payments: { type: "array", items: { $ref: "#/components/schemas/Payment" } },
                    count: { type: "integer" },
                    end_time: { type: "integer" },
                    next_page: { type: "string" },
                    end_of_stream: { type: "boolean" },
                  },
                },
              },
            },
          },
          "400": { description: "start_time is missing, not a Unix time, or less than a minute ago." },
        },
      },
    },
  },
};

const CASHLOOM_CODE = `var API = "https://${CL_API}/v1";

async function read(ctx) {
  var latest = {};
  var order = [];
  var url = API + "/incremental/payments?start_time=0";
  for (var page = 0; page < 40; page++) {
    var response = await http.request({ method: "GET", url: url, headers: { authorization: "Bearer {{secret:secret_key}}" }, as: "json" });
    if (response.status !== 200) throw new Error("export answered HTTP " + response.status + ": " + JSON.stringify(response.body).slice(0, 300));
    var body = response.body;
    for (var i = 0; i < body.payments.length; i++) {
      var payment = body.payments[i];
      var seen = latest[payment.id];
      if (!seen) order.push(payment.id);
      if (!seen || payment.updated_at >= seen.updated_at) latest[payment.id] = payment;
    }
    if (body.end_of_stream) {
      var rows = [];
      for (var j = 0; j < order.length; j++) rows.push(latest[order[j]]);
      return { rows: rows, complete: true };
    }
    url = body.next_page;
  }
  return { rows: [], complete: false };
}
`;

export const cashloom: MockProvider = {
  id: "cashloom",
  split: "heldout",
  pattern:
    "Payments in minor units whose list reaches only its first 1,000 results; everything is in an incremental export that is a change log — versions to reduce to the latest, overlapping pages, a stream that never ends",
  hosts: [CL_API, CL_DOCS],
  docsUrl: `https://${CL_DOCS}/openapi/v1.json`,
  credentials: [CL_KEY],
  credentialLabels: ["Secret key"],
  reference: {
    connection: {
      id: "cashloom",
      title: "Cashloom",
      kind: "rest",
      baseUrl: `https://${CL_API}/v1`,
      auth: { type: "connector", credentials: [{ name: "secret_key", keyRef: "cashloom-key", label: "Secret key" }] },
      ops: [{ id: "payments", title: "Payments (incremental export)", path: "/incremental/payments", servedBy: "connector", maxPages: 50 }],
      connector: {
        code: CASHLOOM_CODE,
        hash: connectorHash(CASHLOOM_CODE),
        hooks: ["read"],
        serves: ["payments"],
        authority: { destinations: [{ host: CL_API, methods: ["GET"], credentials: ["secret_key"] }] },
        summary: "Reads the incremental export from the beginning until it has caught up, keeping the latest version of each payment.",
        author: { by: "person", at: "2026-09-29T00:00:00.000Z" },
      },
    },
    secrets: { "cashloom-key": CL_KEY },
  },
  objectives: [
    {
      id: "refunded-over-250",
      request: "How many payments of more than $250 have been refunded, in full or in part?",
      answer: cashPayments.filter((payment) => payment.amount > 25_000 && payment.refunded > 0).length,
      tolerance: 0,
      records: cashPayments.length,
      scripted: { path: "/incremental/payments", measure: { agg: "count", where: "amount > 25000 && amount_refunded > 0" } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === CL_DOCS) {
      if (url.pathname === "/openapi/v1.json") return json(cashloomSpec);
      return notFound();
    }
    const authorization = request.headers.authorization ?? "";
    const basic = /^basic /i.test(authorization)
      ? Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8").split(":")[0]
      : undefined;
    const key = /^bearer /i.test(authorization) ? authorization.slice(7).trim() : basic;
    if (!key) return cashError(401, "You did not provide an API key. Send it as a bearer token: Authorization: Bearer sk_live_…");
    if (key !== CL_KEY) return cashError(401, `Invalid API Key provided: ${key.slice(0, 8)}${"*".repeat(Math.max(0, key.length - 12))}${key.slice(-4)}`);
    if (request.method !== "GET") return cashError(405, "This key can only read.");

    if (url.pathname === "/v1/incremental/payments") {
      const raw = url.searchParams.get("start_time");
      if (raw === null) return cashError(400, "Missing required param: start_time.", "start_time");
      if (!/^\d+$/.test(raw)) return cashError(400, "start_time must be a Unix time in seconds.", "start_time");
      const start = Number(raw);
      if (start > NOW_S - 60) return cashError(400, "start_time must be at least one minute in the past.", "start_time");
      const page = cashVersions.filter((version) => version.updated >= start).slice(0, CL_EXPORT_PAGE);
      const end = page.length > 0 ? page[page.length - 1]!.updated : start;
      return json({
        payments: page.map(cashView),
        count: page.length,
        end_time: end,
        next_page: `https://${CL_API}/v1/incremental/payments?start_time=${end}`,
        end_of_stream: page.length < CL_EXPORT_PAGE,
      });
    }

    const one = /^\/v1\/payments\/(py_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (one) {
      const payment = cashPayments.find((each) => each.id === one[1]);
      return payment ? json(cashView(payment)) : cashError(404, `No such payment: '${one[1]}'`, "id");
    }
    if (url.pathname !== "/v1/payments") return cashError(404, `Unrecognized request URL (GET: ${url.pathname}).`);

    const limit = intParam(request, "limit", 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return cashError(400, "limit must be an integer from 1 to 100.", "limit");
    const pageNumber = intParam(request, "page", 1);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return cashError(400, "page must be a positive integer.", "page");
    const status = url.searchParams.get("status");
    if (status && !["pending", "succeeded", "failed", "refunded"].includes(status))
      return cashError(400, "status must be one of pending, succeeded, failed or refunded.", "status");
    const since = url.searchParams.get("created[gte]");
    const before = url.searchParams.get("created[lt]");
    for (const [name, value] of [["created[gte]", since], ["created[lt]", before]] as const)
      if (value !== null && !/^\d+$/.test(value)) return cashError(400, `${name} must be a Unix time in seconds.`, name);
    const matching = cashPayments.filter(
      (payment) =>
        (!status || payment.status === status) &&
        (since === null || payment.created >= Number(since)) &&
        (before === null || payment.created < Number(before)),
    );
    if (pageNumber * limit > CL_LIST_WINDOW)
      return cashError(
        400,
        `Result window is too large: page × limit must be at most ${CL_LIST_WINDOW}. To read every payment, use the incremental export.`,
        "page",
      );
    const start = (pageNumber - 1) * limit;
    return json({
      object: "list",
      url: "/v1/payments",
      data: matching.slice(start, start + limit).map(cashView),
      page: pageNumber,
      has_more: start + limit < matching.length,
      total_count: matching.length,
    });
  },
};
