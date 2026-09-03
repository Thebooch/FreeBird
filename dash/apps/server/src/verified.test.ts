import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import { catalogEntrySchema, connectionSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "./catalog.js";
import { buildServer } from "./server.js";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";
import { catalogEntryToVerify, rowsFromBody, usableRows } from "./verified.js";

// ---------------------------------------------------------------------------
// The rule, in isolation
// ---------------------------------------------------------------------------

describe("usableRows", () => {
  it("rejects nothing at all", () => {
    expect(usableRows([])).toBe(false);
  });

  it("accepts a list of records", () => {
    expect(usableRows([{ id: 1 }, { id: 2 }])).toBe(true);
  });

  it("accepts a single object with fields — the summary archetype", () => {
    expect(usableRows([{ balance: 42 }])).toBe(true);
  });

  it("rejects a single empty object, which proves nothing", () => {
    expect(usableRows([{}])).toBe(false);
  });

  it("rejects a single null", () => {
    expect(usableRows([null])).toBe(false);
    expect(usableRows([undefined])).toBe(false);
  });

  it("accepts a scalar row", () => {
    expect(usableRows([7])).toBe(true);
  });
});

describe("rowsFromBody", () => {
  it("reads the dialect's own rowsPath", () => {
    expect(rowsFromBody({ data: [{ id: 1 }] }, "$.data")).toEqual([{ id: 1 }]);
  });

  it("returns nothing when the path does not resolve", () => {
    // A wrong rowsPath is exactly the case verification must not pass.
    expect(rowsFromBody({ results: [{ id: 1 }] }, "$.data")).toEqual([]);
  });

  it("treats the whole body as the row when no path is declared", () => {
    expect(rowsFromBody({ balance: 1 }, undefined)).toEqual([{ balance: 1 }]);
    expect(rowsFromBody([{ id: 1 }], undefined)).toEqual([{ id: 1 }]);
  });

  it("does not throw on a malformed path", () => {
    expect(rowsFromBody({ a: 1 }, "$[[[")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const entry = (over: Record<string, unknown> = {}) =>
  catalogEntrySchema.parse({
    id: "demo",
    title: "Demo",
    baseUrl: "https://api.example.com",
    dialect: { rowsPath: "$.data" },
    ...over,
  });

const conn = (over: Record<string, unknown> = {}) =>
  connectionSchema.parse({
    id: "api",
    title: "Demo",
    kind: "rest",
    baseUrl: "https://api.example.com",
    catalog: "demo",
    ops: [{ id: "items", title: "Items", path: "/items", rowsPath: "$.data" }],
    validateOpId: "items",
    ...over,
  });

describe("catalogEntryToVerify", () => {
  const op = { rowsPath: "$.data" };

  it("verifies when rows came back where the dialect said", () => {
    expect(
      catalogEntryToVerify({
        connection: conn(),
        op,
        body: { data: [{ id: 1 }] },
        entry: entry(),
      }),
    ).toBe("demo");
  });

  it("does not verify an empty result", () => {
    expect(
      catalogEntryToVerify({ connection: conn(), op, body: { data: [] }, entry: entry() }),
    ).toBeNull();
  });

  it("does not verify when rowsPath was wrong", () => {
    expect(
      catalogEntryToVerify({
        connection: conn(),
        op,
        body: { results: [{ id: 1 }] },
        entry: entry(),
      }),
    ).toBeNull();
  });

  it("does nothing for a connection built from no catalog entry", () => {
    expect(
      catalogEntryToVerify({
        connection: conn({ catalog: undefined }),
        op,
        body: { data: [{ id: 1 }] },
        entry: entry(),
      }),
    ).toBeNull();
  });

  it("never touches an entry the connection did not come from", () => {
    expect(
      catalogEntryToVerify({
        connection: conn({ catalog: "demo" }),
        op,
        body: { data: [{ id: 1 }] },
        entry: entry({ id: "somethingelse" }),
      }),
    ).toBeNull();
  });

  it("is a no-op once already verified", () => {
    expect(
      catalogEntryToVerify({
        connection: conn(),
        op,
        body: { data: [{ id: 1 }] },
        entry: entry({ verified: true }),
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Through the route
// ---------------------------------------------------------------------------

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;

const seedCatalog = (): CatalogStore => {
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "demo.json"), JSON.stringify(entry()), "utf8");
  return new CatalogStore(seed, join(dir, ".dash", "catalog"));
};

const stubHttp =
  (body: unknown, status = 200): HttpFetch =>
  async (url) => ({ status, text: JSON.stringify(body), url, header: () => null });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-verified-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  catalog = seedCatalog();
  store.putConnection(conn());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("validate flips verified", () => {
  it("verifies when a live request returns rows", async () => {
    const app = buildServer({ store, keys, catalog, http: stubHttp({ data: [{ id: 1 }] }) });
    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });

    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
    expect(catalog.get("demo")?.verified).toBe(true);
    // Written to the overlay, never back over the shipped seed: the seed file
    // on disk still says what it always said.
    expect(JSON.parse(readFileSync(join(dir, "seed", "demo.json"), "utf8")).verified).toBe(false);
  });

  it("does not verify when the response is empty", async () => {
    const app = buildServer({ store, keys, catalog, http: stubHttp({ data: [] }) });
    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });

    expect(res.json().verified).toBe(false);
    expect(catalog.get("demo")?.verified).toBe(false);
  });

  it("does NOT verify on the 403 pass — a working key is not a proven dialect", async () => {
    const app = buildServer({ store, keys, catalog, http: stubHttp({ error: "nope" }, 403) });
    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });

    // The 403 branch still reports success: the credential is proven.
    expect(res.json().ok).toBe(true);
    // But nothing about the envelope was learned.
    expect(catalog.get("demo")?.verified).toBe(false);
  });

  it("does not verify when the request fails outright", async () => {
    const app = buildServer({ store, keys, catalog, http: stubHttp({ error: "boom" }, 500) });
    await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(catalog.get("demo")?.verified).toBe(false);
  });

  it("is a no-op when no catalog is configured", async () => {
    const app = buildServer({ store, keys, http: stubHttp({ data: [{ id: 1 }] }) });
    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(res.json().ok).toBe(true);
    expect(res.json().verified).toBe(false);
  });
});
