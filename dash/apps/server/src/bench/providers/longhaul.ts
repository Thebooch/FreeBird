import { intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Longhaul: 1,200 payments at ten a page, no total, no export, no count — a
 * read that needs 120 pages, past the most a tile reads at once. Only a read
 * carried on past the ceiling, from where it stopped, reaches the answer.
 *
 * Written for the kind of gap it tests, without reading any held-out provider.
 */

const LH_HOST = "api.longhaul.bench.test";
const LH_KEY = "lh_key_4418";
const PER_PAGE = 10;

export const lhPayments = (() => {
  const next = random(9201);
  return Array.from({ length: 1_200 }, (_, index) => ({
    id: `lp_${index + 1}`,
    amount: Math.round((1 + next() * 250) * 100) / 100,
    status: pick(next, ["settled", "settled", "pending", "failed"] as const),
  }));
})();

const longhaulSpec = {
  openapi: "3.0.3",
  info: { title: "Longhaul", version: "1", description: "Payments, ten to a page, newest last. There is no count and no export." },
  servers: [{ url: `https://${LH_HOST}/v1` }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
  security: [{ key: [] }],
  paths: {
    "/payments": {
      get: {
        summary: "List payments",
        parameters: [{ name: "page", in: "query", description: "Which page, from 1.", schema: { type: "integer", default: 1 } }],
        responses: {
          "200": {
            description: "Ten payments; an empty page after the last.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    payments: {
                      type: "array",
                      items: { type: "object", properties: { id: { type: "string" }, amount: { type: "number" }, status: { type: "string" } } },
                    },
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

export const longhaul: MockProvider = {
  id: "longhaul",
  split: "dev",
  pattern: "1,200 records at ten a page, with no total, export or count: past the most pages a tile reads at once",
  hosts: [LH_HOST],
  docsUrl: `https://${LH_HOST}/openapi.json`,
  credentials: [LH_KEY],
  credentialLabels: ["API key"],
  reference: {
    connection: {
      id: "longhaul",
      title: "Longhaul",
      kind: "rest",
      baseUrl: `https://${LH_HOST}/v1`,
      auth: { type: "header", header: "X-Api-Key", keyRef: "longhaul-key" },
      ops: [
        {
          id: "payments",
          title: "List payments",
          path: "/payments",
          rowsPath: "$.payments",
          pagination: { kind: "page", param: "page", startsAt: 1 },
          paginationChecked: true,
          maxPages: 50,
        },
      ],
    },
    secrets: { "longhaul-key": LH_KEY },
  },
  objectives: [
    {
      id: "settled-total",
      request: "How much have settled payments added up to?",
      answer: Math.round(lhPayments.filter((one) => one.status === "settled").reduce((sum, one) => sum + one.amount, 0) * 100) / 100,
      tolerance: 0.005,
      records: lhPayments.length,
      scripted: { path: "/payments", measure: { agg: "sum", field: "amount", where: 'status == "settled"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(longhaulSpec);
    if (request.headers["x-api-key"] !== LH_KEY) return json({ error: "X-Api-Key is required" }, 401);
    if (url.pathname !== "/v1/payments") return notFound();
    const page = Math.max(1, intParam(request, "page", 1));
    return json({ payments: lhPayments.slice((page - 1) * PER_PAGE, page * PER_PAGE) });
  },
};
