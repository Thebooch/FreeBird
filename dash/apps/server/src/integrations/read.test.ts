import { describe, expect, it, vi } from "vitest";
import { integrationDefinitionSchema, type IntegrationDefinition } from "@freebirdai/dash-spec";
import { IntegrationReadSession, recordReference, type IntegrationReadDeps } from "./read.js";

const fixture = (): IntegrationDefinition =>
  integrationDefinitionSchema.parse({
    id: "service",
    version: "one",
    title: "Service",
    protocol: "rest",
    schemaFingerprint: "abc",
    origin: "prepared",
    operations: ["get_work", "get_supplier", "list_work", "list_supplier"].map((id) => ({
      id,
      title: id,
      path: `/${id}`,
    })),
    entities: ["work", "supplier"].map((id) => ({
      id,
      title: id,
      listOp: `list_${id}`,
      detail: { op: `get_${id}`, inputs: [{ param: "id", field: "id" }] },
      identity: [{ name: "id", field: "id" }],
      fields: [
        { id: "id", name: "id", kinds: ["string"] },
        { id: "supplier", name: "supplier", kinds: ["string"] },
      ],
    })),
    relationships: [
      {
        id: "assigned",
        role: "assigned",
        source: "work",
        target: "supplier",
        forward: {
          title: "Assigned supplier",
          cardinality: "one",
          status: "verified",
          evidence: ["forward"],
          plan: {
            kind: "request",
            op: "get_supplier",
            inputs: [{ param: "id", field: "supplier" }],
            matches: [{ source: "supplier", target: "id" }],
            maxRows: 1,
          },
        },
        reverse: {
          title: "Assigned work",
          cardinality: "many",
          status: "verified",
          evidence: ["reverse"],
          plan: {
            kind: "request",
            op: "list_work",
            inputs: [{ param: "supplier", field: "id" }],
            matches: [{ source: "id", target: "supplier" }],
          },
        },
      },
    ],
    evidence: ["forward", "reverse"].map((direction) => ({
      id: direction,
      claim: "relationship",
      subject: `assigned:${direction}`,
      status: "passed",
      source: "fixture",
      distinctCases: 3,
      contractFingerprint: "abc",
      code: "identities-match",
    })),
  });
const complete = { status: "complete" as const, scope: "query" as const, reason: "Exhausted." };
const setup = (definition = fixture(), rows?: Record<string, unknown>[]) => {
  const fetch = vi.fn<IntegrationReadDeps["fetch"]>(async (_ctx, _connection, op, inputs) => ({
    rows:
      rows ??
      (op === "get_supplier"
        ? [{ id: inputs.id, name: "Supplier" }]
        : op === "get_work"
          ? [{ id: inputs.id, supplier: "s1" }]
          : [
              { id: "w1", supplier: inputs.supplier },
              { id: "w2", supplier: inputs.supplier },
            ]),
    completeness: complete,
  }));
  const authorize = vi.fn<IntegrationReadDeps["authorize"]>(async () => true);
  const deps = {
    load: vi.fn(async (tenant: string, connection: string) =>
      tenant === "a"
        ? {
            definition,
            binding: {
              connection,
              integration: "service",
              version: "one",
              revision: 1,
              context: {},
              disabledRelationships: [],
            },
          }
        : null,
    ),
    authorize,
    fetch,
  };
  return {
    session: new IntegrationReadSession(deps, {
      tenant: "a",
      authorizationRevision: "v1",
      maxRequests: 20,
      maxRows: 100,
    }),
    fetch,
    authorize,
    deps,
  };
};

describe("shared record relationships", () => {
  it("does not use hidden fields or unresolved reference keys as record titles", async () => {
    const definition = fixture();
    const work = definition.entities[0]!;
    work.labelField = "supplier";
    const reference = { connection: "account", entity: "work", keys: { id: "w1" }, context: {} };
    expect((await setup(definition).session.page(reference)).title).toBe("work");
    work.labelField = "secret";
    work.fields.push({
      id: "secret",
      name: "secret",
      kinds: ["string"],
      nullable: false,
      provenance: "declared",
      visibility: "hidden",
    });
    const { session } = setup(definition, [{ id: "w1", supplier: null, secret: "private label" }]);
    const page = await session.page(reference);
    expect(page.title).toBe("work");
    expect(page.fields.some((field) => field.id === "secret")).toBe(false);
  });

  it("allows authorized detail navigation without granting collection access", async () => {
    const { session, authorize, fetch } = setup();
    authorize.mockImplementation(async (_scope, _connection, _entity, op) => op.startsWith("get_"));
    expect(await session.discover("account")).toEqual([
      expect.objectContaining({ id: "work", browsable: false }),
      expect.objectContaining({ id: "supplier", browsable: false }),
    ]);
    const page = await session.page({
      connection: "account",
      entity: "work",
      keys: { id: "w1" },
      context: {},
    });
    expect(page.references[0]?.result.status).toBe("ok");
    await expect(session.browse("account", "work")).rejects.toMatchObject({ code: "denied" });
    expect(fetch.mock.calls.some((call) => call[2].startsWith("list_"))).toBe(false);
  });

  it("derives optional loaded-record filters from recipes without exposing identity filters", async () => {
    const definition = fixture();
    const work = definition.entities[0]!;
    work.fields.push({
      id: "state",
      name: "state",
      label: "Status",
      description: "Current progress.",
      kinds: ["string"],
      nullable: false,
      provenance: "declared",
      visibility: "normal",
    });
    work.view.filters = ["id", "supplier", "state"];
    const { session, fetch } = setup(definition);
    fetch.mockResolvedValue({
      rows: [{ id: "w1", supplier: null, state: "open" }],
      completeness: { ...complete, status: "partial" },
    });
    const collection = await session.browse("account", "work");
    expect(collection.filters).toEqual([
      { field: "state", label: "Status", description: "Current progress." },
    ]);
    expect(collection.completeness.status).toBe("partial");
    expect(collection.records).toHaveLength(1);
    expect(fetch.mock.calls[0]?.[3]).toEqual({});
  });

  it("builds reusable entity pages with readable references and lazy reverse collections", async () => {
    const definition = fixture();
    for (const entity of definition.entities) {
      entity.fields.push({
        id: "name",
        name: "name",
        label: "Name",
        description: "The record's readable title.",
        kinds: ["string"],
        nullable: false,
        provenance: "declared",
        visibility: "normal",
      });
      entity.labelField = "name";
    }
    const { session, fetch } = setup(definition);
    const ref = { connection: "account", entity: "work", keys: { id: "w1" }, context: {} };
    const page = await session.page(ref);
    expect(page.references[0]?.result.records[0]?.title).toBe("Supplier");
    expect(page.fields.find((field) => field.id === "supplier")?.advanced).toBe(true);
    expect(page.fields.find((field) => field.id === "id")?.advanced).toBe(true);
    expect(JSON.stringify(page)).not.toContain('"plan"');
    expect(fetch.mock.calls.some((call) => call[2] === "list_work")).toBe(false);
    const supplier = page.references[0]!.result.records[0]!.ref!;
    const supplierPage = await session.page(supplier);
    expect(supplierPage.relationships).toContainEqual(
      expect.objectContaining({ relationship: "assigned", direction: "reverse", available: true }),
    );
    expect(fetch.mock.calls.some((call) => call[2] === "list_work")).toBe(false);
    const related = await session.related(supplier, "assigned", "reverse");
    expect(related.status).toBe("ok");
    expect(related.records).toHaveLength(2);
    const next = await session.page(related.records[1]!.ref!);
    expect(next.ref?.keys.id).toBe("w2");
    expect(next.relationships).toEqual(page.relationships);
  });

  it("enriches browsing without exposing raw reference IDs or multiplying rows", async () => {
    const definition = fixture();
    const supplier = definition.entities.find((entity) => entity.id === "supplier")!;
    supplier.labelField = "name";
    supplier.fields.push({
      id: "name",
      name: "name",
      kinds: ["string"],
      nullable: false,
      provenance: "declared",
      visibility: "normal",
    });
    const { session, fetch } = setup(definition);
    const normal = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (...args) =>
      args[2] === "list_work"
        ? {
            rows: [
              { id: "w1", supplier: "s1" },
              { id: "w2", supplier: "s1" },
            ],
            completeness: complete,
          }
        : normal(...args),
    );
    const result = await session.browse("account", "work");
    expect(result.records).toHaveLength(2);
    expect(
      result.records.every(
        (record) => record.fields.find((field) => field.id === "supplier")?.advanced,
      ),
    ).toBe(true);
    expect(result.records[0]?.fields[0]).toMatchObject({
      label: "Assigned supplier",
      value: "Supplier",
      reference: { entity: "supplier", keys: { id: "s1" } },
    });
    expect(fetch.mock.calls.filter((call) => call[2] === "get_supplier")).toHaveLength(1);
  });

  it("keeps primary records visible when a reference cannot be verified", async () => {
    const definition = fixture();
    definition.relationships[0]!.forward.status = "unverified";
    const { session, fetch } = setup(definition);
    const page = await session.page({
      connection: "account",
      entity: "work",
      keys: { id: "w1" },
      context: {},
    });
    expect(page.ref?.keys.id).toBe("w1");
    expect(page.references[0]?.result.status).toBe("unsupported");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("navigates a forward link, its reverse, and another record without widget setup", async () => {
    const { session, fetch } = setup();
    const supplier = await session.follow(
      { connection: "account", entity: "work", keys: { id: "w1" }, context: {} },
      "assigned",
      "forward",
    );
    expect(supplier.status).toBe("ok");
    if (supplier.status !== "ok") return;
    const reverse = await session.follow(supplier.data.records[0]!.ref!, "assigned", "reverse");
    expect(reverse.status).toBe("ok");
    if (reverse.status !== "ok") return;
    expect(reverse.data.records).toHaveLength(2);
    expect((await session.read(reverse.data.records[1]!.ref!)).values.id).toBe("w2");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect((await session.describe("account", "supplier")).relationships[0]?.direction).toBe(
      "reverse",
    );
  });
  it("deduplicates reference reads without multiplying primary records", async () => {
    const { session, fetch } = setup();
    const rows = [
      { id: "w1", supplier: "s1" },
      { id: "w2", supplier: "s1" },
      { id: "w3", supplier: null },
    ];
    const enriched = await session.enrich("account", "work", rows, "assigned");
    expect(enriched.map((row) => row.record)).toEqual(rows);
    expect(enriched.map((row) => row.related.status)).toEqual(["ok", "ok", "absent"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not hide duplicate targets behind a one-row display limit", async () => {
    const { session } = setup(fixture(), [{ id: "s1" }, { id: "s1" }]);
    expect(
      (await session.enrich("account", "work", [{ supplier: "s1" }], "assigned"))[0]?.related
        .status,
    ).toBe("ambiguous");
  });
  it("rejects ignored relationship filters instead of linking unrelated records", async () => {
    const { session } = setup(fixture(), [{ id: "other", supplier: "s2" }]);
    expect(
      (await session.enrich("account", "supplier", [{ id: "s1" }], "assigned", "reverse"))[0]
        ?.related.status,
    ).toBe("invalid");
  });
  it("does not read a known but unavailable inverse", async () => {
    const definition = fixture();
    definition.relationships[0]!.reverse = {
      ...definition.relationships[0]!.reverse,
      status: "unverified",
      plan: { kind: "unavailable", reason: "No reverse endpoint." },
    };
    const { session, fetch } = setup(definition);
    expect(
      (await session.enrich("account", "supplier", [{ id: "s1" }], "assigned", "reverse"))[0]
        ?.related.status,
    ).toBe("unsupported");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves identity types and requires composite parent context", () => {
    const entity = fixture().entities[0]!;
    entity.identity = [
      { name: "id", field: "key.id" },
      { name: "kind", field: "kind" },
    ];
    entity.context = [{ name: "parent", field: "parent" }];
    expect(recordReference("account", entity, { key: { id: 0 }, kind: "task" })).toBeNull();
    expect(
      recordReference("account", entity, { key: { id: 0 }, kind: "task", parent: "01" }),
    ).toMatchObject({ keys: { id: 0, kind: "task" }, context: { parent: "01" } });
  });
  it("keeps accounts separate and checks access before reusing requests", async () => {
    const { session, fetch, authorize } = setup();
    await session.enrich("one", "work", [{ supplier: "s1" }], "assigned");
    await session.enrich("two", "work", [{ supplier: "s1" }], "assigned");
    expect(fetch).toHaveBeenCalledTimes(2);
    authorize.mockResolvedValue(false);
    expect(
      (await session.enrich("one", "work", [{ supplier: "s1" }], "assigned"))[0]?.related.status,
    ).toBe("denied");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("preserves partial scope when matching a bounded lookup", async () => {
    const definition = fixture();
    definition.relationships[0]!.reverse.plan = {
      kind: "bounded-match",
      op: "list_work",
      matches: [{ source: "id", target: "supplier", sourceArray: false, targetArray: false }],
      maxRows: 10,
    };
    const { deps } = setup(definition);
    const session = new IntegrationReadSession(
      {
        ...deps,
        fetch: async () => ({
          rows: [{ id: "w1", supplier: "another" }],
          completeness: { status: "partial", scope: "loaded-records", reason: "Page cap." },
        }),
      },
      { tenant: "a", authorizationRevision: "v1", maxRequests: 2, maxRows: 10 },
    );
    const result = (
      await session.enrich("account", "supplier", [{ id: "s1" }], "assigned", "reverse")
    )[0]!.related;
    expect(result).toMatchObject({
      status: "ok",
      data: { records: [], completeness: { status: "partial" } },
    });
  });

  it("pins the integration contract across related requests in one interaction", async () => {
    const { session, deps, fetch } = setup();
    await session.list("account", "work");
    const changed = fixture();
    changed.version = "two";
    deps.load.mockResolvedValue({
      definition: changed,
      binding: {
        connection: "account",
        integration: "service",
        version: "two",
        revision: 2,
        context: {},
        disabledRelationships: [],
      },
    });
    await session.read({
      connection: "account",
      entity: "supplier",
      keys: { id: "s1" },
      context: {},
    });
    expect(deps.load).toHaveBeenCalledTimes(1);
    expect(
      fetch.mock.calls.every(
        ([context]) => context.binding?.version === "one" && context.binding.revision === 1,
      ),
    ).toBe(true);
  });
});
