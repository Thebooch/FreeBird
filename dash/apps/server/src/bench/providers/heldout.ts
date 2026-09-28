import { createHmac } from "node:crypto";
import { connectorHash } from "../../connector/adapter.js";
import { cents, intParam, json, major, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * The held-out providers.
 *
 * Written before any integration agent exists, and run only at checkpoints —
 * see `dash/bench/PROTOCOL.md`. Nothing here may be read while tuning a
 * prompt or a repair strategy; a failure here is recorded, not debugged,
 * until the checkpoint is written up.
 */

/* ── Stockroom: link-header pages, Basic with an email and a token ─────── */

const STOCK_USER = "ops@acme.example";
const STOCK_TOKEN = "sr_tok_61";
const STOCK_HOST = "api.stockroom.bench.test";

const items = (() => {
  const next = random(9101);
  return Array.from({ length: 260 }, (_, index) => ({
    sku: `SKU-${7000 + index}`,
    name: `Item ${index + 1}`,
    on_hand: Math.floor(next() * 40),
  }));
})();

const stockroomSpec = {
  swagger: "2.0",
  info: { title: "Stockroom", version: "3" },
  host: STOCK_HOST,
  basePath: "/v3",
  schemes: ["https"],
  securityDefinitions: { login: { type: "basic", description: "Your email as the username and an API token as the password." } },
  security: [{ login: [] }],
  paths: {
    "/items": {
      get: {
        summary: "List items",
        description: "Paged. Follow the Link header's rel=\"next\" address for the next page.",
        parameters: [{ name: "per_page", in: "query", type: "integer", default: 30 }],
        responses: {
          "200": {
            description: "Items",
            schema: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sku: { type: "string" },
                  name: { type: "string" },
                  on_hand: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
  },
};

export const stockroom: MockProvider = {
  id: "stockroom",
  split: "heldout",
  pattern: "Swagger 2; Link-header pages; Basic with an email and an API token",
  hosts: [STOCK_HOST],
  docsUrl: `https://${STOCK_HOST}/swagger.json`,
  credentials: [STOCK_USER, STOCK_TOKEN],
  reference: {
    connection: {
      id: "stockroom",
      title: "Stockroom",
      kind: "rest",
      baseUrl: `https://${STOCK_HOST}/v3`,
      auth: { type: "basic", usernameRef: "stockroom-user", keyRef: "stockroom-key" },
      ops: [
        {
          id: "items",
          title: "List items",
          path: "/items",
          query: { per_page: 100 },
          pagination: { kind: "link-header" },
          maxPages: 10,
        },
      ],
    },
    secrets: { "stockroom-user": STOCK_USER, "stockroom-key": STOCK_TOKEN },
  },
  objectives: [
    {
      id: "low-stock",
      request: "How many items are running low — fewer than 5 left?",
      answer: items.filter((one) => one.on_hand < 5).length,
      tolerance: 0,
      records: items.length,
      scripted: { path: "/items", measure: { agg: "count", where: "on_hand < 5" } },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.pathname === "/swagger.json") return json(stockroomSpec);
    const expected = `Basic ${Buffer.from(`${STOCK_USER}:${STOCK_TOKEN}`).toString("base64")}`;
    if (request.headers.authorization !== expected) return json({ message: "Bad credentials" }, 401);
    if (url.pathname !== "/v3/items") return notFound();
    const per = Math.min(100, Math.max(1, intParam(request, "per_page", 30)));
    const page = Math.max(1, intParam(request, "page", 1));
    const slice = items.slice((page - 1) * per, page * per);
    const last = Math.ceil(items.length / per);
    const link =
      page < last
        ? `<https://${STOCK_HOST}/v3/items?per_page=${per}&page=${page + 1}>; rel="next", <https://${STOCK_HOST}/v3/items?per_page=${per}&page=${last}>; rel="last"`
        : "";
    return json(slice, 200, link ? { link } : {});
  },
};

/* ── Helpline: key in the query, numbered pages, unix timestamps ───────── */

const HELP_KEY = "hl_9f9f";
const HELP_HOST = "api.helpline.bench.test";
const AUG_START = Date.UTC(2026, 7, 1) / 1000;
const SEP_START = Date.UTC(2026, 8, 1) / 1000;

const tickets = (() => {
  const next = random(9202);
  return Array.from({ length: 415 }, (_, index) => ({
    id: 90_000 + index,
    subject: `Ticket ${index + 1}`,
    priority: pick(next, ["low", "normal", "high", "urgent"] as const),
    created_at: Math.floor(Date.UTC(2026, 4, 1) / 1000 + next() * 150 * 86_400),
  }));
})();

const helplineSpec = {
  openapi: "3.0.1",
  info: { title: "Helpline", version: "2" },
  servers: [{ url: `https://${HELP_HOST}/api` }],
  components: { securitySchemes: { key: { type: "apiKey", in: "query", name: "api_key" } } },
  security: [{ key: [] }],
  paths: {
    "/tickets": {
      get: {
        summary: "Search tickets",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
        ],
        responses: {
          "200": {
            description: "Tickets. `created_at` is seconds since 1970.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "integer" },
                          subject: { type: "string" },
                          priority: { type: "string" },
                          created_at: { type: "integer", description: "Unix time." },
                        },
                      },
                    },
                    total: { type: "integer" },
                    pages: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export const helpline: MockProvider = {
  id: "helpline",
  split: "heldout",
  pattern: "API key in the query string; numbered pages with totals; unix timestamps",
  hosts: [HELP_HOST],
  docsUrl: `https://${HELP_HOST}/openapi.json`,
  credentials: [HELP_KEY],
  reference: {
    connection: {
      id: "helpline",
      title: "Helpline",
      kind: "rest",
      baseUrl: `https://${HELP_HOST}/api`,
      auth: { type: "query", param: "api_key", keyRef: "helpline-key" },
      ops: [
        {
          id: "tickets",
          title: "Search tickets",
          path: "/tickets",
          rowsPath: "$.results",
          pagination: { kind: "page", param: "page", startsAt: 1, limitParam: "limit", pageSize: 100 },
          maxPages: 10,
        },
      ],
    },
    secrets: { "helpline-key": HELP_KEY },
  },
  objectives: [
    {
      id: "august-urgent",
      request: "How many urgent tickets came in during August 2026?",
      answer: tickets.filter(
        (one) => one.priority === "urgent" && one.created_at >= AUG_START && one.created_at < SEP_START,
      ).length,
      tolerance: 0,
      records: tickets.length,
      scripted: {
        path: "/tickets",
        measure: {
          agg: "count",
          where: `priority == "urgent" && created_at >= ${AUG_START} && created_at < ${SEP_START}`,
        },
      },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(helplineSpec);
    if (url.searchParams.get("api_key") !== HELP_KEY) return json({ error: "invalid api_key" }, 401);
    if (url.pathname !== "/api/tickets") return notFound();
    const limit = Math.min(100, Math.max(1, intParam(request, "limit", 50)));
    const page = Math.max(1, intParam(request, "page", 1));
    return json({
      results: tickets.slice((page - 1) * limit, page * limit),
      total: tickets.length,
      pages: Math.ceil(tickets.length / limit),
    });
  },
};

/* ── Vaultbank: signed requests, and data only through an export ───────── */

const VB_KEY_ID = "vb_kid_3";
const VB_SECRET = "vb_sec_q8";
const VB_HOST = "api.vaultbank.bench.test";

const transactions = (() => {
  const next = random(9303);
  return Array.from({ length: 640 }, (_, index) => ({
    id: `tx${index + 1}`,
    booked: new Date(Date.UTC(2026, 5, 1) + Math.floor(next() * 120) * 86_400_000).toISOString().slice(0, 10),
    direction: pick(next, ["debit", "credit", "debit"] as const),
    amount_cents: cents(next, 1, 2500),
  }));
})();

const signature = (method: string, path: string, timestamp: string): string =>
  createHmac("sha256", VB_SECRET).update(`${method}\n${path}\n${timestamp}`).digest("hex");

const vaultbankSpec = {
  openapi: "3.1.0",
  info: {
    title: "Vaultbank Business",
    version: "1",
    description:
      "Every request is signed: send X-Key-Id, X-Timestamp (unix seconds) and X-Signature, the hex HMAC-SHA256 of METHOD\\nPATH\\nTIMESTAMP using your secret. Transactions are read by creating an export, polling it until it is ready, then downloading the CSV at its url.",
  },
  servers: [{ url: `https://${VB_HOST}` }],
  components: {
    securitySchemes: { signed: { type: "http", scheme: "hmac-sha256", description: "See the overview." } },
  },
  security: [{ signed: [] }],
  paths: {
    "/exports": {
      post: {
        summary: "Start a transactions export",
        responses: { "202": { description: "Started", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } },
      },
    },
    "/exports/{id}": {
      get: {
        summary: "Check an export",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Its status, and where to download it when ready.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string" }, url: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/exports/{id}/file": {
      get: {
        summary: "Download an export",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The transactions", content: { "text/csv": { schema: { type: "string" } } } } },
      },
    },
  },
};

/* Polled twice before it is ready, as a real export would be. */
const exportPolls = new Map<string, number>();

/*
 * The reference connector, written by hand once connectors existed (plan step
 * 4) and only to prove this provider's answer key. Never shown to an
 * integrator, and never a scripted answer: a scripted run of the held-out
 * split has no connector code to give, so it stops where a model would have to
 * write one.
 */
const VAULTBANK_REFERENCE_CODE = String.raw`async function signRequest(request) {
  const path = request.url.replace(/^https:\/\/[^/]+/, "").split("?")[0];
  const timestamp = String(Math.floor(clock.now() / 1000));
  request.headers["x-key-id"] = "{{secret:key_id}}";
  request.headers["x-timestamp"] = timestamp;
  request.headers["x-signature"] = await crypto.hmac({ key: "secret", data: request.method + "\n" + path + "\n" + timestamp });
  return request;
}

async function read(ctx) {
  const started = await http.request({ method: "POST", url: "/exports" });
  if (started.status !== 202 && started.status !== 200) throw new Error("the export answered " + started.status);
  for (let i = 0; i < 30; i++) {
    const state = await http.request({ url: "/exports/" + encodeURIComponent(started.body.id) });
    if (state.body && state.body.status === "ready") return { rows: (await http.request({ url: state.body.url, as: "csv" })).body };
    await sleep(1000);
  }
  return { rows: [], complete: false };
}`;

/*
 * Moved to the dev set at the end of plan step 4, once its failure there was
 * written up (`bench/results/checkpoint-step-4.md`): from then on it is tuned
 * against, and `harborline` is the held-out replacement.
 */
export const vaultbank: MockProvider = {
  id: "vaultbank",
  split: "dev",
  pattern: "HMAC-signed requests; data only through an async export that downloads as CSV",
  hosts: [VB_HOST],
  docsUrl: `https://${VB_HOST}/openapi.json`,
  credentials: [VB_KEY_ID, VB_SECRET],
  credentialLabels: ["Key ID", "Secret"],
  /* A dev scenario now: its scripted connector code is the reference's, for CI's mechanics. */
  scriptedModel: {
    propose_connector: {
      summary: "Signs every request with the secret, starts an export, waits for it, and reads the CSV it produces.",
      credentials: [
        { name: "key_id", label: "Key ID" },
        { name: "secret", label: "Secret" },
      ],
      destinations: [{ host: VB_HOST, role: "api", methods: ["GET", "POST"], credentials: ["key_id", "secret"] }],
      serves: true,
      code: VAULTBANK_REFERENCE_CODE,
    },
  },
  reset() {
    exportPolls.clear();
  },
  reference: {
    connection: {
      id: "vaultbank",
      title: "Vaultbank Business",
      kind: "rest",
      baseUrl: `https://${VB_HOST}`,
      auth: {
        type: "connector",
        credentials: [
          { name: "key_id", keyRef: "vaultbank-key-id", label: "Key ID" },
          { name: "secret", keyRef: "vaultbank-secret", label: "Secret" },
        ],
      },
      ops: [
        {
          id: "transactions",
          title: "Download an export",
          path: "/exports/{{param.id}}/file",
          servedBy: "connector",
          rowsPath: "$",
          readSafety: { basis: "person", note: "Starts an export with POST, then reads it." },
        },
      ],
      connector: {
        code: VAULTBANK_REFERENCE_CODE,
        hash: connectorHash(VAULTBANK_REFERENCE_CODE),
        hooks: ["signRequest", "read"],
        serves: ["transactions"],
        authority: { destinations: [{ host: VB_HOST, methods: ["GET", "POST"], credentials: ["key_id", "secret"] }] },
        author: { by: "person", at: "2026-09-28T00:00:00.000Z" },
      },
    },
    secrets: { "vaultbank-key-id": VB_KEY_ID, "vaultbank-secret": VB_SECRET },
  },
  objectives: [
    {
      id: "july-debits",
      request: "How much went out of the account in July 2026?",
      answer: major(
        transactions
          .filter((one) => one.direction === "debit" && one.booked.startsWith("2026-07"))
          .reduce((sum, one) => sum + one.amount_cents, 0),
      ),
      tolerance: 0.005,
      records: transactions.length,
      scripted: {
        path: "/exports/{{param.id}}/file",
        measure: { agg: "sum", field: "amount", where: 'direction == "debit" && booked >= "2026-07-01" && booked < "2026-08-01"' },
      },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(vaultbankSpec);
    const timestamp = request.headers["x-timestamp"] ?? "";
    if (
      request.headers["x-key-id"] !== VB_KEY_ID ||
      request.headers["x-signature"] !== signature(request.method, url.pathname, timestamp)
    )
      return json({ error: "signature does not match" }, 401);
    if (request.method === "POST" && url.pathname === "/exports") {
      const id = `exp_${exportPolls.size + 1}`;
      exportPolls.set(id, 0);
      return json({ id }, 202);
    }
    const poll = /^\/exports\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && poll) {
      const seen = exportPolls.get(poll[1]!);
      if (seen === undefined) return notFound();
      exportPolls.set(poll[1]!, seen + 1);
      return seen < 2
        ? json({ status: "running" })
        : json({ status: "ready", url: `https://${VB_HOST}/exports/${poll[1]}/file` });
    }
    const file = /^\/exports\/([^/]+)\/file$/.exec(url.pathname);
    if (request.method === "GET" && file && (exportPolls.get(file[1]!) ?? 0) >= 2) {
      const rows = transactions.map(
        (one) => `${one.id},${one.booked},${one.direction},${(one.amount_cents / 100).toFixed(2)}`,
      );
      return {
        status: 200,
        headers: { "content-type": "text/csv" },
        body: ["id,booked,direction,amount", ...rows].join("\n"),
      };
    }
    return notFound();
  },
};
