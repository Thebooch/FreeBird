import { json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Postline: documented as a GET, read with a POST and a body.
 *
 * The specification documents the ticket list as a GET. The API refuses GET
 * (405) and reads with a POST and a JSON body, which only the prose says.
 *
 * Written for the kind of gap it tests, without reading any held-out provider.
 */

const PL_HOST = "api.postline.bench.test";
const PL_KEY = "pl_key_3307";

export const plTickets = (() => {
  const next = random(9103);
  return Array.from({ length: 90 }, (_, index) => ({
    id: 7001 + index,
    subject: `Ticket ${index + 1}`,
    status: pick(next, ["open", "closed", "closed", "pending"] as const),
  }));
})();

const postlineSpec = {
  openapi: "3.0.3",
  info: {
    title: "Postline",
    version: "1",
    description:
      'Every list is read with POST and a JSON body, never with GET: send {"page": 1, "per_page": 100} to POST /tickets for the first hundred tickets. per_page is at most 100; the answer says total and total_pages.',
  },
  servers: [{ url: `https://${PL_HOST}/v1` }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
  security: [{ key: [] }],
  paths: {
    "/tickets": {
      get: {
        summary: "List tickets",
        responses: {
          "200": {
            description: "A page of tickets.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, subject: { type: "string" }, status: { type: "string" } } } },
                    total: { type: "integer" },
                    total_pages: { type: "integer" },
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

export const postline: MockProvider = {
  id: "postline",
  split: "dev",
  pattern: "Documented as a GET; the API refuses GET (405) and reads with POST and a JSON body, which only the prose says",
  hosts: [PL_HOST],
  docsUrl: `https://${PL_HOST}/openapi.json`,
  credentials: [PL_KEY],
  credentialLabels: ["API key"],
  scriptedModel: {
    propose_repair: {
      reason: "The documentation reads every list with POST and a JSON body; GET is refused.",
      method: "POST",
      bodyType: "json",
      body: '{"page": 1, "per_page": 100}',
    },
  },
  reference: {
    connection: {
      id: "postline",
      title: "Postline",
      kind: "rest",
      baseUrl: `https://${PL_HOST}/v1`,
      auth: { type: "header", header: "X-Api-Key", keyRef: "postline-key" },
      ops: [
        {
          id: "tickets",
          title: "List tickets",
          method: "POST",
          path: "/tickets",
          body: { type: "json", template: { page: 1, per_page: 100 } },
          readSafety: { basis: "person", note: "The documentation reads lists with POST." },
          rowsPath: "$.data",
          totalPath: "$.total",
        },
      ],
    },
    secrets: { "postline-key": PL_KEY },
  },
  objectives: [
    {
      id: "open-tickets",
      request: "How many tickets are open?",
      answer: plTickets.filter((one) => one.status === "open").length,
      tolerance: 0,
      records: plTickets.length,
      scripted: { path: "/tickets", measure: { agg: "count", where: 'status == "open"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(postlineSpec);
    if (request.headers["x-api-key"] !== PL_KEY) return json({ error: "X-Api-Key is required" }, 401);
    if (url.pathname !== "/v1/tickets") return notFound();
    if (request.method !== "POST") return json({ error: "Method not allowed: lists are read with POST and a JSON body" }, 405);
    let asked: { page?: unknown; per_page?: unknown } = {};
    try {
      asked = JSON.parse(request.body ?? "{}") as typeof asked;
    } catch {
      return json({ error: "the body must be JSON" }, 400);
    }
    const per = Math.min(100, Math.max(1, Number(asked.per_page ?? 25) || 25));
    const page = Math.max(1, Number(asked.page ?? 1) || 1);
    return json({
      data: plTickets.slice((page - 1) * per, page * per),
      page,
      total: plTickets.length,
      total_pages: Math.ceil(plTickets.length / per),
    });
  },
};
