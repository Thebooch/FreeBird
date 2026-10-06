import { json, notFound, pick, random } from "../seed.js";
import type { MockProvider } from "../types.js";

/**
 * Filterly: a required deepObject filter, with its default.
 *
 * The ticket list needs a filter written as a deepObject parameter. Its
 * documented default must be sent, and the API answers only with that year's
 * tickets.
 */

const F_HOST = "api.filterly.bench.test";
const F_KEY = "fl_key_8";

const tickets = (() => {
  const next = random(8303);
  return Array.from({ length: 200 }, (_, index) => ({
    id: index + 1,
    year: pick(next, [2025, 2026, 2026] as const),
    closed: next() < 0.5,
  }));
})();

export const filterly: MockProvider = {
  id: "filterly",
  split: "dev",
  pattern: "A required deepObject filter whose default is documented; answers only with that year's tickets",
  hosts: [F_HOST],
  docsUrl: `https://${F_HOST}/openapi.json`,
  credentials: [F_KEY],
  reference: {
    connection: {
      id: "filterly",
      title: "Filterly",
      kind: "rest",
      baseUrl: `https://${F_HOST}`,
      auth: { type: "header", header: "X-Key", keyRef: "filterly-key" },
      ops: [{ id: "tickets", title: "List tickets", path: "/tickets", query: { "filter[year]": 2026 }, rowsPath: "$.tickets" }],
    },
    secrets: { "filterly-key": F_KEY },
  },
  objectives: [
    {
      id: "closed-2026",
      request: "How many tickets did we close this year?",
      answer: tickets.filter((one) => one.year === 2026 && one.closed).length,
      tolerance: 0,
      records: tickets.filter((one) => one.year === 2026).length,
      scripted: { path: "/tickets", measure: { agg: "count", where: "closed == true" } },
    },
  ],
  handle(request) {
    const { url } = request;
    if (url.pathname === "/openapi.json")
      return json({
        openapi: "3.0.3",
        info: { title: "Filterly", version: "1" },
        servers: [{ url: `https://${F_HOST}` }],
        components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" } } },
        security: [{ key: [] }],
        paths: {
          "/tickets": {
            get: {
              summary: "List tickets",
              parameters: [
                {
                  name: "filter",
                  in: "query",
                  required: true,
                  style: "deepObject",
                  explode: true,
                  schema: { type: "object", properties: { year: { type: "integer", default: 2026 } } },
                },
              ],
              responses: {
                "200": {
                  description: "Tickets",
                  content: { "application/json": { schema: { type: "object", properties: { tickets: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, year: { type: "integer" }, closed: { type: "boolean" } } } } } } } },
                },
              },
            },
          },
        },
      });
    if (request.headers["x-key"] !== F_KEY) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/tickets") {
      const year = url.searchParams.get("filter[year]");
      if (!year) return json({ error: "filter[year] is required" }, 400);
      return json({ tickets: tickets.filter((one) => String(one.year) === year) });
    }
    return notFound();
  },
};
