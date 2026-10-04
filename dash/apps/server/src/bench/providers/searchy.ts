import { bearerOf, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Searchy: a POST search paged by offset in the body.
 *
 * Orders are read only through a POST search, with the offset and the limit
 * in the request body and the total stated in the answer.
 */

const bodyOf = (request: BenchRequest): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(request.body ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const S_HOST = "api.searchy.bench.test";
const S_KEY = "sy_key_4";

const orders = (() => {
  const next = random(8101);
  return Array.from({ length: 140 }, (_, index) => ({
    id: `ord_${index + 1}`,
    status: pick(next, ["pending", "shipped", "shipped", "cancelled"] as const),
  }));
})();

export const searchy: MockProvider = {
  id: "searchy",
  split: "dev",
  pattern: "Records only through a POST search; offset and limit in the request body; a stated total",
  hosts: [S_HOST],
  docsUrl: `https://${S_HOST}/openapi.json`,
  credentials: [S_KEY],
  reference: {
    connection: {
      id: "searchy",
      title: "Searchy",
      kind: "rest",
      baseUrl: `https://${S_HOST}/v1`,
      auth: { type: "bearer", keyRef: "searchy-key" },
      ops: [
        {
          id: "orders",
          title: "Search orders",
          method: "POST",
          path: "/orders/search",
          rowsPath: "$.orders",
          body: { type: "json", template: {} },
          readSafety: { basis: "docs-inferred" },
          pagination: { kind: "offset", param: "offset", limitParam: "limit", pageSize: 30, in: "body" },
          maxPages: 10,
        },
      ],
    },
    secrets: { "searchy-key": S_KEY },
  },
  objectives: [
    {
      id: "shipped-count",
      request: "How many orders have shipped?",
      answer: orders.filter((one) => one.status === "shipped").length,
      tolerance: 0,
      records: orders.length,
      scripted: { path: "/orders/search", measure: { agg: "count", where: 'status == "shipped"' } },
    },
  ],
  handle(request) {
    const { url } = request;
    if (url.pathname === "/openapi.json")
      return json({
        openapi: "3.0.3",
        info: { title: "Searchy", version: "1" },
        servers: [{ url: `https://${S_HOST}/v1` }],
        components: { securitySchemes: { key: { type: "http", scheme: "bearer" } } },
        security: [{ key: [] }],
        paths: {
          "/orders/search": {
            post: {
              operationId: "searchOrders",
              summary: "Search orders",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        status: { type: "string" },
                        offset: { type: "integer", default: 0 },
                        limit: { type: "integer", maximum: 30 },
                      },
                    },
                  },
                },
              },
              responses: {
                "200": {
                  description: "Orders",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          orders: { type: "array", items: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } } },
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
      });
    if (bearerOf(request) !== S_KEY) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/v1/orders/search" && request.method === "POST") {
      const body = bodyOf(request);
      const offset = Math.max(0, Number(body.offset ?? 0) || 0);
      const limit = Math.min(30, Math.max(1, Number(body.limit ?? 10) || 10));
      const matching = typeof body.status === "string" ? orders.filter((one) => one.status === body.status) : orders;
      return json({ orders: matching.slice(offset, offset + limit), total: matching.length });
    }
    return notFound();
  },
};
