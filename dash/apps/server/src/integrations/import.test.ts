import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalogEntrySchema } from "@freebirdai/dash-spec";
import { integrationFromCatalog, importCatalog } from "./import.js";
import { openIntegrationDb } from "./db.js";

const catalog = () => catalogEntrySchema.parse({
  id: "generic-service", title: "Generic service", baseUrl: "https://example.com", dialect: { rowsPath: "$.items" },
  ops: [
    { id: "work", title: "Work", path: "/work", params: [{ name: "supplier", in: "query" }], fields: [{ name: "id", kinds: ["string"] }, { name: "supplier", kinds: ["string"] }] },
    { id: "supplier", title: "Suppliers", path: "/suppliers", fields: [{ name: "id", kinds: ["string"] }, { name: "name", kinds: ["string"] }] },
    { id: "supplier_detail", title: "Supplier", path: "/suppliers/{{param.id}}", archetype: "summary", fields: [{ name: "id", kinds: ["string"] }, { name: "name", kinds: ["string"] }] },
  ],
  resources: [
    { id: "work", title: "Work", idField: "id", listOp: "work", relations: [{ id: "assigned", title: "Assigned supplier", resource: "supplier", localField: "supplier", cardinality: "one", verified: true }] },
    { id: "supplier", title: "Supplier", idField: "id", labelField: "name", listOp: "supplier", detailOp: "supplier_detail", detailParam: "id" },
  ],
});

describe("catalog migration", () => {
  let database: Awaited<ReturnType<typeof openIntegrationDb>>;
  beforeAll(async () => { database = await openIntegrationDb({ inMemory: true }); });
  afterAll(async () => { await database?.close(); });
  it("preserves contracts and both roles without treating legacy verification as proof", () => {
    const definition = integrationFromCatalog(catalog());
    expect(definition.operations.find(op => op.id === "work")?.rowsPath).toBe("$.items");
    expect(definition.relationships[0]).toMatchObject({ forward: { status: "unverified", plan: { kind: "request", op: "supplier_detail" } }, reverse: { status: "unverified", plan: { kind: "request", op: "work" } } });
    expect(definition.entities.find(entity => entity.id === "supplier")?.view.related).toHaveLength(1);
    expect(definition.evidence).toEqual([]);
  });
  it("is repeatable and pins accounts to their original version", async () => {
    const repo = database.repository;
    const connections = [{ id: "account-one", catalog: "generic-service" }, { id: "account-two", catalog: "generic-service" }];
    expect(await importCatalog(repo, "tenant", [catalog()], connections)).toMatchObject({ imported: 1, bound: 2, errors: [] });
    const first = await repo.getBinding("tenant", "account-one");
    expect(await importCatalog(repo, "tenant", [catalog()], connections)).toMatchObject({ imported: 1, bound: 0, errors: [] });
    const changed = catalog(); changed.ops[0]!.path = "/v2/work";
    expect(integrationFromCatalog(changed).version).not.toBe(first!.binding.version);
    await importCatalog(repo, "tenant", [changed], connections);
    expect((await repo.getBinding("tenant", "account-one"))?.binding.version).toBe(first!.binding.version);
    expect(await repo.listVersions("tenant")).toHaveLength(2);
  });
});
