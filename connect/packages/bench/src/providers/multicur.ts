import { bearerOf, cents, intParam, json, major, notFound, pick, random } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Multicur: payments in two currencies, paged by number, with a stated total.
 *
 * The pattern: adding every amount together gives a number that is a sum of
 * dollars and euros — valid arithmetic, wrong answer. The objective asks for
 * US dollars only. The response also says how many payments exist in all,
 * which is what a complete read can be checked against.
 */

const TOKEN = "mc_live_5e";
const HOST = "api.multicur.bench.test";
const PER_PAGE = 100;

const payments = (() => {
  const next = random(5505);
  return Array.from({ length: 300 }, (_, index) => ({
    id: `pay_${index + 1}`,
    currency: pick(next, ["USD", "USD", "EUR"] as const),
    amount_cents: cents(next, 5, 900),
    received_at: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString(),
  }));
})();

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Multicur Payments", version: "1" },
  servers: [{ url: `https://${HOST}/v1` }],
  components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
  security: [{ token: [] }],
  paths: {
    "/payments": {
      get: {
        summary: "List payments",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "per_page", in: "query", schema: { type: "integer", default: 20, maximum: PER_PAGE } },
        ],
        responses: {
          "200": {
            description: "A page of payments, and how many there are in all.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    payments: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          currency: { type: "string", description: "ISO 4217 code." },
                          amount: { type: "number" },
                          received_at: { type: "string", format: "date-time" },
                        },
                      },
                    },
                    total: { type: "integer" },
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

export const multicur: MockProvider = {
  id: "multicur",
  split: "dev",
  pattern: "Two currencies in one amount column; numbered pages with a stated total",
  hosts: [HOST],
  docsUrl: `https://${HOST}/openapi.json`,
  credentials: [TOKEN],
  reference: {
    connection: {
      id: "multicur",
      title: "Multicur",
      kind: "rest",
      baseUrl: `https://${HOST}/v1`,
      auth: { type: "bearer", keyRef: "multicur-key" },
      ops: [
        {
          id: "payments",
          title: "List payments",
          path: "/payments",
          rowsPath: "$.payments",
          pagination: { kind: "page", param: "page", startsAt: 1, limitParam: "per_page", pageSize: 100 },
          maxPages: 10,
        },
      ],
    },
    secrets: { "multicur-key": TOKEN },
  },
  objectives: [
    {
      id: "usd-received",
      request: "How much have we received in US dollars?",
      answer: major(
        payments.filter((one) => one.currency === "USD").reduce((sum, one) => sum + one.amount_cents, 0),
      ),
      tolerance: 0.005,
      records: payments.length,
      scripted: {
        path: "/payments",
        measure: { agg: "sum", field: "amount", where: 'currency == "USD"' },
      },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(SPEC);
    if (bearerOf(request) !== TOKEN) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/v1/payments") {
      const page = Math.max(1, intParam(request, "page", 1));
      const per = Math.min(PER_PAGE, Math.max(1, intParam(request, "per_page", 20)));
      const slice = payments.slice((page - 1) * per, page * per).map((one) => ({
        id: one.id,
        currency: one.currency,
        amount: major(one.amount_cents),
        received_at: one.received_at,
      }));
      return json({ payments: slice, total: payments.length });
    }
    return notFound();
  },
};
