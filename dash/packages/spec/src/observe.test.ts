import { describe, expect, it } from "vitest";
import { entitySchema, type EntitySpec } from "./entity.js";
import {
  fieldReading,
  isFlagField,
  observeEntity,
  observeField,
  readingsDiffer,
  rerootBrief,
  rerootEntity,
  type SeenField,
  wrapperOf,
} from "./observe.js";

/**
 * What a record type's fields really hold, against what the docs declared.
 *
 * Every case here is Rentvine's: flags declared boolean and sent as 0/1, a
 * type id declared boolean and sent as 1–4, a work order number declared
 * text and sent as a number.
 */

const workOrder = (fields: Record<string, unknown>[]): EntitySpec =>
  entitySchema.parse({
    id: "work-order",
    resource: "work-order",
    name: { one: "Work order", many: "Work orders" },
    kind: "work",
    fields,
  });

const seen = (name: string, samples: unknown[], over: Partial<SeenField> = {}): SeenField => ({
  name,
  kinds: [...new Set(samples.map((value) => (value === null ? "null" : typeof value)))],
  nullable: samples.includes(null),
  distinct: new Set(samples.map((value) => JSON.stringify(value))).size,
  samples: samples.filter((value) => value !== null).slice(0, 3),
  ...over,
});

const field = (path: string, kinds: string[], over: Record<string, unknown> = {}) =>
  workOrder([{ path, kinds, ...over }]).fields[0]!;

describe("observeField", () => {
  it("reads a flag sent as 0 and 1 as the flag it was declared", () => {
    const flag = field("workOrder.isVacant", ["boolean"]);
    expect(observeField(flag, seen("workOrder.isVacant", [0, 1, 0]))).toEqual({
      kinds: ["number"],
      coercion: "->boolean",
    });
    // Words work as well as digits.
    expect(observeField(flag, seen("workOrder.isVacant", ["true", "false"]))?.coercion).toBe(
      "->boolean",
    );
  });

  it("does not take a number the docs called a flag for a flag", () => {
    // Rentvine's taxFormTypeID: declared boolean, sent 1 through 4.
    const typeId = field("taxFormTypeID", ["boolean"]);
    expect(observeField(typeId, seen("taxFormTypeID", [1, 2, 3], { distinct: 4 }))).toEqual({
      kinds: ["number"],
    });
  });

  it("leaves a flag that arrives as a flag alone", () => {
    expect(observeField(field("isActive", ["boolean"]), seen("isActive", [true, false]))).toEqual({
      kinds: ["boolean"],
    });
  });

  it("reads numbers sent as text as numbers", () => {
    expect(
      observeField(field("estimatedAmount", ["number"]), seen("estimatedAmount", ["12.50", "0"]))
        ?.coercion,
    ).toBe("->number");
  });

  it("reads a reference number sent as a number as a reference, not a quantity", () => {
    const number = field("workOrder.workOrderNumber", ["string"]);
    expect(observeField(number, seen("workOrder.workOrderNumber", [104868, 104842]))).toEqual({
      kinds: ["number"],
      semantic: "identifier",
    });
  });

  it("reads a date sent as seconds since 1970", () => {
    const date = field("createdAt", ["string"], { format: "iso8601" });
    expect(observeField(date, seen("createdAt", [1758672000]))?.coercion).toBe("unix_s->datetime");
  });

  it("says when every record it saw left a field empty", () => {
    expect(observeField(field("closedAt", ["string"]), seen("closedAt", [null, null]))).toEqual({
      kinds: [],
    });
  });
});

describe("observeEntity", () => {
  it("records what a response showed, and when", () => {
    const entity = workOrder([
      { path: "workOrder.isVacant", kinds: ["boolean"] },
      { path: "workOrder.description", kinds: ["string"] },
    ]);
    const after = observeEntity(entity, [seen("workOrder.isVacant", [0, 1])], "2026-09-25T00:00:00Z");
    expect(after.readAt).toBe("2026-09-25T00:00:00Z");
    expect(after.fields[0]?.observed?.coercion).toBe("->boolean");
    // A field the response did not carry is not evidence of anything.
    expect(after.fields[1]?.observed).toBeUndefined();
    expect(readingsDiffer(entity, after)).toBe(true);
  });

  it("changes nothing when the response carried none of its fields", () => {
    const entity = workOrder([{ path: "workOrder.isVacant", kinds: ["boolean"] }]);
    expect(observeEntity(entity, [seen("other", [1])], "now")).toBe(entity);
  });
});

describe("fieldReading", () => {
  it("prefers what somebody stated over what a response showed", () => {
    const stated = field("amount", ["number"], {
      coercion: "money:cents->major",
      observed: { kinds: ["string"], coercion: "->number" },
    });
    expect(fieldReading(stated)).toEqual({ coercion: "money:cents->major", semantic: "currency" });
  });

  it("uses what a response showed where nothing was stated", () => {
    expect(fieldReading(field("isVacant", ["boolean"], { observed: { kinds: ["number"], coercion: "->boolean" } }))).toEqual({
      coercion: "->boolean",
    });
    expect(
      fieldReading(field("workOrderNumber", ["string"], { observed: { kinds: ["number"], semantic: "identifier" } })),
    ).toEqual({ semantic: "identifier" });
  });
});

/*
 * Rentvine's docs describe a unit as `{ unitID, name, isActive }` and the API
 * sends `{ unit: { unitID, name, isActive } }`. Built from the docs, the unit's
 * page asked every response for `name` and found nothing.
 */
describe("a record the docs describe one level up from where it arrives", () => {
  const unit = entitySchema.parse({
    id: "unit",
    resource: "unit",
    name: { one: "Unit", many: "Units" },
    kind: "place",
    identity: { field: "unitID" },
    display: { title: ["name"], status: "isActive" },
    fields: [
      { path: "unitID" },
      { path: "name" },
      { path: "isActive", kinds: ["boolean"] },
      { path: "address", kinds: ["object"] },
      { path: "address.city" },
    ],
    views: { facets: ["isActive"], record: { facts: ["name"], groups: [{ title: "Where", fields: ["address.city"] }] } },
  });
  const wrappedRows: SeenField[] = [
    seen("unit", [{}], { kinds: ["object"] }),
    seen("unit.unitID", [222]),
    seen("unit.name", ["Unit 222"]),
    seen("unit.isActive", [1, 0]),
    seen("unit.address", [{}], { kinds: ["object"] }),
    seen("unit.address.city", ["Denver"]),
  ];

  it("finds the object the record really sits in", () => {
    expect(wrapperOf(unit, wrappedRows)).toBe("unit");
  });

  it("does not take a record with an object field for a wrapped one", () => {
    const flatRows = [
      seen("unitID", [222]),
      seen("name", ["Unit 222"]),
      seen("isActive", [true]),
      seen("address", [{}], { kinds: ["object"] }),
      seen("address.city", ["Denver"]),
    ];
    expect(wrapperOf(unit, flatRows)).toBeNull();
  });

  it("moves every path the record type holds, together", () => {
    const moved = rerootEntity(unit, "unit");
    expect(moved.identity?.field).toBe("unit.unitID");
    expect(moved.display).toMatchObject({ title: ["unit.name"], status: "unit.isActive" });
    expect(moved.fields.map((field) => field.path)).toEqual([
      "unit.unitID",
      "unit.name",
      "unit.isActive",
      "unit.address",
      "unit.address.city",
    ]);
    expect(moved.views.facets).toEqual(["unit.isActive"]);
    expect(moved.views.record.facts).toEqual(["unit.name"]);
    expect(moved.views.record.groups[0]?.fields).toEqual(["unit.address.city"]);
    // Still a valid record type: its display names fields it has.
    expect(entitySchema.safeParse(moved).success).toBe(true);
  });

  it("moves, then reads, and says it moved", () => {
    const after = observeEntity(unit, wrappedRows, "2026-09-25T00:00:00Z");
    expect(after.wrapped).toBe("unit");
    expect(after.identity?.field).toBe("unit.unitID");
    expect(after.fields.find((field) => field.path === "unit.isActive")?.observed?.coercion).toBe(
      "->boolean",
    );
  });

  it("moves a widget's request on the record with it, and nothing on the far side", () => {
    expect(
      rerootBrief(
        {
          entity: "unit",
          intent: "records",
          columns: ["name", "unit.unitID"],
          filters: [{ field: "isActive" }],
          sort: { field: "name" },
          linked: [{ through: "propertyID", field: "property.name" }],
        },
        "unit",
      ),
    ).toEqual({
      entity: "unit",
      intent: "records",
      columns: ["unit.name", "unit.unitID"],
      filters: [{ field: "unit.isActive" }],
      sort: { field: "unit.name" },
      linked: [{ through: "unit.propertyID", field: "property.name" }],
    });
  });
});

describe("isFlagField", () => {
  it("trusts what a read saw over what the docs declared", () => {
    expect(isFlagField(field("isVacant", ["boolean"], { observed: { kinds: ["number"], coercion: "->boolean" } }))).toBe(true);
    // Declared boolean, seen as 1–4: not a flag.
    expect(isFlagField(field("taxFormTypeID", ["boolean"], { observed: { kinds: ["number"] } }))).toBe(false);
    expect(isFlagField(field("isActive", ["string"], { observed: { kinds: ["boolean"] } }))).toBe(true);
  });

  it("takes the declaration at its word where nothing has been read", () => {
    expect(isFlagField(field("isActive", ["boolean"]))).toBe(true);
    expect(isFlagField(field("isActive", ["boolean", "null"]))).toBe(true);
    expect(isFlagField(field("name", ["string"]))).toBe(false);
    expect(isFlagField(field("unknown", []))).toBe(false);
  });
});

/*
 * Rentvine declares 86 of its yes/no fields as text and sends "1"/"0". The
 * name asks the question and the values answer it, so they are flags too.
 */
describe("flags the docs call text", () => {
  it("reads a flag-named field sent as 1/0 as a flag", () => {
    const shared = field("workOrder.isSharedWithTenant", ["string"]);
    expect(observeField(shared, seen("workOrder.isSharedWithTenant", ["1", "0"]))).toEqual({
      kinds: ["string"],
      coercion: "->boolean",
    });
    expect(isFlagField(shared)).toBe(true);
    expect(isFlagField(field("workOrder.isNew", ["string"], { observed: { kinds: ["string"] } }))).toBe(true);
  });

  it("leaves a field named like a flag but holding something else", () => {
    const odd = field("hasTier", ["string"]);
    expect(observeField(odd, seen("hasTier", ["gold", "silver"]))?.coercion).toBeUndefined();
  });

  it("does not make a flag of a plain field that happens to hold 0 and 1", () => {
    const count = field("openCount", ["number"]);
    expect(observeField(count, seen("openCount", [0, 1]))?.coercion).toBeUndefined();
    expect(isFlagField(count)).toBe(false);
  });
});
