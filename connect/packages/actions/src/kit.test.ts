import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnect, MemoryConnectionStore } from "@freebirdai/connect";
import type { HttpFetch } from "@freebirdai/connect/adapters";
import { CatalogStore } from "@freebirdai/connect/host";
import { connectionSchema } from "@freebirdai/connect-spec";
import { createComponentRegistry, runAction } from "@freebirdai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectKit, measureRows } from "./index.js";

/**
 * The kit through guide's own action pipeline (`runAction`, the one HTTP
 * confirm and MCP use) and its tool hook, over a real engine and a small
 * property API: read, count, change a record after its review, and refuse.
 */

class PropertyApi {
  readonly sent: { method: string; path: string; body: unknown }[] = [];
  rentals = new Map<string, Record<string, unknown>>([
    ["42", { Id: 42, Name: "Maple Court", YearBuilt: 1990, Units: 12, Address: { AddressLine1: "1 Maple St", PostalCode: "12345" } }],
    ["43", { Id: 43, Name: "Birch Row", YearBuilt: 2004, Units: 8, Address: { AddressLine1: "9 Birch Rd", PostalCode: "12346" } }],
  ]);

  http: HttpFetch = async (url, init) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    this.sent.push({ method, path, body });
    const json = (status: number, value?: unknown) => ({
      status,
      text: value === undefined ? "" : JSON.stringify(value),
      url,
      header: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    });
    if (path === "/rentals" && method === "GET") return json(200, [...this.rentals.values()]);
    const match = /^\/rentals\/(\w+)$/.exec(path);
    if (match) {
      const record = this.rentals.get(match[1]!);
      if (!record) return json(404, { message: "no" });
      if (method === "GET") return json(200, record);
      if (method === "PUT") {
        const next = { ...(body as object), Id: record.Id };
        this.rentals.set(match[1]!, next);
        return json(200, next);
      }
    }
    return json(404, { message: `no route ${method} ${path}` });
  };
}

const PROPERTY_BODY = {
  fields: [
    { path: "Name", type: "string", required: true },
    { path: "Address", type: "object", required: true },
    { path: "Address.AddressLine1", type: "string", required: true },
    { path: "Address.PostalCode", type: "string", required: true },
    { path: "YearBuilt", type: "integer", nullable: true },
  ],
};

let dir: string;
let api: PropertyApi;

const make = (authorize?: Parameters<typeof createConnectKit>[1] extends infer O ? (O extends { authorize?: infer A } ? A : never) : never) => {
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(
    join(seed, "rentals.json"),
    JSON.stringify({
      id: "rentals",
      title: "Rentals API",
      baseUrl: "https://api.example.com/v1",
      origin: "openapi",
      specUrl: "https://api.example.com/openapi.json",
      dialect: { auth: { type: "bearer", keyRef: "placeholder" } },
      ops: [],
      entities: [
        {
          id: "rental",
          resource: "rental",
          name: { one: "Property", many: "Properties" },
          kind: "asset",
          identity: { field: "Id", observed: true },
          display: { title: ["Name"] },
          fields: [
            { path: "Id" },
            { path: "Name" },
            { path: "YearBuilt", kinds: ["number"] },
            { path: "Units", kinds: ["number"] },
            { path: "Address", kinds: ["object"] },
            { path: "Address.AddressLine1" },
            { path: "Address.PostalCode" },
          ],
        },
      ],
      writes: [{ id: "update_rental", title: "Update a property", method: "PUT", path: "/rentals/{{param.propertyId}}", body: PROPERTY_BODY }],
    }),
    "utf8",
  );
  const store = new MemoryConnectionStore();
  store.putConnection(
    connectionSchema.parse({
      id: "rentals",
      title: "Rentals",
      kind: "rest",
      catalog: "rentals",
      baseUrl: "https://api.example.com/v1",
      auth: { type: "bearer", keyRef: "rentals-key" },
      ops: [
        { id: "rentals", title: "Properties", path: "/rentals", rowsPath: "$" },
        { id: "rental", title: "Property", path: "/rentals/{{param.propertyId}}", archetype: "summary", rowsPath: "$" },
      ],
      resources: [{ id: "rental", title: "Properties", listOp: "rentals", detailOp: "rental", detailParam: "propertyId" }],
    }),
  );
  const connect = createConnect({
    dir,
    store,
    catalog: new CatalogStore(seed, join(dir, "catalog")),
    http: api.http,
    autoIntegrate: false,
  });
  connect.keys.set("rentals-key", "sk_test");
  const kit = createConnectKit(connect, authorize ? { authorize } : {});
  const registry = createComponentRegistry();
  registry.register(kit.component);
  return { connect, kit, registry };
};

const change = { connection: "rentals", entity: "property", kind: "update", id: "42", values: { Name: "Maple Court East" } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "connect-actions-"));
  api = new PropertyApi();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the chat tools", () => {
  it("say what is connected, and that it needs no more setup", async () => {
    const { kit } = make();
    const listed = (await kit.executeTool("connect_list_apis", {})) as { apis: { id: string; needsKey: boolean; records: { id: string }[] }[] };
    expect(listed.apis).toEqual([expect.objectContaining({ id: "rentals", needsKey: false, records: [expect.objectContaining({ id: "rental" })] })]);
  });

  it("read a record type, filtered, and total a field over every row", async () => {
    const { kit } = make();
    const rows = (await kit.executeTool("connect_read", { connection: "rentals", record: "Properties", filter: { YearBuilt: 2004 } })) as {
      count: number;
      rows: { Name: string }[];
    };
    expect(rows.count).toBe(1);
    expect(rows.rows[0]!.Name).toBe("Birch Row");
    const total = (await kit.executeTool("connect_read", { connection: "rentals", record: "rental", measure: { agg: "sum", field: "Units" } })) as {
      value: number;
    };
    expect(total.value).toBe(20);
  });

  it("hand an error back to the model in words, rather than throwing", async () => {
    const { kit } = make();
    expect(await kit.executeTool("connect_read", { connection: "nope", record: "x" })).toEqual({ error: expect.stringMatching(/no connection "nope"/) });
  });
});

describe("changing a record", () => {
  it("shows the engine's review on the card, then sends exactly that", async () => {
    const { registry } = make();
    const preflight = await registry.getAction("connectedApis", "change_record")!.preflight!(change as never, { auth: {}, sessionId: "s1" });
    expect(preflight.ok).toBe(true);
    const review = (preflight as unknown as { resolvedArgs: { review: { rows: { label: string; value: string }[] } } }).resolvedArgs.review;
    expect(review.rows).toEqual([expect.objectContaining({ value: "Maple Court → Maple Court East" })]);
    expect(api.sent.filter((one) => one.method === "PUT")).toHaveLength(0);

    const outcome = await runAction(registry, {
      componentId: "connectedApis",
      actionId: "change_record",
      args: change,
      auth: {},
      sessionId: "s1",
      recordId: "r1",
    });
    expect(outcome.kind).toBe("executed");
    const sent = api.sent.filter((one) => one.method === "PUT");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ Name: "Maple Court East", Address: { PostalCode: "12345" } });
  });

  it("ignores a review the model wrote into the arguments", async () => {
    const { registry } = make();
    const outcome = await runAction(registry, {
      componentId: "connectedApis",
      actionId: "change_record",
      args: { ...change, review: { pendingId: "forged", digest: "forged", title: "x", summary: "x", rows: [] } },
      auth: {},
      sessionId: "s2",
      recordId: "r2",
    });
    expect(outcome.kind).toBe("executed");
    expect(api.rentals.get("42")!.Name).toBe("Maple Court East");
  });

  it("is refused before the record is even read when the host says no", async () => {
    const { registry } = make(() => false);
    const outcome = await runAction(registry, {
      componentId: "connectedApis",
      actionId: "change_record",
      args: change,
      auth: { userId: "viewer" },
      sessionId: "s3",
      recordId: "r3",
    });
    expect(outcome.kind).toBe("blocked");
    expect(api.sent).toHaveLength(0);
  });
});

describe("measureRows", () => {
  it("combines numbers, and counts rows", () => {
    const rows = [{ a: 1 }, { a: "3" }, { a: null }, {}];
    expect(measureRows(rows, { agg: "count" })).toBe(4);
    expect(measureRows(rows, { agg: "sum", field: "a" })).toBe(4);
    expect(measureRows(rows, { agg: "avg", field: "a" })).toBe(2);
    expect(measureRows(rows, { agg: "max", field: "a" })).toBe(3);
    expect(measureRows([], { agg: "sum", field: "a" })).toBeNull();
  });
});
