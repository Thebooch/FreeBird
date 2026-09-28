import { connectorHash } from "../../connector/adapter.js";
import { BENCH_NOW, intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Dev-set providers for plan step 4: APIs a connection cannot describe in
 * data, so the loop has to write connector code for them.
 *
 * Tuned against freely. Their patterns are deliberately **not** the held-out
 * one's (see `heldout.ts`): no signed requests, no export to wait for, no
 * spreadsheet download — a login for a session token, records one JSON object
 * per line, and headers that must be new on every request.
 *
 * The scripted connector code below is what CI answers the `connector` task
 * with. It tests the mechanics — sandbox, authority, credentials, the loop —
 * and never anybody's judgment; a live run writes its own.
 */

const bodyOf = (request: BenchRequest): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(request.body ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/* ── Sessionly: log in for a session; records one per line; keyset pages ─ */

const SL_HOST = "api.sessionly.bench.test";
const SL_EMAIL = "ops@acme.example";
const SL_PASSWORD = "sl_pw_91";
/** A session answers this many requests, then must be renewed by logging in again. */
const SL_USES = 4;

const slTickets = (() => {
  const next = random(8401);
  return Array.from({ length: 230 }, (_, index) => ({
    id: 5001 + index,
    subject: `Ticket ${index + 1}`,
    status: pick(next, ["open", "closed", "pending", "closed"] as const),
  }));
})();

const slSessions = new Map<string, number>();

const sessionlySpec = {
  openapi: "3.0.3",
  info: {
    title: "Sessionly",
    version: "2",
    description: "Log in with your account's email and password to get a session, then send it with every request.",
  },
  servers: [{ url: `https://${SL_HOST}/v2` }],
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "header",
        name: "X-Session",
        description: "A session token from POST /login. A session ends after a few minutes; log in again when one is refused.",
      },
    },
  },
  security: [{ session: [] }],
  paths: {
    "/login": {
      post: {
        summary: "Log in",
        security: [],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { email: { type: "string" }, password: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": {
            description: "A session.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { session: { type: "string" }, expires_in: { type: "integer", description: "Seconds." } } },
              },
            },
          },
        },
      },
    },
    "/tickets": {
      get: {
        summary: "List tickets",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
          { name: "after", in: "query", description: "The id of the last ticket you have; omit it for the first.", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "One ticket per line, each a JSON object with id, subject and status, in order of id. Pass the last id as after for the next ones; fewer than limit means there are no more.",
            content: { "application/x-ndjson": { schema: { type: "string" } } },
          },
        },
      },
    },
  },
};

const SESSIONLY_CODE = [
  "async function authenticate() {",
  "  await auth.exchange({",
  '    name: "session",',
  '    request: { method: "POST", url: "/login", body: { email: "{{secret:email}}", password: "{{secret:password}}" } },',
  '    token: "$.session",',
  '    expiresIn: "$.expires_in",',
  "  });",
  "}",
  "",
  "async function page(after) {",
  '  const request = { url: "/tickets", query: { limit: 100, after }, headers: { "x-session": "{{secret:session}}" }, as: "ndjson" };',
  "  let answer = await http.request(request);",
  "  if (answer.status === 401) {",
  '    await auth.forget("session");',
  "    await authenticate();",
  "    answer = await http.request(request);",
  "  }",
  '  if (answer.status !== 200) throw new Error("tickets answered " + answer.status);',
  "  return answer.body;",
  "}",
  "",
  "async function read(ctx) {",
  "  const rows = [];",
  "  let after = null;",
  "  for (let i = 0; i < 100; i++) {",
  "    const batch = await page(after);",
  "    rows.push(...batch);",
  "    if (batch.length < 100) return { rows };",
  "    after = batch[batch.length - 1].id;",
  "  }",
  "  return { rows, complete: false };",
  "}",
].join("\n");

const sessionlyProposal = {
  summary: "Logs in with the email and password for a session, then reads tickets 100 at a time, logging in again when a session ends.",
  credentials: [
    { name: "email", label: "Email" },
    { name: "password", label: "Password" },
  ],
  exchanges: [{ name: "session" }],
  destinations: [{ host: SL_HOST, role: "api", methods: ["GET", "POST"], credentials: ["email", "password", "session"] }],
  serves: true,
  code: SESSIONLY_CODE,
};

export const sessionly: MockProvider = {
  id: "sessionly",
  split: "dev",
  pattern: "A login for a session token that ends after a few requests; records one JSON object per line; pages by the last id",
  hosts: [SL_HOST],
  docsUrl: `https://${SL_HOST}/openapi.json`,
  credentials: [SL_EMAIL, SL_PASSWORD],
  credentialLabels: ["Email", "Password"],
  scriptedModel: { propose_connector: sessionlyProposal },
  reset() {
    slSessions.clear();
  },
  reference: {
    connection: {
      id: "sessionly",
      title: "Sessionly",
      kind: "rest",
      baseUrl: `https://${SL_HOST}/v2`,
      auth: {
        type: "connector",
        credentials: [
          { name: "email", keyRef: "sessionly-email", label: "Email" },
          { name: "password", keyRef: "sessionly-password", label: "Password" },
        ],
        tokens: [{ name: "session", keyRef: "sessionly-session" }],
      },
      ops: [
        {
          id: "tickets",
          title: "List tickets",
          path: "/tickets",
          servedBy: "connector",
          rowsPath: "$",
          readSafety: { basis: "person", note: "Logs in with POST, then reads with GET." },
        },
      ],
      connector: {
        code: SESSIONLY_CODE,
        hash: connectorHash(SESSIONLY_CODE),
        hooks: ["authenticate", "read"],
        serves: ["tickets"],
        authority: {
          destinations: [{ host: SL_HOST, methods: ["GET", "POST"], credentials: ["email", "password", "session"] }],
          exchanges: [{ name: "session", fields: [] }],
        },
        author: { by: "person", at: "2026-09-28T00:00:00.000Z" },
      },
    },
    secrets: { "sessionly-email": SL_EMAIL, "sessionly-password": SL_PASSWORD },
  },
  objectives: [
    {
      id: "open-tickets",
      request: "How many tickets are open?",
      answer: slTickets.filter((one) => one.status === "open").length,
      tolerance: 0,
      records: slTickets.length,
      scripted: { path: "/tickets", measure: { agg: "count", where: 'status == "open"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(sessionlySpec);
    if (url.pathname === "/v2/login" && request.method === "POST") {
      const body = bodyOf(request);
      if (body.email !== SL_EMAIL || body.password !== SL_PASSWORD) return json({ error: "wrong email or password" }, 401);
      const session = `sess_${slSessions.size + 1}_${(slSessions.size * 7919) % 1000}`;
      slSessions.set(session, SL_USES);
      return json({ session, expires_in: 900 });
    }
    const session = request.headers["x-session"] ?? "";
    const left = slSessions.get(session) ?? 0;
    if (left <= 0) return json({ error: "session expired or unknown; log in again" }, 401);
    slSessions.set(session, left - 1);
    if (url.pathname !== "/v2/tickets" || request.method !== "GET") return notFound();
    const limit = Math.min(100, Math.max(1, intParam(request, "limit", 50)));
    const after = intParam(request, "after", 0);
    const batch = slTickets.filter((one) => one.id > after).slice(0, limit);
    return {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body: batch.map((one) => JSON.stringify(one)).join("\n"),
    };
  },
};

/* ── Stampede: a new request id and the current time on every request ─── */

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
