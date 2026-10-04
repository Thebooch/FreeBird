import { catalogEntrySchema, type CatalogEntry } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { taskpad } from "../bench/providers/taskpad.js";
import { benchTransport } from "../bench/transport.js";
import { connectionFromCatalog } from "../catalog.js";
import { discover } from "../discovery/index.js";
import { integrate } from "./agent.js";
import { observedShape, withObservedFields } from "./observed.js";

/*
 * What a check's reads show of an endpoint's records, kept for describing it
 * where the documentation declared nothing (measurement 1: every real API
 * measured, and four dev providers, could not be reached by a request).
 */

const entry = (fields?: unknown[]): CatalogEntry =>
  catalogEntrySchema.parse({
    id: "thing",
    title: "Thing API",
    baseUrl: "https://api.thing.test",
    dialect: { auth: { type: "none" }, pagination: { kind: "none" } },
    ops: [{ id: "things", title: "Things", path: "/things", ...(fields ? { fields } : {}) }],
  });

describe("observed fields", () => {
  const body = { data: [{ id: 1, name: "Anvil", secretish: "account-specific value", price: 9.5, active: true }] };

  it("keeps names and kinds, never an account's values", () => {
    const shape = observedShape(body, "$.data")!;
    expect(shape.rowsPath).toBe("$.data");
    expect(shape.fields.map((field) => field.name)).toEqual(["id", "name", "secretish", "price", "active"]);
    expect(JSON.stringify(shape)).not.toContain("account-specific value");
    expect(JSON.stringify(shape)).not.toContain("Anvil");
  });

  it("fills only an endpoint the documentation declared nothing for", () => {
    const shape = observedShape(body, "$.data")!;
    const filled = withObservedFields(entry(), { things: shape });
    expect(filled?.ops[0]).toMatchObject({ fieldsFrom: "observed" });
    expect(filled?.ops[0]?.fields).toHaveLength(5);
    /* A specification's own account of an endpoint is kept, whatever a read showed. */
    const declared = entry([{ name: "id", kinds: ["number"] }]);
    expect(withObservedFields(declared, { things: shape })).toBeNull();
    /* Nothing new, nothing to write. */
    expect(withObservedFields(filled!, { things: shape })).toBeNull();
  });

  /* Regression: connector code read a manifest's files, and the manifest's own fields described the shipments in them. */
  it("replaces declared fields the records hold none of", () => {
    const manifest = entry([
      { name: "files", kinds: ["array"] },
      { name: "columns", kinds: ["array"] },
    ]);
    const shipments = observedShape(
      [
        { shipment_id: "SH-1", status: "delivered", weight_kg: 12.5 },
        { shipment_id: "SH-2", status: "returned", weight_kg: 3 },
      ],
      "$",
    )!;
    const replaced = withObservedFields(manifest, { things: shipments });
    expect(replaced?.ops[0]).toMatchObject({ fieldsFrom: "observed" });
    expect(replaced?.ops[0]?.fields?.map((field) => field.name)).toEqual(["shipment_id", "status", "weight_kg"]);
    /* One declared field the records do hold is enough to keep the declaration. */
    const partly = entry([
      { name: "status", kinds: ["string"] },
      { name: "files", kinds: ["array"] },
    ]);
    expect(withObservedFields(partly, { things: shipments })?.ops[0]?.fieldsFrom).toBeUndefined();
  });

  /* Measurement 1: an export read through code answered with 640 records, and belonged to no resource. */
  it("makes an endpoint a read showed answering with many records a collection", () => {
    const exportEntry = catalogEntrySchema.parse({
      id: "bank",
      title: "Bank",
      baseUrl: "https://api.bank.test",
      dialect: { auth: { type: "none" }, pagination: { kind: "none" } },
      ops: [{ id: "checkExport", title: "Check an export", path: "/exports/{{param.id}}" }],
    });
    const many = observedShape([{ id: 1, amount: 2 }, { id: 2, amount: 3 }], "$")!;
    const grown = withObservedFields(exportEntry, { checkExport: many });
    expect(grown?.resources).toEqual([expect.objectContaining({ id: "export", listOp: "checkExport" })]);
    /* One record is not a collection. */
    expect(withObservedFields(exportEntry, { checkExport: observedShape([{ id: 1 }], "$")! })?.resources).toEqual([]);
  });

  it("is reported by the check for each endpoint it read", async () => {
    const transport = benchTransport([taskpad]);
    const found = await discover(taskpad.docsUrl, { fetchDocument: transport.fetchDocument, llm: null });
    const connection = connectionFromCatalog(found.entry!, { id: "taskpad" });
    const refs = "keyRef" in connection.auth ? { [connection.auth.keyRef]: taskpad.credentials[0]! } : {};
    const report = await integrate(
      connection,
      { targets: [connection.ops[0]!.id] },
      {
        http: transport.http,
        resolveSecret: async (ref) => (refs as Record<string, string>)[ref] ?? null,
        fetchDocument: transport.fetchDocument,
        now: () => Date.UTC(2026, 8, 1),
      },
    );
    expect(report.observed[connection.ops[0]!.id]?.fields.length).toBeGreaterThan(0);
  });
});

/* Regression (trackwell mock API): the issue's declared `fields` was an open object, and what it held was never described. */
describe("fields inside a declared object the documentation leaves open", () => {
  it("are what the records were read to hold there, beside the declaration", () => {
    const declared = entry([
      { name: "id", kinds: ["string"] },
      { name: "fields", kinds: ["object"] },
    ]);
    const shape = observedShape(
      { issues: [{ id: "1", fields: { status: { name: "Open" }, issuetype: { name: "Bug" } } }, { id: "2", fields: { status: { name: "Done" }, issuetype: { name: "Task" } } }] },
      "$.issues",
    )!;
    const filled = withObservedFields(declared, { things: shape });
    const names = filled?.ops[0]?.fields?.map((field) => field.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["id", "fields", "fields.status.name", "fields.issuetype.name"]));
    /* The declaration is kept as the declaration: not replaced by what was read. */
    expect(filled?.ops[0]?.fieldsFrom).toBeUndefined();
    expect(withObservedFields(filled!, { things: shape })).toBeNull();
  });
});
