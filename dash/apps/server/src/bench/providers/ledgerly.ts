import { BENCH_NOW, bearerOf, cents, html, intParam, isoWithin, json, major, notFound, pick, random } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Ledgerly: a well-behaved accounting API that pages by offset.
 *
 * The pattern: its specification declares `offset` and `limit`, which the
 * importer reads as a pagination *proposal* and never installs. So a
 * connection made from it reads one page of 25 out of 1,234 invoices until
 * something confirms how it pages. A dashboard total over it is short, and
 * the question is whether it says so.
 */

const TOKEN = "ldg_live_7d1f";
const HOST = "api.ledgerly.bench.test";

const invoices = (() => {
  const next = random(1101);
  return Array.from({ length: 1234 }, (_, index) => ({
    id: `inv_${String(index + 1).padStart(5, "0")}`,
    number: `L-${10_000 + index}`,
    status: pick(next, ["open", "open", "paid", "paid", "paid", "void"] as const),
    amount_cents: cents(next, 40, 4200),
    issued_at: isoWithin(next, BENCH_NOW, 365),
  }));
})();

const asRecord = (invoice: (typeof invoices)[number]) => ({
  id: invoice.id,
  number: invoice.number,
  status: invoice.status,
  amount: major(invoice.amount_cents),
  issued_at: invoice.issued_at,
});

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Ledgerly API", version: "1" },
  servers: [{ url: `https://${HOST}/v1` }],
  components: {
    securitySchemes: { token: { type: "http", scheme: "bearer" } },
    schemas: {
      Invoice: {
        type: "object",
        properties: {
          id: { type: "string" },
          number: { type: "string" },
          status: { type: "string", enum: ["open", "paid", "void"] },
          amount: { type: "number", description: "The invoice total, in dollars." },
          issued_at: { type: "string", format: "date-time" },
        },
      },
    },
  },
  security: [{ token: [] }],
  paths: {
    "/invoices": {
      get: {
        operationId: "listInvoices",
        summary: "List invoices",
        parameters: [
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 25, maximum: 100 } },
        ],
        responses: {
          "200": {
            description: "A page of invoices.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Invoice" } },
                    has_more: { type: "boolean" },
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

export const ledgerly: MockProvider = {
  id: "ledgerly",
  split: "dev",
  pattern: "OpenAPI 3 with offset paging declared only as parameters; bearer token",
  hosts: [HOST, "docs.ledgerly.bench.test"],
  docsUrl: "https://docs.ledgerly.bench.test/api",
  credentials: [TOKEN],
  reference: {
    connection: {
      id: "ledgerly",
      title: "Ledgerly",
      kind: "rest",
      baseUrl: `https://${HOST}/v1`,
      auth: { type: "bearer", keyRef: "ledgerly-key" },
      ops: [
        {
          id: "invoices",
          title: "List invoices",
          path: "/invoices",
          rowsPath: "$.data",
          pagination: { kind: "offset", param: "offset", limitParam: "limit", pageSize: 100 },
          maxPages: 50,
        },
      ],
    },
    secrets: { "ledgerly-key": TOKEN },
  },
  objectives: [
    {
      id: "invoice-count",
      request: "How many invoices have we issued?",
      answer: invoices.length,
      tolerance: 0,
      records: invoices.length,
      scripted: { path: "/invoices", measure: { agg: "count" } },
    },
    {
      id: "open-total",
      request: "What is the total of our open invoices?",
      answer: major(
        invoices.filter((one) => one.status === "open").reduce((sum, one) => sum + one.amount_cents, 0),
      ),
      tolerance: 0.005,
      records: invoices.length,
      scripted: {
        path: "/invoices",
        measure: { agg: "sum", field: "amount", where: 'status == "open"' },
      },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.hostname === "docs.ledgerly.bench.test") {
      if (url.pathname !== "/api") return notFound();
      return html(
        `<html><body><h1>Ledgerly API</h1><p>Our REST API is described by an <a href="https://${HOST}/openapi.json">OpenAPI document</a>.</p></body></html>`,
      );
    }
    if (url.pathname === "/openapi.json") return json(SPEC);
    if (bearerOf(request) !== TOKEN) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/v1/invoices") {
      const offset = Math.max(0, intParam(request, "offset", 0));
      const limit = Math.min(100, Math.max(1, intParam(request, "limit", 25)));
      const page = invoices.slice(offset, offset + limit).map(asRecord);
      return json({ data: page, has_more: offset + limit < invoices.length });
    }
    return notFound();
  },
};
