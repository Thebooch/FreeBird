import { connectorHash } from "@freebirdai/connect/connector/adapter";
import { BENCH_NOW, intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Stampede: a new request id and the current time on every request.
 *
 * A connection cannot describe this API in data, so the loop has to write
 * connector code for it. Its pattern is deliberately unlike the held-out
 * one in `heldout.ts`: no signed requests, no export to wait for, no
 * spreadsheet download.
 *
 * The scripted connector code below is what CI answers the `connector` task
 * with. It tests the mechanics — sandbox, authority, credentials, the loop —
 * and never anybody's judgment; a live run writes its own.
 */

const ST_HOST = "api.stampede.bench.test";
const ST_KEY = "st_key_52";
const FIVE_MINUTES = 5 * 60_000;

const stOrders = (() => {
  const next = random(8402);
  return Array.from({ length: 180 }, (_, index) => ({
    id: `so_${index + 1}`,
    status: pick(next, ["paid", "paid", "refunded", "open"] as const),
    total: Math.round((5 + next() * 400) * 100) / 100,
  }));
})();

const stSeen = new Set<string>();

const stampedeSpec = {
  openapi: "3.0.3",
  info: {
    title: "Stampede",
    version: "1",
    description:
      "Every request carries your key in X-Api-Key, plus two headers of its own: X-Request-Id, a value you have never sent before, and X-Date, the current time in ISO 8601 UTC (for example 2026-09-01T12:00:00Z). A request whose X-Date is more than five minutes from our clock is refused, and so is a request id we have already seen.",
  },
  servers: [{ url: `https://${ST_HOST}/v1` }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
  security: [{ key: [] }],
  paths: {
    "/orders": {
      get: {
        summary: "List orders",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "per_page", in: "query", schema: { type: "integer", default: 20, maximum: 50 } },
        ],
        responses: {
          "200": {
            description: "A page of orders.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    orders: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { id: { type: "string" }, status: { type: "string" }, total: { type: "number" } },
                      },
                    },
                    page: { type: "integer" },
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

const STAMPEDE_CODE = [
  "let sent = 0;",
  "async function signRequest(request) {",
  "  sent += 1;",
  '  request.headers["x-api-key"] = "{{secret:api_key}}";',
  '  request.headers["x-request-id"] = clock.now().toString(36) + "-" + sent + "-" + Math.floor(Math.random() * 1e12).toString(36);',
  '  request.headers["x-date"] = new Date().toISOString();',
  "  return request;",
  "}",
].join("\n");

export const stampede: MockProvider = {
  id: "stampede",
  split: "dev",
  pattern: "Every request needs a request id never sent before and the current time, beside a key; numbered pages",
  hosts: [ST_HOST],
  docsUrl: `https://${ST_HOST}/openapi.json`,
  credentials: [ST_KEY],
  credentialLabels: ["API key"],
  scriptedModel: {
    propose_repair: {
      reason: "Each request needs a new X-Request-Id and the current time in X-Date.",
      cannot: "Every request needs a request id never sent before and the current time; a fixed header cannot provide either.",
    },
    propose_connector: {
      summary: "Adds the key, a new request id and the current time to every request, as the documentation requires.",
      credentials: [{ name: "api_key", label: "API key" }],
      destinations: [{ host: ST_HOST, role: "api", methods: ["GET"], credentials: ["api_key"] }],
      serves: false,
      code: STAMPEDE_CODE,
    },
  },
  reset() {
    stSeen.clear();
  },
  reference: {
    connection: {
      id: "stampede",
      title: "Stampede",
      kind: "rest",
      baseUrl: `https://${ST_HOST}/v1`,
      auth: { type: "connector", credentials: [{ name: "api_key", keyRef: "stampede-key", label: "API key" }] },
      ops: [
        {
          id: "orders",
          title: "List orders",
          path: "/orders",
          rowsPath: "$.orders",
          pagination: { kind: "page", param: "page", startsAt: 1, limitParam: "per_page", pageSize: 50 },
          maxPages: 10,
        },
      ],
      connector: {
        code: STAMPEDE_CODE,
        hash: connectorHash(STAMPEDE_CODE),
        hooks: ["signRequest"],
        authority: { destinations: [{ host: ST_HOST, methods: ["GET"], credentials: ["api_key"] }] },
        author: { by: "person", at: "2026-09-28T00:00:00.000Z" },
      },
    },
    secrets: { "stampede-key": ST_KEY },
  },
  objectives: [
    {
      id: "paid-total",
      request: "How much have paid orders brought in?",
      answer: Math.round(stOrders.filter((one) => one.status === "paid").reduce((sum, one) => sum + one.total, 0) * 100) / 100,
      tolerance: 0.005,
      records: stOrders.length,
      scripted: { path: "/orders", measure: { agg: "sum", field: "total", where: 'status == "paid"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(stampedeSpec);
    if (request.headers["x-api-key"] !== ST_KEY) return json({ error: "a valid X-Api-Key is required" }, 401);
    const id = request.headers["x-request-id"];
    if (!id) return json({ error: "X-Request-Id is required: a value never sent before" }, 400);
    const date = Date.parse(request.headers["x-date"] ?? "");
    if (!Number.isFinite(date) || Math.abs(date - BENCH_NOW) > FIVE_MINUTES)
      return json({ error: "X-Date is required: the current time, ISO 8601 UTC" }, 400);
    if (stSeen.has(id)) return json({ error: "X-Request-Id was already used" }, 409);
    stSeen.add(id);
    if (url.pathname !== "/v1/orders" || request.method !== "GET") return notFound();
    const per = Math.min(50, Math.max(1, intParam(request, "per_page", 20)));
    const page = Math.max(1, intParam(request, "page", 1));
    return json({ orders: stOrders.slice((page - 1) * per, page * per), page, pages: Math.ceil(stOrders.length / per) });
  },
};
