import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPORT_VERSION, WRITES_VERSION } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogStore, KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { FetchDocument } from "@freebirdai/connect/host";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";

/**
 * Changing records is part of every connection, so nobody has to go and read
 * an API's write endpoints: a connection whose entry never had them read gets
 * them read — from the API's published specification, never its account.
 */

const SPEC_URL = "https://docs.example.com/openapi.json";

const SPEC = {
  openapi: "3.0.0",
  info: { title: "Rentals API", version: "1" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/rentals": {
      get: {
        operationId: "listRentals",
        summary: "List properties",
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Rental" } } } },
          },
        },
      },
      post: {
        operationId: "createRental",
        summary: "Create a property",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["Name"], properties: { Name: { type: "string" } } },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
  components: {
    schemas: { Rental: { type: "object", properties: { Id: { type: "integer" }, Name: { type: "string" } } } },
  },
};

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;
let fetched: string[];
let answer: { status: number; text: string };

const fetchDocument: FetchDocument = async (url) => {
  fetched.push(url);
  return { ...answer, url };
};

const seed = (entry: Record<string, unknown> = {}): void => {
  const at = join(dir, "seed");
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, "rentals.json"),
    JSON.stringify({
      id: "rentals",
      title: "Rentals API",
      baseUrl: "https://api.example.com/v1",
      origin: "openapi",
      specUrl: SPEC_URL,
      importVersion: IMPORT_VERSION,
      dialect: { auth: { type: "bearer", keyRef: "placeholder" } },
      ops: [{ id: "listRentals", title: "List properties", path: "/rentals" }],
      ...entry,
    }),
    "utf8",
  );
  catalog = new CatalogStore(at, join(dir, ".dash", "catalog"));
};

const app = (autoReadWrites?: boolean) =>
  buildServer({ store, keys, catalog, fetchDocument, ...(autoReadWrites !== undefined ? { autoReadWrites } : {}) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-read-writes-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  fetched = [];
  answer = { status: 200, text: JSON.stringify(SPEC) };
  seed();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("reading an API's write endpoints for it", () => {
  it("reads them when a connection is added, with nothing to switch on", async () => {
    const server = app(true);
    const made = await server.inject({ method: "POST", url: "/api/connections/from-catalog", payload: { catalogId: "rentals" } });
    expect(made.statusCode).toBe(200);
    await vi.waitFor(() => expect(catalog.get("rentals")?.writesVersion).toBe(WRITES_VERSION));
    expect(catalog.get("rentals")?.writes.map((op) => [op.method, op.path])).toEqual([["POST", "/rentals"]]);
    expect(fetched).toEqual([SPEC_URL]);
    const writes = (await server.inject({ method: "GET", url: `/api/connections/${made.json().id}/writes` })).json();
    expect(writes.writeOpCount).toBe(1);
    await server.close();
  });

  it("reads them once at startup for a connection added before writes existed, and not again", async () => {
    await app().inject({ method: "POST", url: "/api/connections/from-catalog", payload: { catalogId: "rentals" } });
    expect(fetched).toEqual([]);

    const first = app(true);
    await first.ready();
    await vi.waitFor(() => expect(catalog.get("rentals")?.writesVersion).toBe(WRITES_VERSION));
    await first.close();

    const second = app(true);
    await second.ready();
    await second.close();
    expect(fetched).toEqual([SPEC_URL]);
  });

  it("fetches nothing unless the server was asked to", async () => {
    const server = app();
    await server.inject({ method: "POST", url: "/api/connections/from-catalog", payload: { catalogId: "rentals" } });
    await server.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetched).toEqual([]);
    expect(catalog.get("rentals")?.writesVersion).toBeUndefined();
  });

  it("does not ask again this run for a specification that could not be read", async () => {
    answer = { status: 500, text: "down" };
    const server = app(true);
    await server.inject({ method: "POST", url: "/api/connections/from-catalog", payload: { catalogId: "rentals" } });
    await vi.waitFor(() => expect(fetched).toHaveLength(1));
    await server.inject({ method: "POST", url: "/api/connections/from-catalog", payload: { catalogId: "rentals" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetched).toHaveLength(1);
    expect(catalog.get("rentals")?.writesVersion).toBeUndefined();
    await server.close();
  });

  it("leaves an API that was not read from a specification alone", async () => {
    seed({ origin: "docs", specUrl: undefined });
    const server = app(true);
    await server.inject({ method: "POST", url: "/api/connections/from-catalog", payload: { catalogId: "rentals" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetched).toEqual([]);
    await server.close();
  });
});
