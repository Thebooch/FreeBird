import type { ColumnMeta, EntityLinkView, WidgetSpec } from "@freebirdai/dash-spec";
import { parseWidget } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { derivedSources, referenceColumns } from "./references.js";

/**
 * Marking the columns that hold another record's identity.
 *
 * The whole job is a translation: the API map says `Vendor.Id` and the
 * component only ever sees `Vendor_Id`, because a derive step made it a
 * column. Getting that wrong fails silently — the link simply never appears —
 * and it fails on the *commonest* shape a foreign key takes, which is why it
 * is worth its own tests.
 */

const widget = (input: Record<string, unknown>): WidgetSpec => {
  const parsed = parseWidget({
    id: "tasks",
    title: "Tasks",
    component: "table",
    source: { connection: "api", op: "tasks_list", params: {} },
    pipeline: [{ op: "extract", path: "$" }],
    roles: { columns: ["Title"] },
    ...input,
  });
  if (!parsed.value) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};

const column = (name: string): ColumnMeta => ({ name, valueType: "categorical" });

const LINKS: Readonly<Record<string, readonly EntityLinkView[]>> = {
  api: [
    /*
     * The far side of the links below. It is here because the stamping has to
     * reach into it: a column cannot say how to name the record it points at
     * without the *target's* own display fields.
     */
    {
      entity: "vendor",
      resource: "vendor",
      name: { one: "Vendor", many: "Vendors" },
      identity: "Id",
      title: ["CompanyName", "FirstName", "LastName"],
      titleMode: "first",
      ops: ["vendors_list", "vendors_byid"],
      references: [],
      labels: {},
    },
    {
      entity: "task",
      resource: "task",
      name: { one: "Task", many: "Tasks" },
      identity: "Id",
      title: ["Title"],
      labels: {},
      ops: ["tasks_list", "tasks_byid"],
      references: [
        {
          field: "VendorId",
          target: "vendor",
          targetName: "Vendor",
          holds: "scalar",
          embedded: [],
          lookup: { op: "vendors_byid", param: "vendorId" },
          free: false,
        },
        {
          field: "Property.Id",
          target: "rental",
          targetName: "Property",
          holds: "objectRef",
          embedded: ["Property.Name"],
          typeField: { field: "Property.Type", map: { Rental: "rental" } },
          lookup: { op: "rentals_byid", param: "propertyId" },
          free: true,
        },
      ],
    },
  ],
};

describe("derivedSources", () => {
  it("reads the mapping the pipeline states, and ignores computed values", () => {
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$" },
        { op: "derive", fields: { Vendor_Id: "Vendor.Id", Total: "Amount * 2" } },
      ],
    });
    expect(derivedSources(spec)).toEqual({ Vendor_Id: "Vendor.Id" });
  });
});

describe("referenceColumns", () => {
  it("marks a plain column that holds another record's id", () => {
    const marked = referenceColumns([column("Title"), column("VendorId")], widget({}), LINKS);
    expect(marked.find((one) => one.name === "VendorId")?.reference).toMatchObject({
      target: "vendor",
      targetName: "Vendor",
      // Read off the *target's* view: a column cannot name the record it
      // points at without knowing how that record says its own name — nor
      // whether those fields are parts of one name or alternatives for it.
      targetTitle: ["CompanyName", "FirstName", "LastName"],
      targetTitleMode: "first",
      lookup: { op: "vendors_byid", param: "vendorId" },
    });
    // Everything else is untouched, so a component that ignores this renders
    // exactly what it always did.
    expect(marked.find((one) => one.name === "Title")?.reference).toBeUndefined();
  });

  it("follows the derive step to the column a nested reference became", () => {
    /*
     * The case that fails silently without this. `Property.Id` is not a column
     * — `Property_Id` is — so a link keyed by the API's own path would match
     * nothing at all.
     */
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$" },
        {
          op: "derive",
          fields: {
            Property_Id: "Property.Id",
            Property_Name: "Property.Name",
            Property_Type: "Property.Type",
          },
        },
      ],
      roles: { columns: ["Property_Id"] },
    });
    const marked = referenceColumns(
      [column("Property_Id"), column("Property_Name"), column("Property_Type")],
      spec,
      LINKS,
    );
    expect(marked.find((one) => one.name === "Property_Id")?.reference).toMatchObject({
      target: "rental",
      // Translated too: a component reads these straight off the row.
      embedded: ["Property_Name"],
      typeColumn: "Property_Type",
      typeMap: { Rental: "rental" },
    });
  });

  it("claims only the embedded names this widget actually renders", () => {
    // A name the row carries but the pipeline dropped cannot be read off the
    // row, and claiming it would make a link look free while resolving to
    // nothing.
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$" },
        { op: "derive", fields: { Property_Id: "Property.Id" } },
      ],
    });
    expect(
      referenceColumns([column("Property_Id")], spec, LINKS).find(
        (one) => one.name === "Property_Id",
      )?.reference?.embedded,
    ).toEqual([]);
  });

  it("leaves a reference the widget does not show unmarked", () => {
    const marked = referenceColumns([column("Title")], widget({}), LINKS);
    expect(marked.every((one) => one.reference === undefined)).toBe(true);
  });

  it("marks nothing once the rows are buckets rather than records", () => {
    /*
     * After a group step there is no record behind a mark, so there is nothing
     * to open — the same reason charts ignore highlights and carry no filter
     * strip.
     */
    const spec = widget({
      component: "bar",
      pipeline: [
        { op: "extract", path: "$" },
        { op: "group", by: [{ field: "VendorId" }], agg: { count: "count()" } },
      ],
      roles: { category: "VendorId", value: "count" },
    });
    expect(
      referenceColumns([column("VendorId"), column("count")], spec, LINKS).every(
        (one) => one.reference === undefined,
      ),
    ).toBe(true);
  });

  it("matches the record type by endpoint for a widget saved before entities", () => {
    // No `entity` on the spec, which is every widget built before this
    // existed. Matched on the op instead, so nothing needs migrating.
    expect(widget({}).entity).toBeUndefined();
    expect(
      referenceColumns([column("VendorId")], widget({}), LINKS)[0]?.reference?.target,
    ).toBe("vendor");
  });

  it("prefers what the widget says it is over what its endpoint implies", () => {
    const spec = widget({ entity: "task" });
    expect(
      referenceColumns([column("VendorId")], spec, LINKS)[0]?.reference?.target,
    ).toBe("vendor");
  });

  it("does nothing at all for an API nobody has described", () => {
    // Annotated rather than inferred: a bare array of these three widens to a
    // union with an optional `api`, which is not the shape the parameter takes.
    const nothing: Array<Readonly<Record<string, readonly EntityLinkView[]>> | undefined> = [
      undefined,
      {},
      { api: [] },
    ];
    for (const links of nothing) {
      const marked = referenceColumns([column("VendorId")], widget({}), links);
      expect(marked).toEqual([column("VendorId")]);
    }
  });

  it("does nothing for a widget reading an endpoint no record type claims", () => {
    const spec = widget({ source: { connection: "api", op: "unclaimed", params: {} } });
    expect(referenceColumns([column("VendorId")], spec, LINKS)[0]?.reference).toBeUndefined();
  });
});
