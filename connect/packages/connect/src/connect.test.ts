import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpFetch } from "./adapters/index.js";
import { type ConnectEvent, createConnect, freshness } from "./connect.js";

/**
 * The engine on its own: no Dash, no server, no database. An API is added
 * from its OpenAPI document, given a key, and read — by endpoint and by
 * filter — through the same adapters, cache and gate Dash uses.
 */

const SPEC = {
  openapi: "3.0.0",
  info: { title: "Leasebook", version: "1.0.0" },
  servers: [{ url: "https://api.leasebook.test/v1" }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
  security: [{ key: [] }],
  paths: {
    "/tenants": {
      get: {
        operationId: "listTenants",
        summary: "List tenants",
        responses: {
          "200": {
            description: "Tenants",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" } },
                      },
                    },
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

const TENANTS = [
  { id: "t1", name: "Ada", status: "late" },
  { id: "t2", name: "Grace", status: "current" },
  { id: "t3", name: "Edsger", status: "late" },
];

let dir: string;
let requests: Array<{ url: string; headers: Record<string, string> }>;

const http: HttpFetch = async (url, init) => {
  requests.push({ url, headers: { ...init.headers } });
  const authorised = init.headers?.["x-api-key"] === "secret";
  const body = authorised ? { data: TENANTS } : { error: "no key" };
  return {
    status: authorised ? 200 : 401,
    text: JSON.stringify(body),
    url,
    header: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null),
  };
};

const fetchDocument = async (url: string) => ({ status: 200, text: JSON.stringify(SPEC), url });

const make = () => createConnect({ dir, http, fetchDocument, autoIntegrate: false });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "connect-test-"));
  requests = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createConnect", () => {
  it("adds an API from its OpenAPI document and says it needs a key", async () => {
    const connect = make();
    const api = await connect.connections.add({ from: "https://api.leasebook.test/openapi.json" });
    expect(api.ops.map((op) => op.path)).toContain("/tenants");
    expect(connect.connections.status(api.id).needsKey).toBe(true);
    expect(requests).toEqual([]);
  });

  it("reads an endpoint once it has a key, and filters the rows", async () => {
    const connect = make();
    const api = await connect.connections.add({ from: "https://api.leasebook.test/openapi.json" });
    await connect.connections.setKey(api.id, "secret");
    expect(connect.connections.status(api.id).needsKey).toBe(false);

    const all = await connect.read(api.id, { op: "listTenants" });
    expect(all.rows).toHaveLength(3);
    expect(requests[0]?.url).toBe("https://api.leasebook.test/v1/tenants");
    expect(requests[0]?.headers["x-api-key"]).toBe("secret");

    const late = await connect.read(api.id, { op: "listTenants", filter: { status: "late" } });
    expect(late.rows.map((row) => (row as { name: string }).name)).toEqual(["Ada", "Edsger"]);
    /* Fresh enough: answered from the cache, not the API. */
    expect(late.cache).toBe("hit");
    expect(requests).toHaveLength(1);
  });

  it("asks the API again when the answer is older than the read allows", async () => {
    const connect = make();
    const api = await connect.connections.add({ from: "https://api.leasebook.test/openapi.json" });
    await connect.connections.setKey(api.id, "secret");
    await connect.read(api.id, { op: "listTenants" });
    await connect.read(api.id, { op: "listTenants", fresh: 0 });
    expect(requests).toHaveLength(2);
  });

  it("says what happened, and why a read failed", async () => {
    const connect = make();
    const events: ConnectEvent[] = [];
    connect.on((event) => events.push(event));
    const api = await connect.connections.add({ from: "https://api.leasebook.test/openapi.json" });
    await expect(connect.read(api.id, { op: "listTenants" })).rejects.toThrow();
    await connect.connections.setKey(api.id, "secret");
    await connect.read(api.id, { op: "listTenants" });
    expect(events.map((event) => event.type)).toEqual(["read-failed", "read"]);
    expect(events[0]).toMatchObject({ connection: api.id, status: 401 });
  });

  it("names the record types it knows when asked for one it does not", async () => {
    const connect = make();
    const api = await connect.connections.add({ from: "https://api.leasebook.test/openapi.json" });
    await expect(connect.read(api.id, { record: "tenant" })).rejects.toThrow(/not mapped yet|no record type/);
  });

  it("refuses connector code without a sandbox", async () => {
    const connect = make();
    await expect(connect.engine.connectors.sandbox.open({ code: "", host: { call: async () => null, now: () => 0, log: () => {} } })).rejects.toThrow(
      /no sandbox is installed/,
    );
  });
});

describe("freshness", () => {
  it("reads durations", () => {
    expect(freshness("30s")).toBe(30_000);
    expect(freshness("5m")).toBe(300_000);
    expect(freshness("1h")).toBe(3_600_000);
    expect(freshness(250)).toBe(250);
    expect(() => freshness("soon")).toThrow();
  });
});
