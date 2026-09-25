import { describe, expect, it } from "vitest";
import { bundlesOf, ownFields } from "./bundles.js";
import { entitySchema, referenceSchema, type EntitySpec } from "./entity.js";
import { entityLinkViews, entityPageView, linkColumn } from "./entity-graph.js";
import { resourceSchema } from "./resource.js";

/**
 * Records an API sends inside another record's rows.
 *
 * Shaped like Rentvine, where every record is wrapped in an object named after
 * its type and the records it relates to ride beside it: an invoice row is
 * `{ invoice, workOrder, contact }`. Buildium's records are not wrapped, and
 * nothing about them may change.
 */

const entity = (input: Record<string, unknown>): EntitySpec => entitySchema.parse(input);

const WORK_ORDER = entity({
  id: "work-order",
  resource: "work-order",
  name: { one: "Work order", many: "Work orders" },
  kind: "work",
  identity: { field: "workOrder.workOrderID" },
  display: { title: ["workOrder.workOrderNumber"] },
  fields: [{ path: "workOrder.workOrderID" }, { path: "workOrder.workOrderNumber" }],
});
const TENANT = entity({
  id: "tenant",
  resource: "tenant",
  name: { one: "Tenant", many: "Tenants" },
  kind: "party",
  identity: { field: "contact.contactID" },
  fields: [{ path: "contact.contactID" }, { path: "contact.name" }],
});
const VENDOR = entity({
  id: "vendor",
  resource: "vendor",
  name: { one: "Vendor", many: "Vendors" },
  kind: "party",
  identity: { field: "contact.contactID" },
  fields: [{ path: "contact.contactID" }, { path: "contact.name" }],
});
const VENDOR_TRADE = entity({
  id: "vendor-trade",
  resource: "vendor-trade",
  name: { one: "Trade", many: "Trades" },
  kind: "lookup",
  identity: { field: "vendorTrade.vendorTradeID" },
  fields: [{ path: "vendorTrade.vendorTradeID" }],
});
const INVOICE = entity({
  id: "invoice",
  resource: "invoice",
  name: { one: "Invoice", many: "Invoices" },
  kind: "money",
  identity: { field: "invoice.invoiceID" },
  display: { title: ["invoice.reference"] },
  fields: [
    { path: "invoice.invoiceID", visibility: "hidden" },
    { path: "invoice.reference", visibility: "primary" },
    { path: "invoice.amount" },
    { path: "workOrder", kinds: ["object"] },
    { path: "workOrder.workOrderID", visibility: "hidden", reference: { entity: "work-order" } },
    { path: "workOrder.workOrderNumber" },
    { path: "workOrder.description" },
    { path: "contact.contactID", visibility: "hidden" },
    { path: "contact.name" },
    // The bundled contact's own link, which is the contact's and not the invoice's.
    { path: "contact.vendorTradeID", reference: { entity: "vendor-trade" } },
    // A part of the invoice, named like no record type.
    { path: "lineItems.count" },
  ],
});

const ALL = [INVOICE, WORK_ORDER, TENANT, VENDOR, VENDOR_TRADE];

const input = {
  entities: ALL,
  resources: [
    resourceSchema.parse({ id: "invoice", title: "Invoices", listOp: "invoices" }),
    resourceSchema.parse({
      id: "work-order",
      title: "Work orders",
      listOp: "work_orders",
      detailOp: "work_order",
      detailParam: "workOrderID",
    }),
    resourceSchema.parse({ id: "vendor-trade", title: "Trades", listOp: "trades" }),
  ],
  ops: [
    { id: "invoices", path: "/invoices", params: [] },
    { id: "work_orders", path: "/work-orders", params: [] },
    { id: "work_order", path: "/work-orders/{{param.workOrderID}}", params: [] },
    { id: "trades", path: "/trades", params: [] },
  ],
};

describe("bundlesOf", () => {
  it("recognises another record type by the wrapper it is sent in", () => {
    expect(bundlesOf(INVOICE, ALL)).toEqual([
      { path: "workOrder", entity: "work-order" },
      // Several record types are wrapped as `contact`, and nothing says which.
      { path: "contact" },
    ]);
  });

  it("uses the link the row records, where several types share a wrapper", () => {
    const named = entity({
      ...INVOICE,
      fields: [
        ...INVOICE.fields.filter((field) => field.path !== "contact.contactID"),
        { path: "contact.contactID", reference: { entity: "vendor" } },
      ],
    });
    expect(bundlesOf(named, ALL)).toContainEqual({ path: "contact", entity: "vendor" });
  });

  it("finds none on an API whose records are not wrapped", () => {
    // Buildium: identities are a plain `Id`, and a nested object is part of the record.
    const lease = entity({
      id: "lease",
      resource: "lease",
      name: { one: "Lease", many: "Leases" },
      kind: "document",
      identity: { field: "Id" },
      fields: [{ path: "Id" }, { path: "Unit.Id", reference: { entity: "unit" } }, { path: "Unit.Name" }],
    });
    expect(bundlesOf(lease, [lease])).toEqual([]);
    expect(ownFields(lease, [lease])).toBe(lease.fields);
  });

  it("leaves a record's own fields, without what was sent beside it", () => {
    expect(ownFields(INVOICE, ALL).map((field) => field.path)).toEqual([
      "invoice.invoiceID",
      "invoice.reference",
      "invoice.amount",
      "lineItems.count",
    ]);
  });
});

describe("a record's page, with records sent inside its rows", () => {
  it("shows its own fields, and each bundled record as a link by its name", () => {
    const page = entityPageView(input, "invoice");
    const paths = page?.fields.map((field) => field.path) ?? [];
    expect(paths).toContain("invoice.reference");
    expect(paths).not.toContain("workOrder.description");
    expect(paths).not.toContain("contact.name");
    expect(page?.fields.find((field) => field.path === "workOrder.workOrderID")?.label).toBe(
      "Work order",
    );
    expect(page?.bundles).toEqual([
      { path: "workOrder", entity: "work-order", name: "Work order" },
      { path: "contact" },
    ]);
  });

  it("names a bundled record for free, off the row it came on", () => {
    const toWorkOrder = entityLinkViews(input)
      .find((view) => view.entity === "invoice")
      ?.references.find((reference) => reference.target === "work-order");
    expect(toWorkOrder).toMatchObject({
      field: "workOrder.workOrderID",
      embedded: ["workOrder.workOrderNumber"],
      free: true,
    });
  });

  it("does not take a bundled record's own links for this record's", () => {
    // `contact.vendorTradeID` is the contact's trade, not the invoice's.
    const invoice = entityLinkViews(input).find((view) => view.entity === "invoice");
    expect(invoice?.references.map((reference) => reference.target)).not.toContain("vendor-trade");
  });
});

describe("linkColumn", () => {
  it("reads the target's own identity inside an object, not an assumed Id", () => {
    const reference = referenceSchema.parse({ entity: "work-order", holds: "objectRef" });
    const field = INVOICE.fields.find((one) => one.path === "workOrder")!;
    expect(linkColumn(field, reference, WORK_ORDER)).toBe("workOrder.workOrderID");
    // Without a target, as before.
    expect(linkColumn(field, reference)).toBe("workOrder.Id");
  });
});
