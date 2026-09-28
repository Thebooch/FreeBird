import { createHash } from "node:crypto";
import { cents, intParam, json, major, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Held-out providers for plan step 3 (reads sent with POST, OAuth).
 *
 * Written on 2026-09-28 before any of step 3 was built, and run only at its
 * checkpoint — see `dash/bench/PROTOCOL.md`. Nothing here may be read while
 * tuning the loop, a prompt or a repair.
 */

const form = (body: string | undefined): URLSearchParams => new URLSearchParams(body ?? "");
const bodyJson = (body: string | undefined): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(body ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/* ── Quotient: client-credentials OAuth, tokens that run out, a POST search ── */

const Q_HOST = "api.quotient.bench.test";
const Q_CLIENT = "qt_client_7";
const Q_SECRET = "qt_secret_9";
/** A token is good for this many API requests, then refused as expired. */
const Q_TOKEN_USES = 6;

const deals = (() => {
  const next = random(9404);
  return Array.from({ length: 230 }, (_, index) => ({
    id: `deal_${index + 1}`,
    stage: pick(next, ["open", "won", "lost", "won"] as const),
    amount: major(cents(next, 500, 40_000)),
  }));
})();

const quotientSpec = {
  openapi: "3.0.3",
  info: { title: "Quotient CRM", version: "2" },
  servers: [{ url: `https://${Q_HOST}/v2` }],
  components: {
    securitySchemes: {
      oauth: {
        type: "oauth2",
        flows: { clientCredentials: { tokenUrl: `https://${Q_HOST}/oauth/token`, scopes: { "deals.read": "Read deals" } } },
      },
    },
  },
  security: [{ oauth: ["deals.read"] }],
  paths: {
    "/deals/search": {
      post: {
        operationId: "searchDeals",
        summary: "Search deals",
        description: "Returns deals matching a filter, 50 at a time. Pass paging.next.after back as page.after for the next page.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  filter: { type: "object", properties: { stage: { type: "string" } } },
                  page: { type: "object", properties: { after: { type: "string" }, size: { type: "integer", maximum: 50 } } },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Deals",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { id: { type: "string" }, stage: { type: "string" }, amount: { type: "number" } },
                      },
                    },
                    paging: { type: "object", properties: { next: { type: "object", properties: { after: { type: "string" } } } } },
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

const quotientTokens = new Map<string, number>();

export const quotient: MockProvider = {
  id: "quotient",
  split: "heldout",
  pattern: "OAuth client credentials with tokens that run out mid-read; records only through a POST search, cursor in the body",
  hosts: [Q_HOST],
  docsUrl: `https://${Q_HOST}/openapi.json`,
  credentials: [Q_CLIENT, Q_SECRET],
  reset() {
    quotientTokens.clear();
  },
  reference: {
    connection: {
      id: "quotient",
      title: "Quotient",
      kind: "rest",
      baseUrl: `https://${Q_HOST}/v2`,
      auth: {
        type: "oauth2",
        flow: "client_credentials",
        tokenUrl: `https://${Q_HOST}/oauth/token`,
        clientIdRef: "quotient-client",
        clientSecretRef: "quotient-secret",
        keyRef: "quotient-token",
      },
      ops: [
        {
          id: "deals",
          title: "Search deals",
          method: "POST",
          path: "/deals/search",
          rowsPath: "$.results",
          body: { type: "json", template: {} },
          readSafety: { basis: "docs-inferred" },
          pagination: { kind: "cursor", param: "page.after", cursorPath: "$.paging.next.after", in: "body" },
          maxPages: 10,
        },
      ],
    },
    secrets: { "quotient-client": Q_CLIENT, "quotient-secret": Q_SECRET },
  },
  objectives: [
    {
      id: "won-total",
      request: "What is the total value of deals we have won?",
      answer: major(deals.filter((one) => one.stage === "won").reduce((sum, one) => sum + Math.round(one.amount * 100), 0)),
      tolerance: 0.005,
      records: deals.length,
      scripted: { path: "/deals/search", measure: { agg: "sum", field: "amount", where: 'stage == "won"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(quotientSpec);
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const fields = form(request.body);
      const basic = request.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(request.headers.authorization.slice(6), "base64").toString().split(":")
        : [];
      const id = fields.get("client_id") ?? basic[0];
      const secret = fields.get("client_secret") ?? basic[1];
      if (fields.get("grant_type") !== "client_credentials" || id !== Q_CLIENT || secret !== Q_SECRET)
        return json({ error: "invalid_client" }, 401);
      const token = `qt_at_${quotientTokens.size + 1}`;
      quotientTokens.set(token, 0);
      return json({ access_token: token, token_type: "bearer", expires_in: 3600 });
    }
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const uses = quotientTokens.get(token);
    if (uses === undefined) return json({ error: "invalid_token" }, 401);
    if (uses >= Q_TOKEN_USES) return json({ error: "invalid_token", error_description: "The access token expired" }, 401);
    quotientTokens.set(token, uses + 1);
    if (url.pathname === "/v2/deals/search" && request.method === "POST") {
      const body = bodyJson(request.body);
      const page = (body.page ?? {}) as { after?: string; size?: number };
      const start = Number(page.after ?? 0) || 0;
      const size = Math.min(50, Number(page.size ?? 50) || 50);
      const end = start + size;
      return json({
        results: deals.slice(start, end),
        paging: end < deals.length ? { next: { after: String(end) } } : {},
      });
    }
    if (url.pathname === "/v2/deals/search") return json({ error: "Use POST to search deals." }, 405);
    return notFound();
  },
};

/* ── Ledgerline: sign-in with PKCE, rotating refresh tokens, a filter, a total ── */

const L_HOST = "api.ledgerline.bench.test";
const L_AUTH = "login.ledgerline.bench.test";
const L_CLIENT = "ll_client_3";
const L_SECRET = "ll_secret_5";
const L_TOKEN_USES = 8;

const entries = (() => {
  const next = random(9505);
  return Array.from({ length: 380 }, (_, index) => ({
    id: 70_000 + index,
    account: pick(next, ["1000", "2000", "4000", "4000", "5000"] as const),
    amount: major(cents(next, 1, 5000)),
  }));
})();

const ledgerlineSpec = {
  openapi: "3.0.3",
  info: { title: "Ledgerline", version: "1" },
  servers: [{ url: `https://${L_HOST}/api` }],
  components: {
    securitySchemes: {
      oauth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: `https://${L_AUTH}/oauth/authorize`,
            tokenUrl: `https://${L_AUTH}/oauth/token`,
            refreshUrl: `https://${L_AUTH}/oauth/token`,
            scopes: { "ledger.read": "Read the ledger" },
          },
        },
      },
    },
  },
  security: [{ oauth: ["ledger.read"] }],
  paths: {
    "/entries": {
      get: {
        summary: "List ledger entries",
        parameters: [
          { name: "filter", in: "query", style: "deepObject", explode: true, schema: { type: "object", properties: { account: { type: "string" } } } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "per_page", in: "query", schema: { type: "integer", default: 25, maximum: 100 } },
        ],
        responses: {
          "200": {
            description: "Entries. The X-Total-Count header says how many match.",
            headers: { "X-Total-Count": { schema: { type: "integer" } } },
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { type: "object", properties: { id: { type: "integer" }, account: { type: "string" }, amount: { type: "number" } } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const codes = new Map<string, string>(); // code → challenge
const access = new Map<string, number>(); // token → uses
const refreshes = new Set<string>();

export const ledgerline: MockProvider = {
  id: "ledgerline",
  split: "heldout",
  pattern: "OAuth sign-in with PKCE and rotating refresh tokens; a deepObject filter; the total in a header",
  hosts: [L_HOST, L_AUTH],
  docsUrl: `https://${L_HOST}/openapi.json`,
  credentials: [L_CLIENT, L_SECRET],
  reference: {
    connection: {
      id: "ledgerline",
      title: "Ledgerline",
      kind: "rest",
      baseUrl: `https://${L_HOST}/api`,
      auth: {
        type: "oauth2",
        flow: "authorization_code",
        authorizeUrl: `https://${L_AUTH}/oauth/authorize`,
        tokenUrl: `https://${L_AUTH}/oauth/token`,
        clientIdRef: "ledgerline-client",
        clientSecretRef: "ledgerline-secret",
        keyRef: "ledgerline-token",
        refreshRef: "ledgerline-refresh",
      },
      ops: [
        {
          id: "entries",
          title: "List ledger entries",
          path: "/entries",
          pagination: { kind: "page", param: "page", startsAt: 1, limitParam: "per_page", pageSize: 100 },
          maxPages: 10,
        },
      ],
    },
    secrets: { "ledgerline-client": L_CLIENT, "ledgerline-secret": L_SECRET },
  },
  reset() {
    codes.clear();
    access.clear();
    refreshes.clear();
  },
  objectives: [
    {
      id: "revenue-entries",
      request: "How many entries are there in account 4000?",
      answer: entries.filter((one) => one.account === "4000").length,
      tolerance: 0,
      records: entries.length,
      scripted: { path: "/entries", measure: { agg: "count", where: 'account == "4000"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(ledgerlineSpec);
    if (url.hostname === L_AUTH && url.pathname === "/oauth/authorize") {
      const redirect = url.searchParams.get("redirect_uri");
      const challenge = url.searchParams.get("code_challenge");
      if (url.searchParams.get("client_id") !== L_CLIENT || !redirect || !challenge || url.searchParams.get("code_challenge_method") !== "S256")
        return json({ error: "invalid_request" }, 400);
      const code = `ll_code_${codes.size + 1}`;
      codes.set(code, challenge);
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return { status: 302, headers: { location: back.toString() }, body: "" };
    }
    if (url.hostname === L_AUTH && url.pathname === "/oauth/token" && request.method === "POST") {
      const fields = form(request.body);
      if (fields.get("client_id") !== L_CLIENT || fields.get("client_secret") !== L_SECRET)
        return json({ error: "invalid_client" }, 401);
      const grant = fields.get("grant_type");
      if (grant === "authorization_code") {
        const challenge = codes.get(fields.get("code") ?? "");
        const verifier = fields.get("code_verifier") ?? "";
        const expected = createHash("sha256").update(verifier).digest("base64url");
        if (!challenge || challenge !== expected) return json({ error: "invalid_grant" }, 400);
        codes.delete(fields.get("code") ?? "");
      } else if (grant === "refresh_token") {
        const refresh = fields.get("refresh_token") ?? "";
        if (!refreshes.has(refresh)) return json({ error: "invalid_grant" }, 400);
        refreshes.delete(refresh); // rotation: a refresh token works once
      } else return json({ error: "unsupported_grant_type" }, 400);
      const token = `ll_at_${access.size + 1}`;
      const refresh = `ll_rt_${access.size + 1}`;
      access.set(token, 0);
      refreshes.add(refresh);
      return json({ access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
    }
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const uses = access.get(token);
    if (uses === undefined || uses >= L_TOKEN_USES) return json({ error: "invalid_token" }, 401);
    access.set(token, uses + 1);
    if (url.pathname === "/api/entries") {
      const account = url.searchParams.get("filter[account]");
      const matching = account ? entries.filter((one) => one.account === account) : entries;
      const per = Math.min(100, Math.max(1, intParam(request, "per_page", 25)));
      const page = Math.max(1, intParam(request, "page", 1));
      return json(matching.slice((page - 1) * per, page * per), 200, { "x-total-count": String(matching.length) });
    }
    return notFound();
  },
};
