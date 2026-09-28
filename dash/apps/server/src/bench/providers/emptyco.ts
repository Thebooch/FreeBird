import { bearerOf, json, notFound } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Emptyco: a working account with nothing in it yet.
 *
 * The pattern: an empty answer is a correct answer. Zero customers is a
 * number to show, not a failure to read — and not a reason to leave the
 * widget off.
 */

const TOKEN = "ec_0000";
const HOST = "api.emptyco.bench.test";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Emptyco CRM", version: "1" },
  servers: [{ url: `https://${HOST}` }],
  components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
  security: [{ token: [] }],
  paths: {
    "/customers": {
      get: {
        summary: "List customers",
        responses: {
          "200": {
            description: "Customers.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    customers: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { id: { type: "string" }, name: { type: "string" } },
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
  },
};

export const emptyco: MockProvider = {
  id: "emptyco",
  split: "dev",
  pattern: "An account with no records: zero is the answer",
  hosts: [HOST],
  docsUrl: `https://${HOST}/openapi.json`,
  credentials: [TOKEN],
  reference: {
    connection: {
      id: "emptyco",
      title: "Emptyco",
      kind: "rest",
      baseUrl: `https://${HOST}`,
      auth: { type: "bearer", keyRef: "emptyco-key" },
      ops: [{ id: "customers", title: "List customers", path: "/customers", rowsPath: "$.customers" }],
    },
    secrets: { "emptyco-key": TOKEN },
  },
  objectives: [
    {
      id: "customer-count",
      request: "How many customers do we have?",
      answer: 0,
      tolerance: 0,
      records: 0,
      scripted: { path: "/customers", measure: { agg: "count" } },
    },
  ],
  handle(request: BenchRequest) {
    if (request.url.pathname === "/openapi.json") return json(SPEC);
    if (bearerOf(request) !== TOKEN) return json({ error: "unauthorized" }, 401);
    if (request.url.pathname === "/customers") return json({ customers: [] });
    return notFound();
  },
};
