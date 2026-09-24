import { parseWidget } from "@freebirdai/dash-spec";
import type { EntityLinkView, WidgetSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { recordTargetFor, viewForWidget } from "./recordRoute.js";

/**
 * Which record page a row opens.
 *
 * The failure this exists for: every row click opened the widget's private
 * sheet, and `settleDetail` stops planning that sheet for any widget naming a
 * record type — so clicking a vendor opened a page that was empty by design,
 * while the shared page with its work orders, bills and notes sat one route
 * away and nothing went there.
 */

const widget = (input: Record<string, unknown> = {}): WidgetSpec => {
  const parsed = parseWidget({
    id: "vendors",
    title: "Vendors",
    component: "table",
    source: { connection: "pm", op: "vendors_list", params: {} },
    pipeline: [{ op: "extract", path: "$" }],
    roles: { columns: ["CompanyName"] },
    ...input,
  });
  if (!parsed.ok || !parsed.value) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};

const view: EntityLinkView = {
  entity: "vendor",
  resource: "vendor",
  name: { one: "Vendor", many: "Vendors" },
  identity: "Id",
  title: ["CompanyName"],
  ops: ["vendors_list", "vendors_get"],
  references: [],
  labels: {},
} as unknown as EntityLinkView;

const links = { pm: [view] };

describe("what a row click opens", () => {
  it("opens the record type's own page, which is where the related collections are", () => {
    expect(recordTargetFor(widget(), { Id: 42, CompanyName: "Acme" }, links)).toEqual({
      kind: "entity",
      connection: "pm",
      entity: "vendor",
      id: "42",
    });
  });

  /*
   * Rentvine wraps every record in an object named after its type, so its
   * identity is `property.propertyID`. The row was drawn as clickable and the
   * click did nothing, because the id was looked up as a flat key.
   */
  it("opens a record whose identity nests inside the row", () => {
    const property: EntityLinkView = {
      ...view,
      entity: "property",
      resource: "property",
      identity: "property.propertyID",
      ops: ["properties_list"],
    };
    const properties = widget({
      id: "properties",
      source: { connection: "rv", op: "properties_list", params: {} },
      pipeline: [
        { op: "extract", path: "$" },
        { op: "derive", fields: { property_name: "property.name" } },
      ],
      roles: { columns: ["property_name"] },
    });
    const row = { property: { propertyID: 12, name: "Maple Court" }, property_name: "Maple Court" };
    expect(recordTargetFor(properties, row, { rv: [property] })).toEqual({
      kind: "entity",
      connection: "rv",
      entity: "property",
      id: "12",
    });
    /* And from the flattened column, where a pipeline made one. */
    expect(recordTargetFor(properties, { property_propertyID: 12 }, { rv: [property] })).toMatchObject({
      id: "12",
    });
  });

  it("matches a widget saved before record types existed, on the endpoint it reads", () => {
    // These carry no `entity`, and there are boards full of them. Matching on
    // the endpoint is what spares them a migration.
    expect(viewForWidget(widget(), links)?.entity).toBe("vendor");
  });

  it("prefers the record type the widget names over the endpoint it reads", () => {
    const other: EntityLinkView = { ...view, entity: "supplier", ops: ["vendors_list"] };
    expect(viewForWidget(widget({ entity: "supplier" }), { pm: [view, other] })?.entity).toBe(
      "supplier",
    );
  });

  it("falls back to the widget's own sheet where nothing describes the records", () => {
    /*
     * An undescribed API still has whatever layout was planned for that one
     * widget, and losing it to gain consistency would be a plain regression.
     */
    const target = recordTargetFor(
      widget({
        drilldown: {
          op: "vendors_get",
          params: { vendorId: "{{row.Id}}" },
          component: "record",
          pipeline: [],
        },
      }),
      { Id: 42 },
      {},
    );
    expect(target).toEqual({ kind: "widget", id: "42" });
  });

  it("opens nothing for a row that is not a record", () => {
    // A grouped row is a count, not a thing with a page. Offering one would
    // promise a record that does not exist.
    expect(recordTargetFor(widget(), { CompanyName: "Acme" }, links)).toBeNull();
  });

  it("opens nothing when the row carries no identity and there is no sheet", () => {
    expect(recordTargetFor(widget(), {}, {})).toBeNull();
  });
});
