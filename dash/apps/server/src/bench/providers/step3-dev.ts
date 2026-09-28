import { createHash } from "node:crypto";
import { bearerOf, intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Dev-set providers for plan step 3: reads sent with POST, OAuth, list and
 * object parameters. Tuned against freely — the held-out ones for this step
 * are in `heldout-step3.ts`.
 */

const bodyOf = (request: BenchRequest): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(request.body ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/* ── Searchy: a POST search paged by offset in the body ───────────────── */

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

/* ── Oauthco: signing in with PKCE; tokens that run out; rotating refresh ─ */

const O_HOST = "api.oauthco.bench.test";
const O_CLIENT = "oc_client";
const O_SECRET = "oc_secret";
const O_USES = 3;

const projects = (() => {
  const next = random(8202);
  return Array.from({ length: 120 }, (_, index) => ({
    id: index + 1,
    state: pick(next, ["active", "active", "archived"] as const),
  }));
})();

const oCodes = new Map<string, string>();
const oTokens = new Map<string, number>();
const oRefresh = new Set<string>();
let oIssued = 0;

export const oauthco: MockProvider = {
  id: "oauthco",
  split: "dev",
  pattern: "OAuth sign-in with PKCE; access tokens good for three requests; refresh tokens that rotate",
  hosts: [O_HOST],
  docsUrl: `https://${O_HOST}/openapi.json`,
  credentials: [O_CLIENT, O_SECRET],
  reset() {
    oCodes.clear();
    oTokens.clear();
    oRefresh.clear();
    oIssued = 0;
  },
  reference: {
    connection: {
      id: "oauthco",
      title: "Oauthco",
      kind: "rest",
      baseUrl: `https://${O_HOST}/api`,
      auth: {
        type: "oauth2",
        flow: "authorization_code",
        authorizeUrl: `https://${O_HOST}/oauth/authorize`,
        tokenUrl: `https://${O_HOST}/oauth/token`,
        clientIdRef: "oauthco-client",
        clientSecretRef: "oauthco-secret",
        keyRef: "oauthco-token",
        refreshRef: "oauthco-refresh",
      },
      ops: [
        {
          id: "projects",
          title: "List projects",
          path: "/projects",
          pagination: { kind: "page", param: "page", startsAt: 1, limitParam: "per_page", pageSize: 25 },
          maxPages: 10,
        },
      ],
    },
    secrets: { "oauthco-client": O_CLIENT, "oauthco-secret": O_SECRET },
  },
  objectives: [
    {
      id: "active-projects",
      request: "How many projects are active?",
      answer: projects.filter((one) => one.state === "active").length,
      tolerance: 0,
      records: projects.length,
      scripted: { path: "/projects", measure: { agg: "count", where: 'state == "active"' } },
    },
  ],
  handle(request): BenchResponse {
    const { url } = request;
    if (url.pathname === "/openapi.json")
      return json({
        openapi: "3.0.3",
        info: { title: "Oauthco", version: "1" },
        servers: [{ url: `https://${O_HOST}/api` }],
        components: {
          securitySchemes: {
            oauth: {
              type: "oauth2",
              flows: {
                authorizationCode: {
                  authorizationUrl: `https://${O_HOST}/oauth/authorize`,
                  tokenUrl: `https://${O_HOST}/oauth/token`,
                  scopes: {},
                },
              },
            },
          },
        },
        security: [{ oauth: [] }],
        paths: {
          "/projects": {
            get: {
              summary: "List projects",
              parameters: [
                { name: "page", in: "query", schema: { type: "integer" } },
                { name: "per_page", in: "query", schema: { type: "integer", maximum: 25 } },
              ],
              responses: {
                "200": {
                  description: "Projects",
                  content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, state: { type: "string" } } } } } },
                },
              },
            },
          },
        },
      });
    if (url.pathname === "/oauth/authorize") {
      if (url.searchParams.get("client_id") !== O_CLIENT || url.searchParams.get("code_challenge_method") !== "S256")
        return json({ error: "invalid_request" }, 400);
      const code = `oc_code_${oCodes.size + 1}`;
      oCodes.set(code, url.searchParams.get("code_challenge") ?? "");
      const back = new URL(url.searchParams.get("redirect_uri") ?? "http://127.0.0.1/");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return { status: 302, headers: { location: back.toString() }, body: "" };
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(request.body ?? "");
      if (form.get("client_id") !== O_CLIENT || form.get("client_secret") !== O_SECRET) return json({ error: "invalid_client" }, 401);
      if (form.get("grant_type") === "authorization_code") {
        const challenge = oCodes.get(form.get("code") ?? "");
        if (!challenge || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== challenge)
          return json({ error: "invalid_grant" }, 400);
        oCodes.delete(form.get("code") ?? "");
      } else if (form.get("grant_type") === "refresh_token") {
        if (!oRefresh.delete(form.get("refresh_token") ?? "")) return json({ error: "invalid_grant" }, 400);
      } else return json({ error: "unsupported_grant_type" }, 400);
      oIssued++;
      oTokens.set(`oc_at_${oIssued}`, 0);
      oRefresh.add(`oc_rt_${oIssued}`);
      return json({ access_token: `oc_at_${oIssued}`, refresh_token: `oc_rt_${oIssued}`, token_type: "Bearer", expires_in: 3600 });
    }
    const token = bearerOf(request) ?? "";
    const uses = oTokens.get(token);
    if (uses === undefined || uses >= O_USES) return json({ error: "invalid_token" }, 401);
    oTokens.set(token, uses + 1);
    if (url.pathname === "/api/projects") {
      const per = Math.min(25, Math.max(1, intParam(request, "per_page", 10)));
      const page = Math.max(1, intParam(request, "page", 1));
      return json(projects.slice((page - 1) * per, page * per));
    }
    return notFound();
  },
};

/* ── Filterly: a required deepObject filter, with its default ─────────── */

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
