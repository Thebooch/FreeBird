import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import { fakeLlm, proposalSchema, reviewProposalSchema } from "@freebirdai/dash-agent";
import { capabilityReportSchema, connectionSchema, getOp } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore, connectionFromCatalog } from "./catalog.js";
import { toJsonSchema } from "./llm.js";
import { assertAllowedHost, assertPublicHttpUrl, isPrivateIp } from "./safe-fetch.js";
import { buildPartRegistry } from "./parts.js";
import { buildServer } from "./server.js";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";

let dir: string;
let store: SpecStore;
let keys: KeyStore;

const restConnection = connectionSchema.parse({
  id: "api",
  title: "Demo API",
  kind: "rest",
  baseUrl: "https://api.example.com",
  auth: { type: "bearer", keyRef: "api-key" },
  ops: [{ id: "items", title: "Items", path: "/items", rowsPath: "$.data" }],
  validateOpId: "items",
});

const stubHttp = (body: unknown = { data: [{ id: 1 }] }, status = 200): HttpFetch =>
  async (url) => ({
    status,
    text: JSON.stringify(body),
    url,
    header: () => null,
  });

const makeApp = (http?: HttpFetch) =>
  buildServer({ store, keys, ...(http ? { http } : { http: stubHttp() }) });

/** A two-endpoint catalog seed, shared by the catalog and endpoint suites. */
const makeCatalogFixture = (): CatalogStore => {
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(
    join(seed, "demo.json"),
    JSON.stringify({
      id: "demo",
      title: "Demo API",
      baseUrl: "https://api.example.com",
      dialect: {
        auth: { type: "bearer", keyRef: "placeholder" },
        pagination: { kind: "cursor", cursorPath: "$.data[last].id", param: "after" },
        rowsPath: "$.data",
        timeFilter: { param: "since", format: "iso" },
      },
      ops: [
        { id: "items", title: "Items", path: "/items" },
        { id: "totals", title: "Totals", path: "/totals", archetype: "summary" },
      ],
      validateOpId: "items",
    }),
    "utf8",
  );
  return new CatalogStore(seed, join(dir, ".dash", "catalog"));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-test-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  const vault = new LocalAesVault(Buffer.alloc(32, 7));
  keys = new KeyStore(vault, join(dir, ".dash", "vault.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("vault", () => {
  it("round-trips a secret", () => {
    const vault = new LocalAesVault(Buffer.alloc(32, 1));
    const token = vault.encrypt("sk_live_secret");
    expect(token).not.toContain("sk_live_secret");
    expect(vault.decrypt(token)).toBe("sk_live_secret");
  });

  it("refuses tampered ciphertext rather than returning garbage", () => {
    const vault = new LocalAesVault(Buffer.alloc(32, 1));
    const token = vault.encrypt("secret");
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(() => vault.decrypt(tampered)).toThrow();
  });

  it("returns null for a key encrypted under a different master key", () => {
    const other = new KeyStore(new LocalAesVault(Buffer.alloc(32, 9)), join(dir, "v.json"));
    other.set("k", "secret");
    const reopened = new KeyStore(new LocalAesVault(Buffer.alloc(32, 3)), join(dir, "v.json"));
    // Better to have no key than to send garbage to a third party as one.
    expect(reopened.get("k")).toBeNull();
    expect(reopened.has("k")).toBe(true);
  });

  it("persists across instances", () => {
    keys.set("k", "secret");
    const reopened = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
    expect(reopened.get("k")).toBe("secret");
  });
});

describe("capability report store", () => {
  const report = (connection = "acme") =>
    capabilityReportSchema.parse({
      connection,
      generatedAt: new Date("2026-08-14T10:00:00.000Z").toISOString(),
      opsFingerprint: "abc123",
      resources: [{ id: "lease", title: "Leases", relations: [] }],
    });

  it("survives being reopened — the point of writing it down", () => {
    store.putReport(report());
    const reopened = new SpecStore(
      join(dir, "dashboards"),
      join(dir, "connections"),
      join(dir, "reports"),
    );
    expect(reopened.getReport("acme")?.resources[0]?.id).toBe("lease");
  });

  it("bumps the revision on each write without the caller tracking it", () => {
    expect(store.putReport(report()).revision).toBe(1);
    expect(store.putReport(report()).revision).toBe(2);
    expect(store.getReport("acme")?.revision).toBe(3 - 1);
  });

  it("returns null for a connection that has never been read", () => {
    expect(store.getReport("never-seen")).toBeNull();
  });

  it("drops a report on delete so a reused id cannot inherit it", () => {
    store.putReport(report());
    store.deleteReport("acme");
    expect(store.getReport("acme")).toBeNull();
  });

  it("ignores a corrupt file rather than throwing on boot", () => {
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports", "broken.json"), "{ not json", "utf8");
    expect(store.getReport("broken")).toBeNull();
    expect(store.listReports()).toEqual([]);
  });

  it("is inert when no reports directory was configured", () => {
    const specOnly = new SpecStore(join(dir, "d2"), join(dir, "c2"));
    expect(specOnly.putReport(report()).revision).toBe(1);
    expect(specOnly.getReport("acme")).toBeNull();
    expect(specOnly.listReports()).toEqual([]);
  });
});

describe("SSRF guard", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
  ])("treats %s as private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700::1111"])("treats %s as public", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/admin",
    "http://localhost/",
    "http://foo.local/",
    "http://service.internal/",
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow();
  });

  it("pins a connection to its own host", () => {
    expect(() => assertAllowedHost(new URL("https://api.example.com/x"), "api.example.com")).not.toThrow();
    expect(() => assertAllowedHost(new URL("https://eu.api.example.com/x"), "api.example.com")).not.toThrow();
    // The core of the second gate: even a valid public URL is refused when it
    // is not this connection's host.
    expect(() => assertAllowedHost(new URL("https://evil.com/x"), "api.example.com")).toThrow(
      /may only reach api.example.com/,
    );
    expect(() => assertAllowedHost(new URL("https://notapi.example.com.evil.com/"), "api.example.com")).toThrow();
  });
});

describe("connection routes", () => {
  it("never returns a stored key, only whether one exists", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });

    const before = await app.inject({ method: "GET", url: "/api/connections/api" });
    expect(before.json()).toMatchObject({ hasKey: false });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/connections/api/key",
      payload: { key: "sk_live_supersecret" },
    });
    expect(saved.json()).toEqual({ ok: true, hasKey: true });

    const after = await app.inject({ method: "GET", url: "/api/connections/api" });
    expect(after.json()).toMatchObject({ hasKey: true });
    expect(after.body).not.toContain("sk_live_supersecret");

    const list = await app.inject({ method: "GET", url: "/api/connections" });
    expect(list.body).not.toContain("sk_live_supersecret");
  });

  it("rejects the wrong method on the key route rather than appearing to work", async () => {
    // The UI once POSTed here while the route was a PUT; the 404 surfaced as a
    // bare "Not Found" and the key was silently never stored.
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });

    const wrong = await app.inject({
      method: "POST",
      url: "/api/connections/api/key",
      payload: { key: "k" },
    });
    expect(wrong.statusCode).toBe(404);
    expect(keys.has("api-key")).toBe(false);

    const right = await app.inject({
      method: "PUT",
      url: "/api/connections/api/key",
      payload: { key: "k" },
    });
    expect(right.statusCode).toBe(200);
    expect(keys.has("api-key")).toBe(true);
  });

  it("rejects a connection spec that does not validate", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/connections/api",
      payload: { title: "X", kind: "rest", baseUrl: "not-a-url" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("validates a connection and reports a usable message", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "k" } });

    const response = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(response.statusCode).toBe(200);
    // Descriptive only: the UI supplies the status word, so it must not be
    // baked in here or the two get concatenated.
    expect(response.json().message).toMatch(/^Demo API responded with/);
    expect(response.json().message).not.toMatch(/Connected/);
  });

  it("accepts a bodyless POST — validate takes no payload", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "k" } });

    // No payload, and a content type Fastify does not parse: the shape a bare
    // `curl -X POST` or Invoke-RestMethod actually sends.
    const response = await app.inject({
      method: "POST",
      url: "/api/connections/api/validate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("still rejects malformed JSON rather than silently ignoring it", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/query",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
  });

  it("validates a connection written straight to disk, with no restart", async () => {
    // The self-hoster path: drop a JSON file in connections/ and validate it.
    // The server was already built before the file existed.
    const app = makeApp();
    store.putConnection(restConnection);
    keys.set("api-key", "k");

    const response = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it("explains a missing key rather than failing vaguely", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });

    const response = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatch(/needs an API key/);
  });

  it("distinguishes a rejected key from a broken service", async () => {
    const app = makeApp(stubHttp({ error: "bad token" }, 401));
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "wrong" } });

    const response = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatch(/rejected the key/);
  });

  it("treats a forbidden endpoint as proof the key works", async () => {
    /*
     * The bug this fixes: the endpoint chosen for validation belonged to a
     * product module the account was not licensed for, so it answered 403 and
     * the wizard reported the key as bad — forever, while every other endpoint
     * worked fine. A 403 cannot happen without the caller being identified
     * first, so it *is* the answer validation was asking for.
     */
    const app = makeApp(stubHttp({ error: "not licensed" }, 403));
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "fine" } });

    const response = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    // Which endpoints were refused is useful, and is a note rather than a
    // failure. Plural since validation walks a candidate list.
    expect(body.forbidden).toEqual(["items"]);
    expect(body.message).toMatch(/key works/);
  });
});

describe("query route", () => {
  it("proxies a query and returns body plus provenance", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "k" } });

    const response = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: { connection: "api", op: "items", range: { preset: "7d" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().body).toEqual({ data: [{ id: 1 }] });
    expect(response.json().meta).toMatchObject({ status: 200, pages: 1 });
  });

  it("routes a path input into the path, not the query string", async () => {
    /*
     * The bug this guards: a caller sends one flat bag of values, but a path
     * segment is filled from `filters` while everything else becomes a query
     * override. Sent to the wrong channel, the token resolves to an empty
     * string and the URL silently becomes `/items//detail` — a 404 that reads
     * exactly like a rejected key.
     */
    const seen: string[] = [];
    const app = makeApp(async (url) => {
      seen.push(url);
      return { status: 200, text: JSON.stringify({ id: 7 }), url, header: () => null };
    });

    await app.inject({
      method: "PUT",
      url: "/api/connections/api",
      payload: connectionSchema.parse({
        id: "api",
        title: "Demo API",
        kind: "rest",
        baseUrl: "https://api.example.com",
        ops: [
          {
            id: "detail",
            title: "One item",
            path: "/items/{{param.itemId}}",
            archetype: "summary",
            params: [{ name: "itemId", in: "path", required: true, role: "id" }],
          },
        ],
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: { connection: "api", op: "detail", params: { itemId: "7", verbose: "true" } },
    });

    expect(response.statusCode).toBe(200);
    // The id lands in the path; the unrelated value stays a query parameter.
    expect(seen[0]).toContain("/items/7");
    expect(seen[0]).toContain("verbose=true");
    expect(seen[0]).not.toContain("itemId=");
  });

  it("404s an unknown connection or operation", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });

    expect(
      (await app.inject({ method: "POST", url: "/api/query", payload: { connection: "ghost", op: "items" } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/api/query", payload: { connection: "api", op: "ghost" } }))
        .statusCode,
    ).toBe(404);
  });

  it("rejects a malformed query body", async () => {
    const app = makeApp();
    const response = await app.inject({ method: "POST", url: "/api/query", payload: { op: "items" } });
    expect(response.statusCode).toBe(400);
  });
});

describe("endpoints on an existing connection", () => {
  const setup = async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });
    return app;
  };

  it("adds an endpoint that is immediately queryable", async () => {
    const app = await setup();
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "k" } });

    const added = await app.inject({
      method: "POST",
      url: "/api/connections/api/ops",
      payload: { id: "reports", title: "Reports", path: "/reports", archetype: "list" },
    });

    expect(added.statusCode).toBe(200);
    expect(added.json().ops.map((op: { id: string }) => op.id)).toEqual(["items", "reports"]);

    // No restart, no re-save of the whole connection.
    const query = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: { connection: "api", op: "reports" },
    });
    expect(query.statusCode).toBe(200);
  });

  it("upserts, so the same route edits an endpoint", async () => {
    const app = await setup();
    await app.inject({
      method: "POST",
      url: "/api/connections/api/ops",
      payload: { id: "items", title: "Renamed", path: "/v2/items" },
    });

    const connection = (await app.inject({ method: "GET", url: "/api/connections/api" })).json();
    expect(connection.ops).toHaveLength(1);
    expect(connection.ops[0]).toMatchObject({ title: "Renamed", path: "/v2/items" });
  });

  it("rejects an endpoint that does not validate", async () => {
    const app = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/connections/api/ops",
      payload: { id: "bad id!", title: "", path: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("removes an endpoint and moves the validate op off it", async () => {
    const app = await setup();
    await app.inject({
      method: "POST",
      url: "/api/connections/api/ops",
      payload: { id: "second", title: "Second", path: "/second" },
    });

    const after = await app.inject({ method: "DELETE", url: "/api/connections/api/ops/items" });
    expect(after.statusCode).toBe(200);
    expect(after.json().ops.map((op: { id: string }) => op.id)).toEqual(["second"]);
    // "items" was the validate op; it must not dangle.
    expect(after.json().validateOpId).toBe("second");
  });

  it("404s removing an endpoint that is not there", async () => {
    const app = await setup();
    const response = await app.inject({ method: "DELETE", url: "/api/connections/api/ops/ghost" });
    expect(response.statusCode).toBe(404);
  });

  it("offers the catalog endpoints this connection is not yet using", async () => {
    const app = buildServer({ store, keys, catalog: makeCatalogFixture(), http: stubHttp() });
    await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "demo", id: "mine", opIds: ["items"] },
    });

    const available = await app.inject({ method: "GET", url: "/api/connections/mine/available-ops" });
    expect(available.json().map((op: { id: string }) => op.id)).toEqual(["totals"]);

    await app.inject({
      method: "POST",
      url: "/api/connections/mine/ops",
      payload: { id: "totals", title: "Totals", path: "/totals", archetype: "summary" },
    });
    expect((await app.inject({ method: "GET", url: "/api/connections/mine/available-ops" })).json()).toEqual([]);
  });

  it("returns nothing available for a hand-made connection", async () => {
    const app = await setup();
    expect((await app.inject({ method: "GET", url: "/api/connections/api/available-ops" })).json()).toEqual([]);
  });
});

describe("sample + delete", () => {
  it("describes what actually came back, so onboarding shows rows not a tick", async () => {
    const app = makeApp(
      stubHttp({ data: [{ id: 1, amount: 4200, created: 1785000000, note: "hi" }] }),
    );
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "k" } });

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/api/sample",
      payload: { op: "items" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rowsPath).toBe("$.data");
    expect(body.rowCount).toBe(1);
    expect(body.schemaHash).toMatch(/^fnv1a:/);

    const byName = new Map(body.fields.map((f: { name: string }) => [f.name, f]));
    expect(byName.get("amount")).toMatchObject({ format: "minor_units" });
    expect(byName.get("created")).toMatchObject({ format: "unix_seconds" });
    expect(byName.get("note")).toMatchObject({ kinds: ["string"], format: null });
  });

  it("404s a sample for an endpoint that does not exist", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });
    const response = await app.inject({
      method: "POST",
      url: "/api/connections/api/sample",
      payload: { op: "ghost" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("takes the stored key with the connection when it is deleted", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "k" } });
    expect(keys.has("api-key")).toBe(true);

    await app.inject({ method: "DELETE", url: "/api/connections/api" });

    expect((await app.inject({ method: "GET", url: "/api/connections/api" })).statusCode).toBe(404);
    // An orphaned credential is a liability nobody remembers is there.
    expect(keys.has("api-key")).toBe(false);
  });
});

describe("capabilities", () => {
  /** A collection and its by-id endpoint, invented rather than borrowed. */
  const relational = connectionSchema.parse({
    ...restConnection,
    ops: [
      { id: "items", title: "Items", path: "/items", rowsPath: "$.data" },
      {
        id: "item",
        title: "Item",
        path: "/items/{{param.itemId}}",
        params: [{ name: "itemId", in: "path", required: true, role: "id" }],
      },
    ],
  });

  it("reports what the connection can do without changing it", async () => {
    const app = makeApp(stubHttp({ data: [{ id: 7, name: "Ada" }] }));
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: relational });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "k" } });

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/api/capabilities",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().drillDowns).toEqual([
      {
        resource: "item",
        title: "Items",
        listOp: "items",
        detailOp: "item",
        idField: "id",
        detailParam: "itemId",
        labelField: "name",
        sampled: true,
      },
    ]);
    // A proposal is not an edit: nothing is stored until it is accepted.
    expect(store.getConnection("api")?.resources).toEqual([]);
  });

  it("stores resources only when they are accepted", async () => {
    const app = makeApp(stubHttp({ data: [{ id: 7, name: "Ada" }] }));
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: relational });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "k" } });

    const proposal = (
      await app.inject({ method: "POST", url: "/api/connections/api/capabilities" })
    ).json();

    const accepted = await app.inject({
      method: "PUT",
      url: "/api/connections/api/resources",
      payload: { resources: proposal.resources },
    });

    expect(accepted.statusCode).toBe(200);
    expect(store.getConnection("api")?.resources).toMatchObject([
      { id: "item", listOp: "items", detailOp: "item", idField: "id" },
    ]);
    // The key is never echoed back, whatever the route.
    expect(accepted.json()).not.toHaveProperty("key");
    expect(accepted.json().hasKey).toBe(true);
  });

  it("reads back how records relate without spending a request", async () => {
    /*
     * This is the screen someone opens to check a link. If merely looking
     * enumerated the API, checking would cost money on a pay-per-request
     * plan — so the route is a GET and the stub is set to fail the moment it
     * is called.
     */
    const app = buildServer({
      store,
      keys,
      http: async () => {
        throw new Error("the relations route must not call the API");
      },
    });
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: relational });

    const response = await app.inject({ method: "GET", url: "/api/connections/api/relations" });
    expect(response.statusCode).toBe(200);
    expect(response.json().source).toBe("endpoints");
    expect(response.json().resources).toMatchObject([{ id: "item", listOp: "items" }]);
  });

  it("lets a saved link outrank the one a fresh pass would infer", async () => {
    const app = makeApp(stubHttp({ data: [{ id: 7, name: "Ada" }] }));
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: relational });

    const { resources } = (
      await app.inject({ method: "GET", url: "/api/connections/api/relations" })
    ).json();

    await app.inject({
      method: "PUT",
      url: "/api/connections/api/resources",
      payload: {
        resources: resources.map((resource: { id: string }) => ({
          ...resource,
          relations: [
            {
              id: "item-notes",
              title: "Notes",
              resource: "item",
              cardinality: "many",
              via: "filter",
              op: "items",
              // The matching column, which is what an edit actually sets — a
              // query parameter would have to be one the endpoint declares.
              foreignField: "CorrectedByHand",
              confidence: "inferred",
              verified: true,
            },
          ],
        })),
      },
    });

    // Re-derived from the endpoints, but the saved correction survives it.
    const after = (
      await app.inject({ method: "GET", url: "/api/connections/api/relations" })
    ).json();
    expect(after.resources[0].relations[0]).toMatchObject({
      foreignField: "CorrectedByHand",
    });
  });

  it("rejects resources that are not resources", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: relational });
    const response = await app.inject({
      method: "PUT",
      url: "/api/connections/api/resources",
      payload: { resources: [{ id: "item" }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("suggests widgets in sentences, without a model", async () => {
    // Two rows, because one value is no evidence that a column is a small
    // closed set — the rule that spots a status needs to see variation.
    const app = makeApp(
      stubHttp({
        data: [
          { id: 7, name: "Ada", state: "listed" },
          { id: 8, name: "Grace", state: "vacant" },
          { id: 9, name: "Alan", state: "listed" },
        ],
      }),
    );
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: relational });
    await app.inject({ method: "PUT", url: "/api/connections/api/key", payload: { key: "k" } });

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/api/suggestions",
    });

    expect(response.statusCode).toBe(200);
    const { suggestions, reviewed } = response.json();
    const [first] = suggestions;
    expect(first.source).toBe("rule");
    expect(first.headline).toMatch(/^This widget will/);
    // A real spec, not a description of one — it saves through the same path a
    // model's proposal does. The component is deliberately not pinned: which
    // rule wins depends on the data, and asserting one here would break every
    // time a better-scoring rule is added.
    expect(first.widget.source.connection).toBe("api");
    expect(first.widget.roles).toBeDefined();

    // Several rules now fire on one resource, so a single collection yields a
    // list, a breakdown of its status column, and so on.
    expect(suggestions.length).toBeGreaterThan(1);
    expect(suggestions.map((entry: { widget: { component: string } }) => entry.widget.component)).toContain(
      "table",
    );

    // "listed" is not in the status vocabulary, so it is offered and asked
    // about rather than suppressed or silently coloured.
    const asking = suggestions.find(
      (entry: { confirm: Array<{ question: string }> }) => entry.confirm.length > 0,
    );
    expect(asking?.confirm[0]?.question).toContain("listed");

    // The AI pass is separate and absent without a key — never merged in.
    expect(reviewed).toEqual([]);
  });

  it("404s for a connection that does not exist", async () => {
    const app = makeApp();
    expect(
      (await app.inject({ method: "POST", url: "/api/connections/ghost/capabilities" })).statusCode,
    ).toBe(404);
  });
});

describe("catalog", () => {
  const seedDir = () => join(dir, "seed");
  const makeCatalog = makeCatalogFixture;

  it("reads the repo seed and marks its origin", () => {
    const entries = makeCatalog().list();
    expect(entries.map((entry) => entry.id)).toEqual(["demo"]);
    expect(entries[0]?.origin).toBe("repo");
  });

  it("lets a local overlay win over the seed", () => {
    const catalog = makeCatalog();
    const seeded = catalog.get("demo")!;
    catalog.put({ ...seeded, title: "Corrected locally", verified: true });

    const after = catalog.get("demo")!;
    expect(after.title).toBe("Corrected locally");
    expect(after.verified).toBe(true);

    // Dropping the override falls back to the seed rather than deleting it.
    catalog.deleteOverlay("demo");
    expect(catalog.get("demo")?.title).toBe("Demo API");
  });

  it("survives a malformed catalog file instead of refusing to boot", () => {
    const catalog = makeCatalog();
    writeFileSync(join(seedDir(), "broken.json"), "{ not json", "utf8");
    expect(catalog.list().map((entry) => entry.id)).toEqual(["demo"]);
  });

  it("builds a working connection from an entry, with the key wired to this connection", () => {
    const entry = makeCatalog().get("demo")!;
    const connection = connectionFromCatalog(entry, { id: "mine" });

    expect(connection.id).toBe("mine");
    expect(connection.catalog).toBe("demo");
    // The placeholder keyRef from the catalog is replaced per connection.
    expect(connection.auth).toMatchObject({ type: "bearer", keyRef: "mine-key" });
    expect(connection.dialect?.auth).toMatchObject({ keyRef: "mine-key" });

    // And the dialect actually resolves into executable endpoints.
    const items = getOp(connection, "items")!;
    expect(items.rowsPath).toBe("$.data");
    expect(items.query.since).toBe("{{range.start | iso}}");
    expect(items.pagination).toMatchObject({ kind: "cursor", param: "after" });
  });

  it("takes only the endpoints the user picked", () => {
    const entry = makeCatalog().get("demo")!;
    const connection = connectionFromCatalog(entry, { opIds: ["totals"] });
    expect(connection.ops.map((op) => op.id)).toEqual(["totals"]);
    expect(connection.validateOpId).toBe("totals");
  });

  it("creates a connection over HTTP from a catalog id", async () => {
    const app = buildServer({ store, keys, catalog: makeCatalog(), http: stubHttp() });

    const created = await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "demo", id: "mine" },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id: "mine", needsKey: true, hasKey: false });
    // And it is immediately usable, no restart.
    expect((await app.inject({ method: "GET", url: "/api/connections/mine" })).statusCode).toBe(200);
  });

  it("never overwrites an existing connection when the same API is added twice", async () => {
    const app = buildServer({ store, keys, catalog: makeCatalog(), http: stubHttp() });

    const first = await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "demo" },
    });
    await app.inject({ method: "PUT", url: "/api/connections/demo/key", payload: { key: "first" } });

    const second = await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "demo" },
    });

    expect(first.json().id).toBe("demo");
    expect(second.json().id).toBe("demo-2");
    // Two Stripe accounts or two repos is a legitimate thing to want, and the
    // first connection's key must survive it.
    expect(keys.get("demo-key")).toBe("first");
    expect(second.json().auth.keyRef).toBe("demo-2-key");
  });

  it("404s an unknown catalog id", async () => {
    const app = buildServer({ store, keys, catalog: makeCatalog(), http: stubHttp() });
    const response = await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "nope" },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("tool schema conversion", () => {
  it("converts the whole proposal schema without hitting an unsupported node", () => {
    // If this throws, the tool schema stopped being flat and would have broken
    // at runtime inside a provider call instead of here.
    const schema = toJsonSchema(proposalSchema);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["title", "component", "rowsPath"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.columns).toMatchObject({ type: "array", items: { type: "string" } });
    expect(schema.properties?.coercions?.items?.type).toBe("object");
  });

  it("carries field descriptions through to the model", () => {
    const schema = toJsonSchema(proposalSchema);
    expect(schema.properties?.ambiguities?.description).toMatch(/Ask rather than guess/);
  });

  it("handles the review schema's array of objects nested in an array of objects", () => {
    /*
     * The relational proposal is one level deeper than anything else here —
     * `proposals[].children[]` — and the converter is a hand-rolled subset. If
     * that recursion is not supported the failure lands inside a provider call
     * at run time, which is a long way from the cause.
     */
    const schema = toJsonSchema(reviewProposalSchema);
    const children = schema.properties?.proposals?.items?.properties?.children;
    expect(children?.type).toBe("array");
    expect(children?.items?.type).toBe("object");
    expect(children?.items?.required).toEqual(["resource", "linkField", "title"]);
    expect(children?.items?.properties?.linkField?.description).toMatch(/parent's id/);
  });
});

describe("dashboard routes", () => {
  const dashboard = {
    id: "d1",
    title: "Demo",
    widgets: [
      {
        id: "w1",
        title: "Items",
        component: "table",
        source: { connection: "api", op: "items" },
        pipeline: [{ op: "extract", path: "$.data[*]" }],
        roles: { columns: ["id"] },
      },
    ],
  };

  it("round-trips a dashboard through disk", async () => {
    const app = makeApp();
    const saved = await app.inject({ method: "PUT", url: "/api/dashboards/d1", payload: dashboard });
    expect(saved.statusCode).toBe(200);

    const loaded = await app.inject({ method: "GET", url: "/api/dashboards/d1" });
    expect(loaded.json()).toMatchObject({ id: "d1", title: "Demo" });
    expect(loaded.json().widgets[0].roles).toEqual({ columns: ["id"] });

    const list = await app.inject({ method: "GET", url: "/api/dashboards" });
    expect(list.json()).toEqual([expect.objectContaining({ id: "d1", widgets: 1 })]);
  });

  it("rejects an invalid spec with flat messages the agent can repair against", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/dashboards/d1",
      payload: {
        ...dashboard,
        widgets: [{ ...dashboard.widgets[0], pipeline: [{ op: "extract", path: "data[*]" }] }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().detail.join()).toMatch(/must start with "\$"/);
  });

  it("deletes a dashboard", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/dashboards/d1", payload: dashboard });
    await app.inject({ method: "DELETE", url: "/api/dashboards/d1" });
    expect((await app.inject({ method: "GET", url: "/api/dashboards/d1" })).statusCode).toBe(404);
  });
});

describe("parts routes", () => {
  const withParts = () =>
    buildServer({
      store,
      keys,
      http: stubHttp(),
      parts: buildPartRegistry({
        stateDir: join(dir, "state"),
        projectDir: join(dir, "project"),
      }),
    });

  it("lists the shipped components, marked as defaults", async () => {
    const app = withParts();
    const response = await app.inject({ method: "GET", url: "/api/parts?kind=component" });

    expect(response.statusCode).toBe(200);
    const parts = response.json() as Array<{ id: string; layer: string; customised: boolean }>;
    expect(parts.map((part) => part.id)).toContain("bar");
    expect(parts.every((part) => part.layer === "builtin" && !part.customised)).toBe(true);
  });

  it("stores a whole override and reports it as customised", async () => {
    const app = withParts();

    const put = await app.inject({
      method: "PUT",
      url: "/api/parts/theme/default",
      payload: { form: "data", title: "Ours", data: { accent: "#c1440e" } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().layer).toBe("user");

    const read = await app.inject({ method: "GET", url: "/api/parts/theme/default" });
    expect(read.json().layer).toBe("user");
    expect(read.json().part.data).toEqual({ accent: "#c1440e" });
  });

  it("reverting drops the override so the default answers again", async () => {
    const app = withParts();
    await app.inject({
      method: "PUT",
      url: "/api/parts/component/bar",
      payload: { form: "data", data: { note: "mine" } },
    });
    expect((await app.inject({ method: "GET", url: "/api/parts/component/bar" })).json().layer).toBe(
      "user",
    );

    const reverted = await app.inject({ method: "DELETE", url: "/api/parts/component/bar" });
    expect(reverted.json().layer).toBe("builtin");
    // The shipped contract is intact — an override never edited it.
    const after = await app.inject({ method: "GET", url: "/api/parts/component/bar" });
    expect(after.json().part.data.contract.id).toBe("bar");
  });

  it("ships a presentation for every component, and for the frame", async () => {
    const app = withParts();
    const response = await app.inject({ method: "GET", url: "/api/parts?kind=presentation" });

    expect(response.statusCode).toBe(200);
    const ids = (response.json() as Array<{ id: string }>).map((part) => part.id);
    // The frame is not a component in the registry, but it is customisable in
    // exactly the same way, so it is published alongside them.
    expect(ids).toContain("widget");
    expect(ids).toContain("table");
    expect(ids).toContain("gauge");
  });

  it("overrides and reverts a presentation, storing only what changed", async () => {
    const app = withParts();

    const put = await app.inject({
      method: "PUT",
      url: "/api/parts/presentation/table",
      payload: { form: "data", data: { density: "compact", settings: { zebra: true } } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().layer).toBe("user");

    const read = await app.inject({ method: "GET", url: "/api/parts/presentation/table" });
    expect(read.json().part.data.density).toBe("compact");

    const reverted = await app.inject({ method: "DELETE", url: "/api/parts/presentation/table" });
    expect(reverted.json().layer).toBe("builtin");
    // Back to the shipped look, and the shipped look was never edited.
    const after = await app.inject({ method: "GET", url: "/api/parts/presentation/table" });
    expect(after.json().part.data.settings.zebra).toBe(false);
  });

  it("refuses a stale write and reports the version it has", async () => {
    // Two writers share this document: a drag saves the whole board, and so
    // does the assistant when it adds a widget. Whichever lands second would
    // otherwise erase the other.
    const app = buildServer({ store, keys, http: stubHttp() });
    const created = await app.inject({
      method: "POST",
      url: "/api/dashboards",
      payload: { title: "Race" },
    });
    const board = created.json();
    // A new board has to leave with a version, or its very first save cannot
    // be guarded against anything.
    expect(board.updatedAt).toBeTruthy();

    const first = await app.inject({
      method: "PUT",
      url: `/api/dashboards/${board.id}`,
      headers: { "if-match": board.updatedAt ?? "" },
      payload: { ...board, title: "Written first" },
    });
    expect(first.statusCode).toBe(200);
    // The response carries the new version, so the caller does not have to
    // re-read the board to learn what to send next time.
    expect(first.json().updatedAt).not.toBe(board.updatedAt);

    const stale = await app.inject({
      method: "PUT",
      url: `/api/dashboards/${board.id}`,
      headers: { "if-match": board.updatedAt ?? "" },
      payload: { ...board, title: "Written second, from an old copy" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().updatedAt).toBe(first.json().updatedAt);

    // The first write survived.
    const read = await app.inject({ method: "GET", url: `/api/dashboards/${board.id}` });
    expect(read.json().title).toBe("Written first");
  });

  it("still accepts a write that names no version", async () => {
    // A script, or a first write, has no version to quote. Last-writer-wins
    // is the right default there rather than an error nobody can act on.
    const app = buildServer({ store, keys, http: stubHttp() });
    const board = (
      await app.inject({ method: "POST", url: "/api/dashboards", payload: { title: "Plain" } })
    ).json();

    const response = await app.inject({
      method: "PUT",
      url: `/api/dashboards/${board.id}`,
      payload: { ...board, title: "Overwritten" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("refuses to accept code over HTTP", async () => {
    // Config and code arrive through different doors: accepting a module
    // reference here would make this endpoint a way to load arbitrary code.
    const app = withParts();
    const response = await app.inject({
      method: "PUT",
      url: "/api/parts/component/evil",
      payload: { form: "code", module: "https://example.com/evil.js" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s an unknown part and 400s an unknown kind", async () => {
    const app = withParts();
    expect((await app.inject({ method: "GET", url: "/api/parts/theme/ghost" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/parts/nonsense/x" })).statusCode).toBe(400);
  });

  it("says so plainly when the server has no registry", async () => {
    const app = buildServer({ store, keys, http: stubHttp() });
    const response = await app.inject({ method: "GET", url: "/api/parts" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/no part registry/);
  });
});

describe("a board per connection", () => {
  it("gives every connection somewhere obvious to put its widgets", async () => {
    store.putConnection(restConnection);
    // Boards are created when the server picks the connection up, so an
    // existing install gets them without anyone doing anything.
    const app = makeApp();

    const board = await app.inject({ method: "GET", url: "/api/dashboards/api" });
    expect(board.statusCode).toBe(200);
    expect(board.json()).toMatchObject({ id: "api", title: "Demo API", widgets: [] });
  });

  it("creates one when a connection is added later", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });

    expect((await app.inject({ method: "GET", url: "/api/dashboards/api" })).statusCode).toBe(200);
  });

  it("never touches a board that already has something on it", async () => {
    const app = makeApp();
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });

    const board = (await app.inject({ method: "GET", url: "/api/dashboards/api" })).json();
    await app.inject({
      method: "PUT",
      url: "/api/dashboards/api",
      payload: {
        ...board,
        title: "Renamed by hand",
        widgets: [
          {
            id: "mine",
            title: "Mine",
            component: "table",
            source: { connection: "api", op: "items" },
            pipeline: [{ op: "extract", path: "$.data" }],
            roles: { columns: ["id"] },
          },
        ],
      },
    });

    // Saving the connection again must not wipe the work on its board.
    await app.inject({ method: "PUT", url: "/api/connections/api", payload: restConnection });

    const after = (await app.inject({ method: "GET", url: "/api/dashboards/api" })).json();
    expect(after.title).toBe("Renamed by hand");
    expect(after.widgets).toHaveLength(1);
  });

  /*
   * Creating from a title alone.
   *
   * `PUT /:id` upserts, so without this every caller has to invent an id —
   * and the nav and the assistant would invent them differently and collide.
   */
  describe("POST /api/dashboards", () => {
    const create = (app: ReturnType<typeof buildServer>, title: unknown) =>
      app.inject({ method: "POST", url: "/api/dashboards", payload: { title } });

    it("slugifies the title into an id", async () => {
      const app = makeApp();
      const response = await create(app, "Finance Overview");
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ id: "finance-overview", title: "Finance Overview" });
    });

    it("suffixes rather than overwriting an existing board", async () => {
      const app = makeApp();
      await create(app, "Finance");
      const second = await create(app, "Finance");
      expect(second.json().id).toBe("finance-2");

      const list = (await app.inject({ method: "GET", url: "/api/dashboards" })).json();
      expect(list).toHaveLength(2);
    });

    it("starts empty, with the schema's defaults filled in", async () => {
      const app = makeApp();
      const board = (await create(app, "Blank")).json();
      expect(board.widgets).toEqual([]);
      expect(board.layout.cells).toEqual([]);
      expect(board.params.defaultRange).toBeDefined();
    });

    it("refuses a title that is only whitespace", async () => {
      const app = makeApp();
      const response = await create(app, "   ");
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/title/i);
    });

    it("falls back to a usable id when the title has no letters", async () => {
      const app = makeApp();
      // Slugifying "***" yields nothing; an empty id would fail the schema.
      expect((await create(app, "***")).json().id).toBe("board");
    });
  });
});
