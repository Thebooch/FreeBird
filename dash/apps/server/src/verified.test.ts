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
import {
  MAX_VALIDATION_CANDIDATES,
  catalogEntryToVerify,
  rowsFromBody,
  usableRows,
  validationCandidates,
} from "./verified.js";

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

// ---------------------------------------------------------------------------
// The 403 fallback
// ---------------------------------------------------------------------------

const multiOpConnection = () =>
  connectionSchema.parse({
    id: "api",
    title: "Demo",
    kind: "rest",
    baseUrl: "https://api.example.com",
    catalog: "demo",
    validateOpId: "locked",
    ops: [
      // The unlicensed one the importer picked, first in line.
      { id: "locked", title: "Locked", path: "/locked", rowsPath: "$.data" },
      // Needs a path parameter, so it must never be tried unattended.
      { id: "needs-input", title: "Detail", path: "/things/{{param.id}}", rowsPath: "$.data" },
      { id: "open", title: "Open", path: "/open", rowsPath: "$.data" },
    ],
  });

describe("validationCandidates", () => {
  it("puts the declared endpoint first", () => {
    expect(validationCandidates(multiOpConnection())[0]).toBe("locked");
  });

  it("never offers an endpoint that needs input", () => {
    // Firing a request the caller would have had to fill in is not something
    // an unattended retry may do.
    expect(validationCandidates(multiOpConnection())).not.toContain("needs-input");
  });

  it("offers the remaining callable endpoints as fallbacks", () => {
    expect(validationCandidates(multiOpConnection())).toEqual(["locked", "open"]);
  });

  it("is bounded", () => {
    const many = connectionSchema.parse({
      id: "api",
      title: "Demo",
      kind: "rest",
      baseUrl: "https://api.example.com",
      ops: Array.from({ length: 50 }, (_, i) => ({
        id: `op${i}`,
        title: `Op ${i}`,
        path: `/op${i}`,
        rowsPath: "$.data",
      })),
    });
    // Proving a dialect must never become a sweep of somebody's API.
    expect(validationCandidates(many).length).toBeLessThanOrEqual(MAX_VALIDATION_CANDIDATES);
  });
});

/** Responds per-path, so one endpoint can 403 while another returns rows. */
const routedHttp =
  (routes: Record<string, { status: number; body: unknown }>): HttpFetch =>
  async (url) => {
    const path = new URL(url).pathname;
    const hit = routes[path] ?? { status: 404, body: { error: "not found" } };
    return { status: hit.status, text: JSON.stringify(hit.body), url, header: () => null };
  };

describe("validate falls back past a 403", () => {
  it("moves on and verifies with the endpoint that answers", async () => {
    store.putConnection(multiOpConnection());
    const app = buildServer({
      store,
      keys,
      catalog,
      http: routedHttp({
        "/locked": { status: 403, body: { error: "no module" } },
        "/open": { status: 200, body: { data: [{ id: 1 }] } },
      }),
    });

    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.verified).toBe(true);
    expect(body.validatedOpId).toBe("open");
    expect(body.forbidden).toEqual(["locked"]);
    expect(catalog.get("demo")?.verified).toBe(true);
  });

  it("adopts the endpoint that worked, so the refusal is not paid again", async () => {
    store.putConnection(multiOpConnection());
    const app = buildServer({
      store,
      keys,
      catalog,
      http: routedHttp({
        "/locked": { status: 403, body: {} },
        "/open": { status: 200, body: { data: [{ id: 1 }] } },
      }),
    });

    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(res.json().adoptedValidateOpId).toBe("open");
    expect(store.getConnection("api")?.validateOpId).toBe("open");
  });

  it("still passes without verifying when every endpoint refuses", async () => {
    // The key is proven; the dialect is not. Same reading as before, reached
    // only after the alternatives are exhausted.
    store.putConnection(multiOpConnection());
    const app = buildServer({
      store,
      keys,
      catalog,
      http: routedHttp({
        "/locked": { status: 403, body: {} },
        "/open": { status: 403, body: {} },
      }),
    });

    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.forbidden).toEqual(["locked", "open"]);
    expect(catalog.get("demo")?.verified).toBe(false);
  });

  it("does not keep trying after a bad key", async () => {
    // A 401 is about the credential, not the endpoint — every candidate would
    // fail the same way, and hammering them proves nothing.
    let calls = 0;
    const http: HttpFetch = async (url) => {
      calls += 1;
      return { status: 401, text: "{}", url, header: () => null };
    };
    store.putConnection(multiOpConnection());
    const app = buildServer({ store, keys, catalog, http });

    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(res.statusCode).toBe(401);
    expect(calls).toBe(1);
  });

  it("keeps going past an endpoint-specific failure that is not a refusal", async () => {
    // Buildium showed why: three 403s and a 422 stood between the importer'''s
    // choice and the endpoint that actually worked. Stopping at any of them
    // left the dialect unprovable.
    store.putConnection(multiOpConnection());
    const app = buildServer({
      store,
      keys,
      catalog,
      http: routedHttp({
        "/locked": { status: 403, body: {} },
        "/open": { status: 200, body: { data: [{ id: 1 }] } },
      }),
    });
    // '''/things/{{param.id}}''' is not a candidate, so /open is reached even
    // though the middle of the list is unusable.
    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    expect(res.json().verified).toBe(true);
  });

  it("reports what it tried when nothing answers", async () => {
    store.putConnection(multiOpConnection());
    const app = buildServer({
      store,
      keys,
      catalog,
      http: routedHttp({
        "/locked": { status: 403, body: {} },
        "/open": { status: 422, body: {} },
      }),
    });

    const res = await app.inject({ method: "POST", url: "/api/connections/api/validate" });
    const body = res.json();
    expect(body.ok).toBe(false);
    // Both kinds of failure are named, so the reason is diagnosable.
    expect(body.forbidden).toEqual(["locked"]);
    expect(body.failed).toEqual(["open"]);
    expect(body.tried).toBe(2);
  });
});
