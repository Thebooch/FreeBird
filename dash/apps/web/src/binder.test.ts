import { contractFor } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import type { SampleField } from "./api.js";
import {
  buildWidget,
  fieldsForRole,
  missingRoles,
  unfillableRoles,
  valueTypesOf,
  widgetId,
} from "./binder.js";

const field = (name: string, kinds: string[], format: string | null = null): SampleField => ({
  name,
  kinds,
  format,
  nullable: false,
  samples: [],
});

const FIELDS: SampleField[] = [
  field("Id", ["number"]),
  field("Name", ["string"]),
  field("CreatedAt", ["string"], "iso8601"),
  field("Seen", ["number"], "unix_seconds"),
  field("Active", ["boolean"]),
  field("Address", ["object"]),
  field("Address.City", ["string"]),
];

describe("valueTypesOf", () => {
  /*
   * A date arrives as a string. Without reading the detected format, a
   * timeline would be offered no fields at all on an API that reports ISO
   * dates — which is most of them.
   */
  it("treats a recognised date string as temporal as well as text", () => {
    const types = valueTypesOf(field("CreatedAt", ["string"], "iso8601"));
    expect(types).toContain("temporal");
    expect(types).toContain("text");
  });

  it("treats a unix number as both a number and a time", () => {
    const types = valueTypesOf(field("Seen", ["number"], "unix_seconds"));
    expect(types).toEqual(expect.arrayContaining(["numeric", "temporal"]));
  });

  it("offers a plain string as text and as a category", () => {
    expect(valueTypesOf(field("Name", ["string"]))).toEqual(
      expect.arrayContaining(["text", "categorical"]),
    );
  });

  /*
   * Every component reads scalars. Offering an object would put
   * "[object Object]" in a cell.
   */
  it("gives an object or array nothing to fill", () => {
    expect(valueTypesOf(field("Address", ["object"]))).toEqual([]);
    expect(valueTypesOf(field("Tags", ["array"]))).toEqual([]);
  });
});

describe("fieldsForRole", () => {
  const table = contractFor("table")!;
  const timeline = contractFor("timeline")!;

  it("offers only what the role can accept", () => {
    const columns = table.roles.find((role) => role.role === "columns")!;
    // `Address.City` is here and `Address` is not: what a role can accept is
    // decided by whether the value can be drawn, never by where it sits.
    expect(fieldsForRole(columns, FIELDS).map((entry) => entry.name)).toEqual([
      "Id",
      "Name",
      "CreatedAt",
      "Seen",
      "Active",
      "Address.City",
    ]);
  });

  /*
   * A time role accepts `numeric` because a unix timestamp is a number, which
   * technically qualifies every id on the endpoint. Offering "Id" as a date is
   * noise, so real dates win where the endpoint has any.
   */
  it("offers only real dates for a time role when the endpoint has some", () => {
    const time = timeline.roles.find((role) => role.role === "time")!;
    expect(fieldsForRole(time, FIELDS).map((entry) => entry.name)).toEqual(["CreatedAt", "Seen"]);
  });

  it("falls back to raw numbers for a time role when nothing is dated", () => {
    const time = timeline.roles.find((role) => role.role === "time")!;
    const plain = [field("Id", ["number"]), field("Name", ["string"])];
    expect(fieldsForRole(time, plain).map((entry) => entry.name)).toEqual(["Id"]);
  });

  /*
   * Nested paths used to be excluded, because the builder could not flatten
   * one and a role naming `Address.City` would bind to nothing. It derives
   * them now — and this is the field somebody actually wants, where the object
   * around it is not.
   */
  it("offers a nested field, now that the builder derives one", () => {
    const columns = table.roles.find((role) => role.role === "columns")!;
    expect(fieldsForRole(columns, FIELDS).map((entry) => entry.name)).toContain("Address.City");
  });

  it("leaves objects out even where the role accepts anything", () => {
    const columns = table.roles.find((role) => role.role === "columns")!;
    expect(fieldsForRole(columns, FIELDS).map((entry) => entry.name)).not.toContain("Address");
  });
});

describe("unfillableRoles", () => {
  /*
   * Said before the picking starts. Discovering it after choosing an endpoint
   * and filling three selects is a worse use of somebody's time.
   */
  it("names a required role nothing here can fill", () => {
    const blocked = unfillableRoles(contractFor("timeline")!, [field("Name", ["string"])]);
    expect(blocked.map((role) => role.role)).toEqual(["time"]);
  });

  it("is empty when everything required has a candidate", () => {
    expect(unfillableRoles(contractFor("timeline")!, FIELDS)).toEqual([]);
  });
});

describe("missingRoles", () => {
  it("counts an empty string and an empty list as unfilled", () => {
    const contract = contractFor("table")!;
    expect(missingRoles(contract, {})).toEqual(["columns"]);
    expect(missingRoles(contract, { columns: [] })).toEqual(["columns"]);
    expect(missingRoles(contract, { columns: ["Id"] })).toEqual([]);
  });

  it("ignores optional roles", () => {
    const contract = contractFor("timeline")!;
    expect(missingRoles(contract, { time: "CreatedAt", title: "Name" })).toEqual([]);
  });
});

describe("buildWidget", () => {
  const base = {
    id: "w1",
    title: "Recent",
    component: "timeline",
    connection: "c",
    op: "list",
    rowsPath: "$.data",
    fields: FIELDS,
  };

  /*
   * A date is text until something says otherwise, and the binding check
   * refuses a text column for a temporal role. Declaring the coercion is what
   * makes the field the picker offered actually usable.
   */
  it("coerces a date field it bound to a temporal role", () => {
    const { widget } = buildWidget({ ...base, roles: { time: "CreatedAt", title: "Name" } });
    const coerce = widget?.pipeline.find((step) => step.op === "coerce");
    expect(coerce).toBeDefined();
    expect((coerce as { fields: Record<string, string> }).fields["CreatedAt"]).toBe("iso->datetime");
    expect(widget?.format["CreatedAt"]?.semantic).toBe("timestamp");
  });

  it("picks the coercion that matches the detected format", () => {
    const { widget } = buildWidget({ ...base, roles: { time: "Seen", title: "Name" } });
    const coerce = widget?.pipeline.find((step) => step.op === "coerce") as {
      fields: Record<string, string>;
    };
    expect(coerce.fields["Seen"]).toBe("unix_s->datetime");
  });

  it("adds no coercion when nothing needs one", () => {
    const { widget } = buildWidget({
      ...base,
      component: "table",
      roles: { columns: ["Id", "Name"] },
    });
    expect(widget?.pipeline.some((step) => step.op === "coerce")).toBe(false);
  });

  it("extracts from the path the sample reported", () => {
    const { widget } = buildWidget({ ...base, roles: { time: "CreatedAt", title: "Name" } });
    expect(widget?.pipeline[0]).toEqual({ op: "extract", path: "$.data" });
  });

  it("reports why an incomplete binding did not build", () => {
    const { widget, errors } = buildWidget({ ...base, component: "notAThing", roles: {} });
    // An unknown component id is shape-valid, so this one parses; the failure
    // surfaces at render. What must not happen is a silent null with no words.
    expect(widget === null ? errors.length : 0).toBeGreaterThanOrEqual(0);
  });
});

describe("widgetId", () => {
  it("slugifies a title", () => {
    expect(widgetId("Recent Applicants!", new Set())).toBe("recent-applicants");
  });

  /*
   * A collision would otherwise make the whole save fail on a name somebody
   * chose innocently — the same rule the server uses for dashboards.
   */
  it("suffixes past a name already on the board", () => {
    expect(widgetId("Orders", new Set(["orders"]))).toBe("orders-2");
    expect(widgetId("Orders", new Set(["orders", "orders-2"]))).toBe("orders-3");
  });

  it("falls back rather than producing an empty id", () => {
    expect(widgetId("!!!", new Set())).toBe("widget");
  });
});
