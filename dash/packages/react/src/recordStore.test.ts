import type { EntityLinkView } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { RecordIndex, collectRecords, indexPlan } from "./recordStore.js";

const view = (over: Partial<EntityLinkView> = {}): EntityLinkView => ({
  entity: "vendor",
  resource: "vendor",
  name: { one: "Vendor", many: "Vendors" },
  identity: "Id",
  title: ["CompanyName"],
  ops: ["vendors_list", "vendors_get"],
  references: [],
  labels: {},
  ...over,
});

describe("indexPlan", () => {
  it("maps every endpoint of a record type to that type and its id field", () => {
    const plan = indexPlan({ api: [view()] });
    expect(plan.get("api.vendors_list")).toEqual({ entity: "vendor", identity: "Id" });
    expect(plan.get("api.vendors_get")).toEqual({ entity: "vendor", identity: "Id" });
  });

  it("ignores a record type with no identity, because nothing could be keyed", () => {
    expect(indexPlan({ api: [view({ identity: undefined })] }).size).toBe(0);
  });

  /*
   * Indexing one type's rows as another would put one record's name on a
   * different record — silently, and only for the overlapping ids.
   */
  it("keeps the first claim on an endpoint two record types both name", () => {
    const plan = indexPlan({
      api: [view(), view({ entity: "supplier", ops: ["vendors_list"], identity: "Ref" })],
    });
    expect(plan.get("api.vendors_list")).toEqual({ entity: "vendor", identity: "Id" });
  });

  it("keeps connections apart", () => {
    const plan = indexPlan({ a: [view()], b: [view({ entity: "other" })] });
    expect(plan.get("a.vendors_list")?.entity).toBe("vendor");
    expect(plan.get("b.vendors_list")?.entity).toBe("other");
  });
});

describe("collectRecords", () => {
  it("reads a bare array", () => {
    expect(collectRecords([{ Id: 1 }, { Id: 2 }], "Id").map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("reads the envelope a paginated API wraps rows in", () => {
    expect(collectRecords({ Data: [{ Id: 7 }] }, "Id").map((r) => r.id)).toEqual(["7"]);
  });

  it("reads a single detail response", () => {
    const found = collectRecords({ Id: 41, CompanyName: "Acme" }, "Id");
    expect(found).toHaveLength(1);
    expect(found[0]?.row).toMatchObject({ CompanyName: "Acme" });
  });

  it("reads an identity that nests, list and detail alike", () => {
    /* Rentvine: every record wrapped in an object named after its type. */
    const list = [{ property: { propertyID: 12, name: "Maple Court" } }, { property: { propertyID: 13 } }];
    expect(collectRecords(list, "property.propertyID").map((r) => r.id)).toEqual(["12", "13"]);
    const detail = collectRecords({ property: { propertyID: 12, name: "Maple Court" } }, "property.propertyID");
    expect(detail.map((r) => r.id)).toEqual(["12"]);
  });

  /*
   * The conservative half: a wrong guess about where rows live must not put
   * junk in the index, so only objects actually carrying the id are taken.
   */
  it("takes nothing from rows without the identity field", () => {
    expect(collectRecords([{ Name: "no id" }], "Id")).toEqual([]);
    expect(collectRecords({ Data: [{ Id: null }, { Id: "" }] }, "Id")).toEqual([]);
    expect(collectRecords("not an object", "Id")).toEqual([]);
    expect(collectRecords(null, "Id")).toEqual([]);
  });
});

describe("RecordIndex", () => {
  const plan = indexPlan({ api: [view()] });

  it("answers for a record whatever request brought it", () => {
    const index = new RecordIndex();
    index.ingest({ connection: "api", op: "vendors_list", body: [{ Id: 41 }], plan });
    // Fetched as part of a list; asked for as one record.
    expect(index.has("api", "vendor", 41)).toBe(true);
    expect(index.get("api", "vendor", "41")).toEqual({ Id: 41 });
  });

  it("ignores an endpoint whose rows are not a known record type", () => {
    const index = new RecordIndex();
    expect(index.ingest({ connection: "api", op: "unknown", body: [{ Id: 1 }], plan })).toBe(0);
    expect(index.size("api")).toBe(0);
  });

  /*
   * A detail response carries more fields than a list row, so arriving second
   * it must replace rather than be discarded as already-known.
   */
  it("lets a fuller copy replace a thinner one", () => {
    const index = new RecordIndex();
    index.ingest({ connection: "api", op: "vendors_list", body: [{ Id: 41 }], plan });
    index.ingest({
      connection: "api",
      op: "vendors_get",
      body: { Id: 41, CompanyName: "Acme", Phone: "0117" },
      plan,
    });
    expect(index.get("api", "vendor", 41)).toMatchObject({ CompanyName: "Acme", Phone: "0117" });
    expect(index.size("api")).toBe(1);
  });

  it("only reports records it actually added", () => {
    const index = new RecordIndex();
    expect(index.ingest({ connection: "api", op: "vendors_list", body: [{ Id: 1 }], plan })).toBe(1);
    // Same record again: nothing new to tell anybody about.
    expect(index.ingest({ connection: "api", op: "vendors_list", body: [{ Id: 1 }], plan })).toBe(0);
  });

  it("tells subscribers only when something was added", () => {
    const index = new RecordIndex();
    let calls = 0;
    index.subscribe(() => calls++);
    index.ingest({ connection: "api", op: "vendors_list", body: [{ Id: 1 }], plan });
    expect(calls).toBe(1);
    index.ingest({ connection: "api", op: "vendors_list", body: [{ Id: 1 }], plan });
    expect(calls).toBe(1);
  });

  it("keeps connections apart", () => {
    const index = new RecordIndex();
    const both = indexPlan({ api: [view()], other: [view()] });
    index.ingest({ connection: "api", op: "vendors_list", body: [{ Id: 41 }], plan: both });
    expect(index.has("other", "vendor", 41)).toBe(false);
  });

  /* Credentials changed: that account's rows must stop naming anything. */
  it("forgets one connection without touching another", () => {
    const index = new RecordIndex();
    const both = indexPlan({ api: [view()], other: [view()] });
    index.ingest({ connection: "api", op: "vendors_list", body: [{ Id: 1 }], plan: both });
    index.ingest({ connection: "other", op: "vendors_list", body: [{ Id: 2 }], plan: both });
    index.forget("api");
    expect(index.size("api")).toBe(0);
    expect(index.size("other")).toBe(1);
  });

  it("stays bounded, so a board of big pages cannot hold a whole account", () => {
    const index = new RecordIndex(10);
    index.ingest({
      connection: "api",
      op: "vendors_list",
      body: Array.from({ length: 50 }, (_, i) => ({ Id: i })),
      plan,
    });
    expect(index.size("api")).toBe(10);
    // The most recently seen survive: they are the ones on screen.
    expect(index.has("api", "vendor", 49)).toBe(true);
    expect(index.has("api", "vendor", 0)).toBe(false);
  });
});
