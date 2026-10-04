import { createHash } from "node:crypto";
import { bearerOf, intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchResponse, MockProvider } from "../types.js";

/**
 * Oauthco: signing in with PKCE; tokens that run out; rotating refresh.
 *
 * An OAuth sign-in with PKCE, whose access tokens are good for three requests
 * and whose refresh tokens change each time one is used.
 */

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
