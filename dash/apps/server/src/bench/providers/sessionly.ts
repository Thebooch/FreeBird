import { connectorHash } from "@freebirdai/connect/connector/adapter";
import { intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Sessionly: log in for a session; records one per line; keyset pages.
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

const bodyOf = (request: BenchRequest): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(request.body ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

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
          {
            name: "status",
            in: "query",
            description: "Only tickets with this status.",
            schema: { type: "string", enum: ["open", "pending", "closed"] },
          },
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
  "async function page(after, status) {",
  '  const query = status ? { limit: 100, after, status } : { limit: 100, after };',
  '  const request = { url: "/tickets", query, headers: { "x-session": "{{secret:session}}" }, as: "ndjson" };',
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
  "    const batch = await page(after, ctx.inputs.status);",
  "    rows.push(...batch);",
  '    if (batch.length < 100) return { rows, done: "all", pages: i + 1 };',
  "    after = batch[batch.length - 1].id;",
  "  }",
  '  return { rows, done: "partial", reason: "more than 100 pages" };',
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
  requests: [
    { id: "login", purpose: "exchange", method: "POST", host: SL_HOST, path: "/v2/login", credentials: ["email", "password"] },
    { id: "tickets", purpose: "read", method: "GET", host: SL_HOST, path: "/v2/tickets", credentials: ["session"] },
  ],
  serves: true,
  code: SESSIONLY_CODE,
};

export const sessionly: MockProvider = {
  id: "sessionly",
  split: "dev",
  pattern:
    "A login for a session token that ends after a few requests; records one JSON object per line; pages by the last id; a status filter connector code must pass on",
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
    const status = url.searchParams.get("status");
    const batch = slTickets.filter((one) => one.id > after && (!status || one.status === status)).slice(0, limit);
    return {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body: batch.map((one) => JSON.stringify(one)).join("\n"),
    };
  },
};
