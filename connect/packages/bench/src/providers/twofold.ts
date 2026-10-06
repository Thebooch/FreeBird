import { connectorHash } from "@freebirdai/connect/host";
import { json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Twofold: one sign-in, and two endpoints that each need code of their own —
 * invoices only through an export (start it, wait for it, download a CSV
 * from a file host), payments only one account at a time. Code for the
 * second must be written beside the first's, never over it.
 *
 * The scripted connector code below is what CI answers the `connector` task
 * with: one connector for both endpoints, since a scripted model gives the
 * same answer every time it is asked. Code for each endpoint written apart
 * is exercised by `integrate/modules.test.ts`, and by a live run.
 *
 * Written for the kind of gap it tests, without reading any held-out provider.
 */

const TF_HOST = "api.twofold.bench.test";
const TF_FILES = "files.twofold.bench.test";
const TF_KEY = "tf_key_8812";

export const tfInvoices = (() => {
  const next = random(9101);
  return Array.from({ length: 140 }, (_, index) => ({
    id: `inv_${index + 1}`,
    number: `T-${1000 + index}`,
    status: pick(next, ["paid", "open", "paid", "void"] as const),
    total: Math.round((20 + next() * 900) * 100) / 100,
  }));
})();

export const tfAccounts = ["acc_1", "acc_2", "acc_3", "acc_4"].map((id, index) => ({ id, name: `Account ${index + 1}` }));

export const tfPayments = (() => {
  const next = random(9102);
  return Array.from({ length: 210 }, (_, index) => ({
    id: `pay_${index + 1}`,
    account_id: tfAccounts[index % tfAccounts.length]!.id,
    amount: Math.round((5 + next() * 300) * 100) / 100,
    method: pick(next, ["card", "transfer", "card"] as const),
  }));
})();

const sessions = new Set<string>();
const exports = new Map<string, number>();

const twofoldSpec = {
  openapi: "3.0.3",
  info: {
    title: "Twofold",
    version: "1",
    description:
      "Exchange your API key for a session with POST /session, then send it on every request as Authorization: Session <token>. Invoices are only available as an export. Payments are listed one account at a time.",
  },
  servers: [{ url: `https://${TF_HOST}/v1` }],
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "header",
        name: "Authorization",
        description: "Session <token>, where the token comes from POST /session with your API key.",
      },
    },
  },
  security: [{ session: [] }],
  paths: {
    "/session": {
      post: {
        summary: "Start a session",
        security: [],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { api_key: { type: "string" } } } } } },
        responses: {
          "200": {
            description: "A session token, good for an hour.",
            content: {
              "application/json": { schema: { type: "object", properties: { token: { type: "string" }, expires_in: { type: "integer" } } } },
            },
          },
        },
      },
    },
    "/invoices": {
      get: {
        summary: "List invoices",
        description:
          "Not answered directly: every invoice is in an export. Start one with POST /invoices/exports, ask GET /invoices/exports/{id} until its status is ready, then download the CSV at its file_url (columns id, number, status, total).",
        responses: {
          "200": {
            description: "Invoices.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" }, number: { type: "string" }, status: { type: "string" }, total: { type: "number" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/invoices/exports": {
      post: {
        summary: "Start an invoice export",
        responses: { "202": { description: "The export, pending.", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } } } } } },
      },
    },
    "/invoices/exports/{id}": {
      get: {
        summary: "An export's status",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "pending, or ready with file_url: a CSV on our file host, good for ten minutes.",
            content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, file_url: { type: "string" } } } } },
          },
        },
      },
    },
    "/accounts": {
      get: {
        summary: "List accounts",
        responses: {
          "200": {
            description: "Every account.",
            content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } } } },
          },
        },
      },
    },
    "/payments": {
      get: {
        summary: "List payments",
        description: "Payments of one account: account_id is needed, and there is no way to ask for every account at once. List the accounts first.",
        parameters: [{ name: "account_id", in: "query", schema: { type: "string" } }],
        responses: {
          "200": {
            description: "One account's payments.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: { type: "object", properties: { id: { type: "string" }, account_id: { type: "string" }, amount: { type: "number" }, method: { type: "string" } } },
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

/** One connector for both endpoints: the sign-in shared, each endpoint read its own way. */
export const TWOFOLD_CODE = [
  "async function authenticate() {",
  "  await auth.exchange({",
  '    name: "session",',
  '    request: { method: "POST", url: "/session", body: { api_key: "{{secret:api_key}}" } },',
  '    token: "$.token",',
  '    expiresIn: "$.expires_in",',
  "  });",
  "}",
  "",
  'const signed = { authorization: "Session {{secret:session}}" };',
  "",
  "async function invoices() {",
  '  const started = await http.request({ method: "POST", url: "/invoices/exports", headers: signed, body: {} });',
  "  for (let poll = 0; poll < 10; poll++) {",
  '    const state = await http.request({ url: "/invoices/exports/" + started.body.id, headers: signed });',
  '    if (state.body.status === "ready") {',
  '      const file = await http.request({ url: state.body.file_url, as: "csv" });',
  '      return { rows: file.body, done: "all" };',
  "    }",
  "    await sleep(2000);",
  "  }",
  '  return { rows: [], done: "partial", reason: "the export was not ready" };',
  "}",
  "",
  "async function payments() {",
  '  const accounts = await http.request({ url: "/accounts", headers: signed });',
  "  const rows = [];",
  "  for (const account of accounts.body.data) {",
  '    const answer = await http.request({ url: "/payments", query: { account_id: account.id }, headers: signed });',
  "    rows.push(...answer.body.data);",
  "  }",
  '  return { rows, done: "all", pages: accounts.body.data.length };',
  "}",
  "",
  "async function read(ctx) {",
  '  return ctx.op.path.indexOf("payments") >= 0 ? payments() : invoices();',
  "}",
].join("\n");

const twofoldProposal = {
  summary: "Starts a session with the API key, then reads invoices through an export and payments one account at a time.",
  credentials: [{ name: "api_key", label: "API key" }],
  exchanges: [{ name: "session" }],
  destinations: [
    { host: TF_HOST, role: "api", methods: ["GET", "POST"], credentials: ["api_key", "session"] },
    { host: TF_FILES, role: "download", methods: ["GET"], credentials: [] },
  ],
  requests: [
    { id: "session", purpose: "exchange", method: "POST", host: TF_HOST, path: "/v1/session", credentials: ["api_key"] },
    { id: "start_export", purpose: "export-create", method: "POST", host: TF_HOST, path: "/v1/invoices/exports", credentials: ["session"] },
    { id: "export_status", purpose: "export-status", method: "GET", host: TF_HOST, path: "/v1/invoices/exports/{id}", credentials: ["session"] },
    { id: "export_file", purpose: "download", method: "GET", host: TF_FILES, path: "/exports/**", credentials: [] },
    { id: "accounts", purpose: "read", method: "GET", host: TF_HOST, path: "/v1/accounts", credentials: ["session"] },
    { id: "payments", purpose: "read", method: "GET", host: TF_HOST, path: "/v1/payments", credentials: ["session"] },
  ],
  serves: true,
  code: TWOFOLD_CODE,
};


const sessionOf = (request: BenchRequest): string | null => {
  const header = request.headers["authorization"] ?? "";
  const match = /^Session (\S+)$/.exec(header);
  return match && sessions.has(match[1]!) ? match[1]! : null;
};

const csv = (rows: readonly (typeof tfInvoices)[number][]): string =>
  ["id,number,status,total", ...rows.map((one) => `${one.id},${one.number},${one.status},${one.total}`)].join("\n");

export const twofold: MockProvider = {
  id: "twofold",
  split: "dev",
  pattern:
    "One sign-in (an API key exchanged for a session) and two endpoints that each need code: invoices only as an export downloaded from a file host, payments one account at a time",
  hosts: [TF_HOST, TF_FILES],
  docsUrl: `https://${TF_HOST}/openapi.json`,
  credentials: [TF_KEY],
  credentialLabels: ["API key"],
  scriptedModel: { propose_connector: twofoldProposal },
  reset() {
    sessions.clear();
    exports.clear();
  },
  reference: {
    connection: {
      id: "twofold",
      title: "Twofold",
      kind: "rest",
      baseUrl: `https://${TF_HOST}/v1`,
      auth: {
        type: "connector",
        credentials: [{ name: "api_key", keyRef: "twofold-key", label: "API key" }],
        tokens: [{ name: "session", keyRef: "twofold-session" }],
      },
      ops: [
        {
          id: "invoices",
          title: "List invoices",
          path: "/invoices",
          servedBy: "connector",
          rowsPath: "$",
          readSafety: { basis: "person", note: "Starts an export with POST, then reads it." },
        },
        { id: "payments", title: "List payments", path: "/payments", servedBy: "connector", rowsPath: "$" },
      ],
      connector: {
        code: TWOFOLD_CODE,
        hash: connectorHash(TWOFOLD_CODE),
        hooks: ["authenticate", "read"],
        serves: ["invoices", "payments"],
        authority: {
          destinations: [
            { host: TF_HOST, methods: ["GET", "POST"], credentials: ["api_key", "session"] },
            { host: TF_FILES, role: "download", methods: ["GET"] },
          ],
          exchanges: [{ name: "session", fields: [] }],
          templates: twofoldProposal.requests,
        },
        author: { by: "person", at: "2026-09-30T00:00:00.000Z" },
      },
    },
    secrets: { "twofold-key": TF_KEY },
  },
  objectives: [
    {
      id: "open-invoices",
      request: "How many invoices are still open?",
      answer: tfInvoices.filter((one) => one.status === "open").length,
      tolerance: 0,
      records: tfInvoices.length,
      scripted: { path: "/invoices", measure: { agg: "count", where: 'status == "open"' } },
    },
    {
      id: "payments-total",
      request: "How much have we been paid in total?",
      answer: Math.round(tfPayments.reduce((sum, one) => sum + one.amount, 0) * 100) / 100,
      tolerance: 0.005,
      records: tfPayments.length,
      scripted: { path: "/payments", measure: { agg: "sum", field: "amount" } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === TF_FILES) {
      const id = /^\/exports\/(exp_\d+)\.csv$/.exec(url.pathname)?.[1];
      if (!id || !exports.has(id) || url.searchParams.get("sig") !== `s_${id}`) return json({ error: "no such file" }, 404);
      return { status: 200, headers: { "content-type": "text/csv" }, body: csv(tfInvoices) };
    }
    if (url.pathname === "/openapi.json") return json(twofoldSpec);
    if (url.pathname === "/v1/session" && request.method === "POST") {
      let key: unknown;
      try {
        key = (JSON.parse(request.body ?? "{}") as { api_key?: unknown }).api_key;
      } catch {
        key = undefined;
      }
      if (key !== TF_KEY) return json({ error: "unknown API key" }, 401);
      const token = `tf_sess_${sessions.size + 1}`;
      sessions.add(token);
      return json({ token, expires_in: 3600 });
    }
    if (!sessionOf(request)) return json({ error: "a session is needed: Authorization: Session <token>" }, 401);
    if (url.pathname === "/v1/invoices" && request.method === "GET")
      return json({ error: "export_required", message: "Invoices are only available as an export: POST /invoices/exports" }, 403);
    if (url.pathname === "/v1/invoices/exports" && request.method === "POST") {
      const id = `exp_${exports.size + 1}`;
      exports.set(id, 0);
      return json({ id, status: "pending" }, 202);
    }
    const exportId = /^\/v1\/invoices\/exports\/(exp_\d+)$/.exec(url.pathname)?.[1];
    if (exportId && request.method === "GET") {
      const polls = exports.get(exportId);
      if (polls === undefined) return notFound();
      exports.set(exportId, polls + 1);
      return polls < 1
        ? json({ id: exportId, status: "pending" })
        : json({ id: exportId, status: "ready", file_url: `https://${TF_FILES}/exports/${exportId}.csv?sig=s_${exportId}` });
    }
    if (url.pathname === "/v1/accounts" && request.method === "GET") return json({ data: tfAccounts });
    if (url.pathname === "/v1/payments" && request.method === "GET") {
      const account = url.searchParams.get("account_id");
      if (!account) return json({ error: "account_id is required: payments are listed one account at a time" }, 400);
      return json({ data: tfPayments.filter((one) => one.account_id === account) });
    }
    return notFound();
  },
};
