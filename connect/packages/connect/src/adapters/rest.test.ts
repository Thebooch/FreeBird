import type { ConnectionSpec, OpSpec, ResolvedParams } from "@freebirdai/connect-spec";
import { connectionSchema, getOp, resolveRange } from "@freebirdai/connect-spec";
import { describe, expect, it } from "vitest";
import { digestAuthorization, parseDigestChallenge } from "./digest.js";
import { INCOMPLETE } from "./incomplete.js";
import { RestAdapter, type HttpFetch, type HttpResponse } from "./rest.js";
import { signSigV4 } from "./sigv4.js";
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
  it("rejects pagination overrides that would skip records on later pages", async () => {
    const conn = connection({
      dialect: {
        pagination: { kind: "offset", param: "offset", limitParam: "limit", pageSize: 100 },
      },
    });
    const { http, calls } = stub([{ body: { data: [] } }]);
    await expect(
      new RestAdapter(http).fetch(conn, op(conn), { limit: 10 }, ctx()),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("requests the declared page size and offset from the first request", async () => {
    const { http, calls } = stub([
      { body: { data: Array.from({ length: 100 }, (_, id) => ({ id })) } },
      { body: { data: [{ id: 100 }] } },
    ]);
    const conn = connection({
      dialect: {
        pagination: { kind: "offset", param: "Offset", limitParam: "Limit", pageSize: 100 },
      },
    });
    const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
    expect(new URL(calls[0]!.url).searchParams.get("Limit")).toBe("100");
    expect(new URL(calls[0]!.url).searchParams.get("Offset")).toBe("0");
    expect(new URL(calls[1]!.url).searchParams.get("Offset")).toBe("100");
    expect(result.meta.pages).toBe(2);
    expect(result.meta.truncated).toBe(false);
  });

  it("accepts required query values through overrides and seeds declared defaults", async () => {
    const conn = connection({
      ops: [
        {
          id: "items",
          title: "Items",
          path: "/items",
          params: [
            { name: "status", in: "query", required: true },
            { name: "size", in: "query", default: 10 },
          ],
        },
      ],
    });
    const { http, calls } = stub([{ body: [] }]);
    await new RestAdapter(http).fetch(conn, op(conn), { status: "open" }, ctx());
    expect(new URL(calls[0]!.url).searchParams.get("status")).toBe("open");
    expect(new URL(calls[0]!.url).searchParams.get("size")).toBe("10");
    await expect(new RestAdapter(http).fetch(conn, op(conn), {}, ctx())).rejects.toMatchObject({
      status: 400,
    });
  });

  it("marks a repeated cursor as incomplete", async () => {
    const conn = connection({
      dialect: { pagination: { kind: "cursor", param: "after", cursorPath: "$.cursor" } },
    });
    const { http } = stub([{ body: { data: [{ id: 1 }], cursor: "same" } }]);
    const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.warnings.join(" ")).toContain("same page twice");
  });
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

  /* Regression: a read over every record sent `created[gte]=`, which the API refused. */
  it("leaves out a date bound that resolves to nothing, over every record", async () => {
    const { http, calls } = stub([{ body: { data: [] } }]);
    const conn = connection({
      ops: [
        {
          id: "items",
          title: "Items",
          path: "/items",
          query: { since: "{{range.start | unix}}", status: "paid" },
        },
      ],
    });
    const range = { ...resolveRange({ preset: "7d", now: NOW }), all: true as const };
    await new RestAdapter(http).fetch(conn, op(conn), {}, ctx({ params: { ...ctx().params, range } }));
    expect(calls[0]?.url).toBe("https://api.example.com/v1/items?status=paid");
  });

  it("encodes a path value, so an id with a slash stays one segment", async () => {
    const { http, calls } = stub([{ body: { data: [] } }]);
    const conn = connection({
      ops: [{ id: "items", title: "Items", path: "/orgs/{{param.region}}/items" }],
    });
    await new RestAdapter(http).fetch(
      conn,
      op(conn),
      {},
      ctx({ params: { ...ctx().params, filters: { region: "a/b?c" } } }),
    );
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/orgs/a%2Fb%3Fc/items");
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

    /* HTTP Digest, answering the server's challenge instead of sending the password. */
    it("answers a Digest challenge, then reads on with the same one", async () => {
      const challenge = { "www-authenticate": 'Digest realm="api", qop="auth", nonce="n0nce", algorithm=MD5, opaque="op"' };
      const { http, calls } = stub([
        { status: 401, body: { error: "unauthorized" }, headers: challenge },
        { body: { data: [{ id: 1 }], next: 2 } },
        { body: { data: [{ id: 2 }] } },
      ]);
      const conn = connection({
        auth: { type: "basic", digest: true, username: "reader", keyRef: "k" },
        ops: [{ id: "items", title: "Items", path: "/items", rowsPath: "$.data", pagination: { kind: "page", param: "page", startsAt: 1 } }],
      });
      await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      /* The password is never sent, not even as Basic. */
      expect(calls[0]!.headers.authorization).toBeUndefined();
      const answer = calls[1]!.headers.authorization!;
      const cnonce = /cnonce="([^"]+)"/.exec(answer)![1]!;
      const expected = await digestAuthorization({
        challenge: parseDigestChallenge(challenge["www-authenticate"])!,
        username: "reader",
        password: "sk_test_secret",
        method: "GET",
        uri: new URL(calls[1]!.url).pathname + new URL(calls[1]!.url).search,
        count: 1,
        cnonce,
      });
      expect(answer).toBe(expected);
      /* The next page signs with the same nonce, counted on: no second refusal first. */
      expect(calls[2]!.headers.authorization).toMatch(/nc=00000002/);
      /* One refusal in all: every page after it is signed first. */
      expect(calls.filter((_, index) => index > 0).every((call) => /^Digest /.test(call.headers.authorization ?? ""))).toBe(true);
    });

    it("does not answer a Digest challenge again and again for a wrong password", async () => {
      const challenge = { "www-authenticate": 'Digest realm="api", nonce="n", algorithm=MD5' };
      const { http, calls } = stub([
        { status: 401, body: {}, headers: challenge },
        { status: 401, body: {}, headers: challenge },
        { status: 401, body: {}, headers: challenge },
        { status: 401, body: {}, headers: challenge },
      ]);
      const conn = connection({ auth: { type: "basic", digest: true, username: "reader", keyRef: "k" } });
      await expect(new RestAdapter(http).fetch(conn, op(conn), {}, ctx())).rejects.toMatchObject({ status: 401 });
      expect(calls).toHaveLength(3);
    });

    /* AWS Signature V4, signed here by the built-in signer — never by connector code. */
    it("signs each request for AWS: its address, its time, and nothing of the secret key", async () => {
      const { http, calls } = stub([{ body: { data: [{ id: 1 }] } }, { body: { data: [] } }]);
      const secrets: Record<string, string> = { "aws-access": "AKIDEXAMPLE", aws: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
      const conn = connection({
        baseUrl: "https://a1b2c3.execute-api.eu-west-1.amazonaws.com/prod",
        /* No region stated: the address names it, so an account elsewhere is signed for its own. */
        auth: { type: "sigv4", accessKeyRef: "aws-access", keyRef: "aws" },
        ops: [{ id: "items", title: "Items", path: "/items", rowsPath: "$.data", pagination: { kind: "page", param: "page", startsAt: 1 } }],
      });
      await new RestAdapter(http).fetch(conn, op(conn), {}, ctx({ resolveSecret: async (ref) => secrets[ref] ?? null }));
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        const stamp = call.headers["x-amz-date"]!;
        const at = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15));
        const expected = await signSigV4({
          method: "GET",
          url: call.url,
          headers: {},
          credentials: { accessKeyId: secrets["aws-access"]!, secretAccessKey: secrets.aws!, region: "eu-west-1", service: "execute-api" },
          now: at,
        });
        expect(call.headers.authorization).toBe(expected.authorization);
        expect(JSON.stringify(call)).not.toContain(secrets.aws);
      }
      /* Each page is its own request, so each is signed for its own address. */
      expect(calls[0]!.headers.authorization).not.toBe(calls[1]!.headers.authorization);
    });

    it("asks for both AWS keys before it sends anything", async () => {
      const { http, calls } = stub([{ body: { data: [] } }]);
      const conn = connection({
        auth: { type: "sigv4", accessKeyRef: "aws-access", keyRef: "aws", region: "us-east-1", service: "execute-api" },
      });
      await expect(
        new RestAdapter(http).fetch(conn, op(conn), {}, ctx({ resolveSecret: async (ref) => (ref === "aws" ? "secret" : null) })),
      ).rejects.toMatchObject({ status: 401 });
      expect(calls).toHaveLength(0);
      /* An address that names no region, and none stated: said, rather than signed for a guess. */
      const unplaced = connection({ auth: { type: "sigv4", accessKeyRef: "aws-access", keyRef: "aws" } });
      await expect(new RestAdapter(http).fetch(unplaced, op(unplaced), {}, ctx())).rejects.toMatchObject({ status: 400 });
      expect(calls).toHaveLength(0);
    });

    /* Keys an API wants in a cookie, or in several places at once. */
    it("sends each key where the API wants it: a header, the address, a cookie", async () => {
      const { call } = await run({
        type: "headers",
        parts: [
          { header: "X-App-Id", keyRef: "k" },
          { header: "token", keyRef: "k", in: "query" },
          { header: "session", keyRef: "k", in: "cookie" },
        ],
      });
      expect(call.headers["x-app-id"]).toBe("sk_test_secret");
      expect(new URL(call.url).searchParams.get("token")).toBe("sk_test_secret");
      expect(call.headers.cookie).toBe("session=sk_test_secret");
    });

    it("sends a key in a cookie beside the endpoint's own cookies", async () => {
      const { http, calls } = stub([{ body: { data: [] } }]);
      const conn = connection({
        auth: { type: "headers", parts: [{ header: "session", keyRef: "k", in: "cookie" }] },
        ops: [{ id: "items", title: "Items", path: "/items", params: [{ name: "locale", in: "cookie", default: "en" }] }],
      });
      await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect(calls[0]!.headers.cookie).toBe("locale=en; session=sk_test_secret");
    });

    it("sends a custom header, with a template when given", async () => {
      expect(
        (await run({ type: "header", header: "X-Api-Key", keyRef: "k" })).call.headers["x-api-key"],
      ).toBe("sk_test_secret");
      expect(
        (
          await run({
            type: "header",
            header: "Authorization",
            keyRef: "k",
            template: "Token {{key}}",
          })
        ).call.headers.authorization,
      ).toBe("Token sk_test_secret");
    });

    it("sends basic auth", async () => {
      const { call } = await run({ type: "basic", username: "user", keyRef: "k" });
      expect(call.headers.authorization).toBe(`Basic ${btoa("user:sk_test_secret")}`);
    });

    /* Contoso: "the access key as the username and secret as the password".
     * Both halves are the person's, and neither is "the first secret". */
    it("sends basic auth whose username is a stored credential too", async () => {
      const { http, calls } = stub([{ body: { data: [] } }]);
      const conn = connection({
        auth: { type: "basic", usernameRef: "access", keyRef: "secret" },
      });
      await new RestAdapter(http).fetch(
        conn,
        op(conn),
        {},
        ctx({ resolveSecret: async (ref) => (ref === "access" ? "AK123" : "shh") }),
      );
      expect(calls[0]?.headers.authorization).toBe(`Basic ${btoa("AK123:shh")}`);
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

  /*
   * An unconfirmed address is the host the docs were served from, or a
   * template filled with its placeholder. A key sent there is a key sent to
   * somebody else, so nothing is sent at all.
   */
  describe("address", () => {
    it("sends nothing while the address is unconfirmed", async () => {
      const { http, calls } = stub([{ body: { data: [] } }]);
      const conn = connection({ auth: { type: "bearer", keyRef: "k" }, addressPending: true });
      await expect(new RestAdapter(http).fetch(conn, op(conn), {}, ctx())).rejects.toMatchObject({
        status: 400,
        userMessage: expect.stringMatching(/needs its address/),
      });
      expect(calls).toEqual([]);
    });

    it("sends nothing while a per-account blank is empty", async () => {
      const { http, calls } = stub([{ body: { data: [] } }]);
      const conn = connection({
        server: {
          url: "https://{account}.example.com/v1",
          variables: [{ name: "account" }],
          values: {},
        },
      });
      await expect(new RestAdapter(http).fetch(conn, op(conn), {}, ctx())).rejects.toMatchObject({
        status: 400,
      });
      expect(calls).toEqual([]);
    });

    it("goes to the address once it is filled in", async () => {
      const { http, calls } = stub([{ body: { data: [] } }]);
      const conn = connection({
        baseUrl: "https://acme.example.com/v1",
        server: {
          url: "https://{account}.example.com/v1",
          variables: [{ name: "account" }],
          values: { account: "acme" },
        },
      });
      await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect(calls[0]?.url).toBe("https://acme.example.com/v1/items");
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
      expect(forbidden.userMessage).toMatch(/denied access/);
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
      const { http, calls } = stub([page([1, 2], { next: "abc" }), page([3, 4], { next: null })]);
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

    /* Regression: Rick and Morty declares no page size and answers 404 past its last page. */
    describe("page numbers with no declared page size", () => {
      const paged = (maxPages = 10) =>
        connection({
          ops: [
            {
              id: "items",
              title: "Items",
              path: "/items",
              rowsPath: "$.data",
              maxPages,
              pagination: { kind: "page", param: "page", startsAt: 1 },
            },
          ],
        });
      const ids = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

      it("takes a page shorter than the first as the last", async () => {
        const { http, calls } = stub([page(ids(1, 3)), page(ids(4, 3)), page(ids(7, 1)), { status: 404, body: { error: "nothing here" } }]);
        const conn = paged();
        const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
        expect(calls).toHaveLength(3);
        expect((result.body as { data: unknown[] }).data).toHaveLength(7);
        expect(result.meta.truncated).toBe(false);
      });

      it("reads on past a short page when the API's own count says there is more", async () => {
        const { http, calls } = stub([
          page(ids(1, 3), { total: 8 }),
          page(ids(4, 2), { total: 8 }),
          page(ids(6, 3), { total: 8 }),
          page([], { total: 8 }),
        ]);
        const conn = connection({
          ops: [
            {
              id: "items",
              title: "Items",
              path: "/items",
              rowsPath: "$.data",
              totalPath: "$.total",
              maxPages: 10,
              pagination: { kind: "page", param: "page", startsAt: 1 },
            },
          ],
        });
        const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
        expect(calls.length).toBeGreaterThanOrEqual(3);
        expect((result.body as { data: unknown[] }).data).toHaveLength(8);
      });

      it("takes a 404 past the pages read as the end, not a failed read", async () => {
        const { http, calls } = stub([page(ids(1, 3)), page(ids(4, 3)), { status: 404, body: { error: "There is nothing here" } }]);
        const conn = paged();
        const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
        expect(calls).toHaveLength(3);
        expect((result.body as { data: unknown[] }).data).toHaveLength(6);
      });

      it("waits out a short rate limit part-way through and reads that page again", async () => {
        const { http, calls } = stub([
          page(ids(1, 3)),
          { status: 429, body: { error: "slow down" }, headers: { "retry-after": "2" } },
          page(ids(4, 3)),
          page(ids(7, 1)),
        ]);
        const conn = paged();
        const waits: number[] = [];
        const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx({ sleep: async (ms) => void waits.push(ms) }));
        expect(waits).toEqual([2000]);
        expect(calls[2]?.url).toBe(calls[1]?.url);
        expect((result.body as { data: unknown[] }).data).toHaveLength(7);
      });

      it("ends the read at a rate limit with no clock to wait on, or a wait too long", async () => {
        const limited = () => stub([page(ids(1, 3)), { status: 429, body: {}, headers: { "retry-after": "3600" } }, page(ids(4, 1))]);
        const conn = paged();
        await expect(new RestAdapter(limited().http).fetch(conn, op(conn), {}, ctx())).rejects.toMatchObject({ status: 429 });
        await expect(
          new RestAdapter(limited().http).fetch(conn, op(conn), {}, ctx({ sleep: async () => {} })),
        ).rejects.toMatchObject({ status: 429 });
      });

      /* 2026-09-30: "page × limit must be at most 1000" failed a read of the pages already in hand. */
      it("stops at a later page the API refuses, keeps what it read, and says so", async () => {
        const { http, calls } = stub([
          page(ids(1, 3)),
          page(ids(4, 3)),
          { status: 400, body: { error: "Result window is too large." } },
        ]);
        const conn = paged();
        const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
        expect(calls).toHaveLength(3);
        expect((result.body as { data: unknown[] }).data).toHaveLength(6);
        expect(result.meta.truncated).toBe(true);
        expect(result.meta.warnings).toContain(INCOMPLETE.laterPageRefused);
        /* A refusal of the first page is still a failed read. */
        const first = stub([{ status: 400, body: { error: "bad request" } }]);
        await expect(new RestAdapter(first.http).fetch(conn, op(conn), {}, ctx())).rejects.toBeInstanceOf(AdapterError);
      });

      it("still fails a 404 on the first page", async () => {
        const { http } = stub([{ status: 404, body: { error: "no such endpoint" } }]);
        const conn = paged();
        await expect(new RestAdapter(http).fetch(conn, op(conn), {}, ctx())).rejects.toBeInstanceOf(AdapterError);
      });
    });

    /* Regression: ten of 332 facts were read and shown as the whole. */
    it("says a read fell short where the answer states more records than were read", async () => {
      const { http } = stub([page([1, 2, 3], { total: 332 })]);
      const conn = connection();
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect(result.meta.truncated).toBe(true);
      expect(result.meta.warnings.join(" ")).toMatch(/reports 332 record/);
      expect(result.meta.reportedTotal).toBeUndefined();
    });

    it("claims nothing from a stated count that matches, or from a bare answer", async () => {
      const matched = stub([page([1, 2, 3], { count: 3 })]);
      const conn = connection();
      expect((await new RestAdapter(matched.http).fetch(conn, op(conn), {}, ctx())).meta.truncated).toBe(false);
      const bare = stub([{ body: { count: 90, name: "summary" } }]);
      const summary = connection({ ops: [{ id: "items", title: "Items", path: "/items" }] });
      expect((await new RestAdapter(bare.http).fetch(summary, op(summary), {}, ctx())).meta.truncated).toBe(false);
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
        {
          ...page([1]),
          headers: { link: '<https://api.example.com/v1/items?page=2>; rel="next"' },
        },
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
      expect(result.meta.warnings[0]).toMatch(/first 2 page\(s\) were read/);
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
      expect(result.meta.warnings.join()).toMatch(/same page twice/);
    });

    /* The next page's address, given in the answer: a token no parameter declares. */
    it("follows the address an answer gives for its next page, on its own host and with its key", async () => {
      const { http, calls } = stub([
        { body: { data: [{ id: 1 }], links: { next: "http://inner.example.internal/v1/items?token=abc%3D" } } },
        { body: { data: [{ id: 2 }], links: { next: { href: "/v1/items?token=def" } } } },
        { body: { data: [{ id: 3 }], links: { next: null } } },
      ]);
      const conn = connection({
        auth: { type: "query", param: "api_key", keyRef: "k" },
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            rowsPath: "$.data",
            maxPages: 10,
            pagination: { kind: "next-url", path: "$.links.next" },
          },
        ],
      });
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect((result.body as { data: unknown[] }).data).toHaveLength(3);
      expect(result.meta).toMatchObject({ pages: 3, truncated: false });
      /* The API's path and token; this connection's origin and key — never the host the answer named. */
      expect(calls.map((call) => new URL(call.url).origin)).toEqual(Array(3).fill("https://api.example.com"));
      expect(new URL(calls[1]!.url).searchParams.get("token")).toBe("abc=");
      expect(new URL(calls[2]!.url).searchParams.get("token")).toBe("def");
      expect(calls.every((call) => new URL(call.url).searchParams.get("api_key") === "sk_test_secret")).toBe(true);
      /* The key is still masked wherever the address is reported. */
      expect(result.meta.url).not.toContain("sk_test_secret");
    });

    it("ends at an empty page, whatever address it still offers", async () => {
      const { http, calls } = stub([
        { body: { data: [{ id: 1 }], next: "/v1/items?page=2" } },
        { body: { data: [], next: "/v1/items?page=3" } },
      ]);
      const conn = connection({
        ops: [{ id: "items", title: "Items", path: "/items", rowsPath: "$.data", maxPages: 10, pagination: { kind: "next-url", path: "$.next" } }],
      });
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
      expect(calls).toHaveLength(2);
      expect(result.meta.truncated).toBe(false);
    });
  });
});

describe("multi-header auth", () => {
  const fabrikam = (): ConnectionSpec =>
    connection({
      id: "fabrikam",
      title: "Fabrikam",
      baseUrl: "https://api.fabrikam.example",
      auth: {
        type: "headers",
        parts: [
          { header: "x-fabrikam-client-id", keyRef: "fabrikam-id", label: "Client ID" },
          { header: "x-fabrikam-client-secret", keyRef: "fabrikam-secret", label: "Client secret" },
        ],
      },
      ops: [{ id: "leases", title: "Leases", path: "/v1/leases", rowsPath: "$" }],
    });

  it("sends every part as its own header", async () => {
    const { http, calls } = stub([{ body: [] }]);
    const conn = fabrikam();

    await new RestAdapter(http).fetch(
      conn,
      op(conn),
      {},
      {
        ...ctx(),
        // Each keyRef resolves to its own distinct secret.
        resolveSecret: async (ref: string) =>
          ref === "fabrikam-id" ? "CLIENT-ID" : "CLIENT-SECRET",
      },
    );

    expect(calls[0]?.headers["x-fabrikam-client-id"]).toBe("CLIENT-ID");
    expect(calls[0]?.headers["x-fabrikam-client-secret"]).toBe("CLIENT-SECRET");
  });

  it("refuses to fire when only one of the two secrets is stored", async () => {
    const { http } = stub([{ body: [] }]);
    const conn = fabrikam();

    // Half-configured auth would otherwise 401 with an opaque provider message.
    await expect(
      new RestAdapter(http).fetch(
        conn,
        op(conn),
        {},
        {
          ...ctx(),
          resolveSecret: async (ref: string) => (ref === "fabrikam-id" ? "CLIENT-ID" : null),
        },
      ),
    ).rejects.toThrow(/fabrikam-secret/);
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

    await new RestAdapter(http).fetch(
      conn,
      op(conn),
      {},
      {
        ...ctx(),
        // Path parameters are supplied as filters, same as any other param.
        params: { ...ctx().params, filters: { applicationId: "42" } },
      },
    );
    expect(calls[0]?.url).toContain("/v1/applications/42/transactions");
  });
});
