import { describe, expect, it, vi } from "vitest";
import { integrationDefinitionSchema, type IntegrationDefinition } from "@freebirdai/dash-spec";
import { IntegrationReadSession, recordReference, type IntegrationReadDeps } from "./read.js";

const fixture = (): IntegrationDefinition => integrationDefinitionSchema.parse({
  id: "service", version: "one", title: "Service", protocol: "rest", schemaFingerprint: "abc", origin: "prepared",
  operations: ["get_work", "get_supplier", "list_work", "list_supplier"].map(id => ({ id, title: id, path: `/${id}` })),
  entities: ["work", "supplier"].map(id => ({
    id, title: id, listOp: `list_${id}`, detail: { op: `get_${id}`, inputs: [{ param: "id", field: "id" }] },
    identity: [{ name: "id", field: "id" }],
    fields: [{ id: "id", name: "id", kinds: ["string"] }, { id: "supplier", name: "supplier", kinds: ["string"] }],
  })),
  relationships: [{
    id: "assigned", role: "assigned", source: "work", target: "supplier",
    forward: { title: "Assigned supplier", cardinality: "one", status: "verified", evidence: ["forward"], plan: { kind: "request", op: "get_supplier", inputs: [{ param: "id", field: "supplier" }], matches: [{ source: "supplier", target: "id" }], maxRows: 1 } },
    reverse: { title: "Assigned work", cardinality: "many", status: "verified", evidence: ["reverse"], plan: { kind: "request", op: "list_work", inputs: [{ param: "supplier", field: "id" }], matches: [{ source: "id", target: "supplier" }] } },
  }],
  evidence: ["forward", "reverse"].map(direction => ({ id: direction, claim: "relationship", subject: `assigned:${direction}`, status: "passed", source: "fixture", distinctCases: 3, contractFingerprint: "abc", code: "identities-match" })),
});
const complete = { status: "complete" as const, scope: "query" as const, reason: "Exhausted." };
const setup = (definition = fixture(), rows?: Record<string, unknown>[]) => {
  const fetch = vi.fn<IntegrationReadDeps["fetch"]>(async (_ctx, _connection, op, inputs) => ({
    rows: rows ?? (op === "get_supplier" ? [{ id: inputs.id, name: "Supplier" }]
      : op === "get_work" ? [{ id: inputs.id, supplier: "s1" }]
      : [{ id: "w1", supplier: inputs.supplier }, { id: "w2", supplier: inputs.supplier }]),
    completeness: complete,
  }));
  const authorize = vi.fn(async () => true);
  const deps = {
    load: vi.fn(async (tenant: string, connection: string) => tenant === "a" ? { definition, binding: { connection, integration: "service", version: "one", revision: 1, context: {}, disabledRelationships: [] } } : null),
    authorize, fetch,
  };
  return { session: new IntegrationReadSession(deps, { tenant: "a", authorizationRevision: "v1", maxRequests: 20, maxRows: 100 }), fetch, authorize, deps };
};

describe("shared record relationships", () => {
  it("navigates a forward link, its reverse, and another record without widget setup", async () => {
    const { session, fetch } = setup();
    const supplier = await session.follow({ connection: "account", entity: "work", keys: { id: "w1" }, context: {} }, "assigned", "forward");
    expect(supplier.status).toBe("ok");
    if (supplier.status !== "ok") return;
    const reverse = await session.follow(supplier.data.records[0]!.ref!, "assigned", "reverse");
    expect(reverse.status).toBe("ok");
    if (reverse.status !== "ok") return;
    expect(reverse.data.records).toHaveLength(2);
    expect((await session.read(reverse.data.records[1]!.ref!)).values.id).toBe("w2");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect((await session.describe("account", "supplier")).relationships[0]?.direction).toBe("reverse");
  });
  it("deduplicates reference reads without multiplying primary records", async () => {
    const { session, fetch } = setup();
    const rows = [{ id: "w1", supplier: "s1" }, { id: "w2", supplier: "s1" }, { id: "w3", supplier: null }];
    const enriched = await session.enrich("account", "work", rows, "assigned");
    expect(enriched.map(row => row.record)).toEqual(rows);
    expect(enriched.map(row => row.related.status)).toEqual(["ok", "ok", "absent"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not hide duplicate targets behind a one-row display limit", async () => {
    const { session } = setup(fixture(), [{ id: "s1" }, { id: "s1" }]);
    expect((await session.enrich("account", "work", [{ supplier: "s1" }], "assigned"))[0]?.related.status).toBe("ambiguous");
  });
  it("rejects ignored relationship filters instead of linking unrelated records", async () => {
    const { session } = setup(fixture(), [{ id: "other", supplier: "s2" }]);
    expect((await session.enrich("account", "supplier", [{ id: "s1" }], "assigned", "reverse"))[0]?.related.status).toBe("invalid");
  });
  it("does not read a known but unavailable inverse", async () => {
    const definition = fixture();
    definition.relationships[0]!.reverse = { ...definition.relationships[0]!.reverse, status: "unverified", plan: { kind: "unavailable", reason: "No reverse endpoint." } };
    const { session, fetch } = setup(definition);
    expect((await session.enrich("account", "supplier", [{ id: "s1" }], "assigned", "reverse"))[0]?.related.status).toBe("unsupported");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves identity types and requires composite parent context", () => {
    const entity = fixture().entities[0]!;
    entity.identity = [{ name: "id", field: "key.id" }, { name: "kind", field: "kind" }];
    entity.context = [{ name: "parent", field: "parent" }];
    expect(recordReference("account", entity, { key: { id: 0 }, kind: "task" })).toBeNull();
    expect(recordReference("account", entity, { key: { id: 0 }, kind: "task", parent: "01" })).toMatchObject({ keys: { id: 0, kind: "task" }, context: { parent: "01" } });
  });
  it("keeps accounts separate and checks access before reusing requests", async () => {
    const { session, fetch, authorize } = setup();
    await session.enrich("one", "work", [{ supplier: "s1" }], "assigned");
    await session.enrich("two", "work", [{ supplier: "s1" }], "assigned");
    expect(fetch).toHaveBeenCalledTimes(2);
    authorize.mockResolvedValue(false);
    expect((await session.enrich("one", "work", [{ supplier: "s1" }], "assigned"))[0]?.related.status).toBe("denied");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("preserves partial scope when matching a bounded lookup", async () => {
    const definition = fixture();
    definition.relationships[0]!.reverse.plan = { kind: "bounded-match", op: "list_work", matches: [{ source: "id", target: "supplier", sourceArray: false, targetArray: false }], maxRows: 10 };
    const { deps } = setup(definition);
    const session = new IntegrationReadSession({ ...deps, fetch: async () => ({ rows: [{ id: "w1", supplier: "another" }], completeness: { status: "partial", scope: "loaded-records", reason: "Page cap." } }) }, { tenant: "a", authorizationRevision: "v1", maxRequests: 2, maxRows: 10 });
    const result = (await session.enrich("account", "supplier", [{ id: "s1" }], "assigned", "reverse"))[0]!.related;
    expect(result).toMatchObject({ status: "ok", data: { records: [], completeness: { status: "partial" } } });
  });
});
