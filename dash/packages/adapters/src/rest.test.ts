import type { ConnectionSpec, OpSpec, ResolvedParams } from "@freebirdai/dash-spec";
import { connectionSchema, getOp, resolveRange } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { RestAdapter, type HttpFetch, type HttpResponse } from "./rest.js";
import { AdapterError, type FetchContext } from "./types.js";

const NOW = Date.UTC(2026, 7, 4);

const ctx = (extra: Partial<FetchContext> = {}): FetchContext => ({
  now: NOW,
  params: {
    range: resolveRange({ preset: "7d", now: NOW }),
    filters: { region: "emea" },
  } satisfies ResolvedParams,
  resolveSecret: async () => "sk_test_secret",
  ...extra,
});

interface Recorded {
  url: string;
  headers: Record<string, string>;
  allowedHost: string | null;
}

const stub = (
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
): { http: HttpFetch; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  let index = 0;
  const http: HttpFetch = async (url, init, allowedHost) => {
    calls.push({ url, headers: init.headers, allowedHost });
    const next = responses[Math.min(index++, responses.length - 1)]!;
    const response: HttpResponse = {
      status: next.status ?? 200,
      text: typeof next.body === "string" ? next.body : JSON.stringify(next.body),
      url,
      header: (name) => next.headers?.[name.toLowerCase()] ?? null,
    };
    return response;
  };
  return { http, calls };
};

const connection = (overrides: Record<string, unknown> = {}): ConnectionSpec =>
  connectionSchema.parse({
    id: "api",
    title: "Demo API",
    kind: "rest",
    baseUrl: "https://api.example.com/v1",
    ops: [{ id: "items", title: "Items", path: "/items", rowsPath: "$.data" }],
    ...overrides,
  });

/**
 * Adapters always receive a *resolved* op — archetype defaults, the dialect
 * and the op's own overrides already collapsed. `getOp` is what does that, so
 * tests go through it rather than reaching for the stored definition.
 */
const op = (conn: ConnectionSpec): OpSpec => getOp(conn, conn.ops[0]!.id)!;

describe("RestAdapter", () => {
  it("must run server-side", () => {
    expect(new RestAdapter(stub([{ body: {} }]).http).transport).toBe("proxy");
  });

  it("builds the URL from the base, the path and the query", async () => {
    const { http, calls } = stub([{ body: { data: [] } }]);
    const conn = connection({
      ops: [{ id: "items", title: "Items", path: "/items", query: { limit: 50 } }],
    });
    await new RestAdapter(http).fetch(conn, op(conn), { status: "paid" }, ctx());

    expect(calls[0]?.url).toBe("https://api.example.com/v1/items?limit=50&status=paid");
    expect(calls[0]?.allowedHost).toBe("api.example.com");
  });

  it("interpolates params into the path and the query", async () => {
    const { http, calls } = stub([{ body: { data: [] } }]);
    const conn = connection({
      ops: [
        {
          id: "items",
          title: "Items",
          path: "/orgs/{{param.region}}/items",
          query: { since: "{{range.start | unix}}" },
        },
      ],
    });
    await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/orgs/emea/items");
    expect(url.searchParams.get("since")).toBe(
      String(Math.floor(resolveRange({ preset: "7d", now: NOW }).start / 1000)),
    );
  });

  it("treats an empty override as no filter rather than filtering by empty", async () => {
    const { http, calls } = stub([{ body: { data: [] } }]);
    const conn = connection({
      ops: [{ id: "items", title: "Items", path: "/items", query: { region: "all" } }],
    });
    await new RestAdapter(http).fetch(conn, op(conn), { region: "" }, ctx());
    expect(calls[0]?.url).toBe("https://api.example.com/v1/items");
  });

  describe("auth", () => {
    const run = async (auth: Record<string, unknown>) => {
      const { http, calls } = stub([{ body: { data: [] } }]);
      const conn = connection({ auth });
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      return { call: calls[0]!, result };
    };

    it("sends a bearer token", async () => {
      const { call } = await run({ type: "bearer", keyRef: "k" });
      expect(call.headers.authorization).toBe("Bearer sk_test_secret");
    });

    it("sends a custom header, with a template when given", async () => {
      expect((await run({ type: "header", header: "X-Api-Key", keyRef: "k" })).call.headers["x-api-key"]).toBe(
        "sk_test_secret",
      );
      expect(
        (await run({ type: "header", header: "Authorization", keyRef: "k", template: "Token {{key}}" }))
          .call.headers.authorization,
      ).toBe("Token sk_test_secret");
    });

    it("sends basic auth", async () => {
      const { call } = await run({ type: "basic", username: "user", keyRef: "k" });
      expect(call.headers.authorization).toBe(`Basic ${btoa("user:sk_test_secret")}`);
    });

    it("puts a query key on the wire but never in the reported URL", async () => {
      const { call, result } = await run({ type: "query", param: "api_key", keyRef: "k" });
      expect(call.url).toContain("api_key=sk_test_secret");
      // The meta URL is shown in the inspector, so the secret must be gone.
      expect(result.meta.url).toContain("api_key=***");
      expect(result.meta.url).not.toContain("sk_test_secret");
    });

    it("fails with an actionable message when no key is stored", async () => {
      const { http } = stub([{ body: {} }]);
      const conn = connection({ auth: { type: "bearer", keyRef: "missing" } });
      const error: AdapterError = await new RestAdapter(http)
        .fetch(conn, op(conn), {}, ctx({ resolveSecret: async () => null }))
        .then(() => {
          throw new Error("should have rejected");
        })
        .catch((e: AdapterError) => e);

      // The technical message is for logs; userMessage is what a person reads.
      expect(error.message).toMatch(/no key stored for "missing"/);
      expect(error.userMessage).toMatch(/needs an API key/);
      expect(error.status).toBe(401);
    });
  });

  describe("errors", () => {
    const failWith = async (
      status: number,
      headers?: Record<string, string>,
    ): Promise<AdapterError> => {
      const { http } = stub([{ status, body: { error: "nope" }, ...(headers ? { headers } : {}) }]);
      const conn = connection();
      return new RestAdapter(http)
        .fetch(conn, op(conn), {}, ctx())
        .then(() => {
          throw new Error("should have rejected");
        })
        .catch((error: AdapterError) => error);
    };

    it("distinguishes a rejected key from a server error", async () => {
      expect((await failWith(401)).userMessage).toMatch(/rejected the key/);
      expect((await failWith(500)).userMessage).toMatch(/returned an error \(500\)/);
    });

    it("does not call a forbidden endpoint a rejected key", async () => {
      /*
       * These used to share a message, and it stranded people. A 403 means the
       * API identified the caller and declined this *resource* — the key is
       * proven, not broken. Saying otherwise sends somebody off to reissue
       * credentials that were never the problem.
       */
      const forbidden = await failWith(403);
      expect(forbidden.status).toBe(403);
      expect(forbidden.userMessage).toMatch(/accepted the key/);
      expect(forbidden.userMessage).not.toMatch(/rejected/);

      const rejected = await failWith(401);
      expect(rejected.status).toBe(401);
      expect(rejected.userMessage).not.toMatch(/accepted/);
    });

    it("names the rate limit and the wait", async () => {
      const error = await failWith(429, { "retry-after": "30" });
      expect(error.userMessage).toMatch(/rate limiting us — try again in 30s/);
    });

    it("says so when the response is not JSON", async () => {
      const { http } = stub([{ body: "<html>error page</html>" }]);
      const conn = connection();
      const error: AdapterError = await new RestAdapter(http)
        .fetch(conn, op(conn), {}, ctx())
        .then(() => {
          throw new Error("should have rejected");
        })
        .catch((e: AdapterError) => e);

      expect(error.message).toMatch(/was not JSON/);
      expect(error.userMessage).toMatch(/other than JSON/);
    });
  });

  describe("pagination", () => {
    const page = (ids: number[], extra: Record<string, unknown> = {}) => ({
      body: { data: ids.map((id) => ({ id })), ...extra },
    });

    it("fetches one page when pagination is none", async () => {
      const { http, calls } = stub([page([1, 2]), page([3, 4])]);
      const conn = connection();
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect(calls).toHaveLength(1);
      expect(result.meta.pages).toBe(1);
    });

    it("follows a cursor and merges rows back into the original shape", async () => {
      const { http, calls } = stub([
        page([1, 2], { next: "abc" }),
        page([3, 4], { next: null }),
      ]);
      const conn = connection({
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            rowsPath: "$.data",
            pagination: { kind: "cursor", cursorPath: "$.next", param: "cursor" },
          },
        ],
      });
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());

      expect(calls).toHaveLength(2);
      expect(calls[1]?.url).toContain("cursor=abc");
      // The pipeline's `$.data[*]` must work identically for 1 page or 10.
      expect(result.body).toMatchObject({ data: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] });
      expect(result.meta.pages).toBe(2);
    });

    it("stops on a hasMore flag even when a cursor is still present", async () => {
      const { http, calls } = stub([page([1], { next: "abc", has_more: false })]);
      const conn = connection({
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            rowsPath: "$.data",
            pagination: {
              kind: "cursor",
              cursorPath: "$.next",
              param: "cursor",
              hasMorePath: "$.has_more",
            },
          },
        ],
      });
      await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect(calls).toHaveLength(1);
    });

    it("stops offset paging on a short page", async () => {
      const { http, calls } = stub([page([1, 2]), page([3])]);
      const conn = connection({
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            rowsPath: "$.data",
            pagination: { kind: "offset", param: "offset", limitParam: "limit", pageSize: 2 },
          },
        ],
      });
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect(calls).toHaveLength(2);
      expect(calls[1]?.url).toContain("offset=2");
      expect(result.body).toMatchObject({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    });

    it("follows a Link header", async () => {
      const { http, calls } = stub([
        { ...page([1]), headers: { link: '<https://api.example.com/v1/items?page=2>; rel="next"' } },
        page([2]),
      ]);
      const conn = connection({
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            rowsPath: "$.data",
            pagination: { kind: "link-header" },
          },
        ],
      });
      await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect(calls[1]?.url).toBe("https://api.example.com/v1/items?page=2");
    });

    it("reports truncation loudly rather than returning a quietly short result", async () => {
      const { http } = stub([page([1], { next: "more" })]);
      const conn = connection({
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            rowsPath: "$.data",
            maxPages: 2,
            pagination: { kind: "cursor", cursorPath: "$.next", param: "cursor" },
          },
        ],
      });
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());

      expect(result.meta.truncated).toBe(true);
      expect(result.meta.warnings[0]).toMatch(/stopped after 2 page\(s\)/);
    });

    it("breaks a pagination loop instead of hammering the same URL", async () => {
      const { http, calls } = stub([page([1], { next: "same" })]);
      const conn = connection({
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            rowsPath: "$.data",
            maxPages: 10,
            pagination: { kind: "cursor", cursorPath: "$.next", param: "cursor" },
          },
        ],
      });
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect(calls.length).toBeLessThan(4);
      expect(result.meta.warnings.join()).toMatch(/repeated a page/);
    });
  });
});

describe("multi-header auth", () => {
  const buildium = (): ConnectionSpec =>
    connection({
      id: "buildium",
      title: "Buildium",
      baseUrl: "https://api.buildium.com",
      auth: {
        type: "headers",
        parts: [
          { header: "x-buildium-client-id", keyRef: "buildium-id", label: "Client ID" },
          { header: "x-buildium-client-secret", keyRef: "buildium-secret", label: "Client secret" },
        ],
      },
      ops: [{ id: "leases", title: "Leases", path: "/v1/leases", rowsPath: "$" }],
    });

  it("sends every part as its own header", async () => {
    const { http, calls } = stub([{ body: [] }]);
    const conn = buildium();

    await new RestAdapter(http).fetch(conn, op(conn), {}, {
      ...ctx(),
      // Each keyRef resolves to its own distinct secret.
      resolveSecret: async (ref: string) =>
        ref === "buildium-id" ? "CLIENT-ID" : "CLIENT-SECRET",
    });

    expect(calls[0]?.headers["x-buildium-client-id"]).toBe("CLIENT-ID");
    expect(calls[0]?.headers["x-buildium-client-secret"]).toBe("CLIENT-SECRET");
  });

  it("refuses to fire when only one of the two secrets is stored", async () => {
    const { http } = stub([{ body: [] }]);
    const conn = buildium();

    // Half-configured auth would otherwise 401 with an opaque provider message.
    await expect(
      new RestAdapter(http).fetch(conn, op(conn), {}, {
        ...ctx(),
        resolveSecret: async (ref: string) => (ref === "buildium-id" ? "CLIENT-ID" : null),
      }),
    ).rejects.toThrow(/buildium-secret/);
  });
});

describe("an endpoint whose path still needs a value", () => {
  it("names the missing parameter instead of letting the API 404", async () => {
    const { http, calls } = stub([{ body: [] }]);
    const conn = connection({
      ops: [
        {
          id: "txns",
          title: "Application transactions",
          path: "/v1/applications/{{param.applicationId}}/transactions",
          rowsPath: "$",
        },
      ],
    });

    const error: AdapterError = await new RestAdapter(http)
      .fetch(conn, op(conn), {}, ctx())
      .then(() => {
        throw new Error("should have rejected");
      })
      .catch((caught: AdapterError) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect(error.status).toBe(400);
    expect(error.userMessage).toMatch(/needs a value for "applicationId"/);
    // The request is never sent, so nothing can misread the provider's 404.
    expect(calls).toHaveLength(0);
  });

  it("sends the request once the value is supplied", async () => {
    const { http, calls } = stub([{ body: [] }]);
    const conn = connection({
      ops: [
        {
          id: "txns",
          title: "Application transactions",
          path: "/v1/applications/{{param.applicationId}}/transactions",
          rowsPath: "$",
        },
      ],
    });

    await new RestAdapter(http).fetch(conn, op(conn), {}, {
      ...ctx(),
      // Path parameters are supplied as filters, same as any other param.
      params: { ...ctx().params, filters: { applicationId: "42" } },
    });
    expect(calls[0]?.url).toContain("/v1/applications/42/transactions");
  });
});
