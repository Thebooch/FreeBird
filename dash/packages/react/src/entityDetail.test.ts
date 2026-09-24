import type { EntityPageView } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { canEmbedInExpression, entityPanes } from "./entityDetail.js";

/**
 * A record page built from the record type rather than from a widget.
 *
 * Two properties carry this file. Every pane must **parse as an ordinary
 * widget and bind its roles**, because a pane that does not renders as "this
 * view no longer matches its data" — a message that blames the reader's data
 * for a defect here. And a section must be narrowed by a comparison that is
 * right for both a numeric and a textual id, because the failure mode of
 * getting that wrong is an empty section on a record that has rows, which is
 * indistinguishable from the truth.
 */

const page = (input: Partial<EntityPageView> = {}): EntityPageView => ({
  entity: "vendor",
  resource: "vendor",
  name: { one: "Vendor", many: "Vendors" },
  kind: "party",
  identity: "Id",
  title: ["CompanyName"],
  titleMode: "join",
  status: "IsActive",
  detail: { op: "vendors_byid", param: "vendorId" },
  fields: [
    {
      path: "CompanyName",
      label: "Company name",
      description: "Who they trade as.",
      visibility: "primary",
    },
    { path: "IsActive", label: "Active", visibility: "detail" },
    { path: "Category.Name", label: "Category", visibility: "detail", group: "Trade" },
  ],
  facts: [],
  groups: [{ title: "Trade", fields: ["Category.Name"] }],
  sections: [],
  sectionsTotal: 0,
  omitted: [],
  references: [],
  filters: [],
  stats: [],
  ...input,
});

const panesOf = (input: Partial<EntityPageView> = {}, id = "41") =>
  entityPanes({ page: page(input), connection: "api", id });

const byId = (panes: ReturnType<typeof panesOf>, id: string) =>
  panes.find((pane) => pane.id === id);

describe("entityPanes", () => {
  it("builds a header and a record over the same endpoint", () => {
    const panes = panesOf();
    // One request serves both: same connection, op and params, so the cache
    // keys agree and the identity block costs nothing extra.
    expect(byId(panes, "header")?.spec.source).toEqual({
      connection: "api",
      op: "vendors_byid",
      params: { vendorId: "41" },
    });
    expect(byId(panes, "record")?.spec.source).toEqual(byId(panes, "header")?.spec.source);
    expect(byId(panes, "header")?.spec.component).toBe("recordHeader");
    expect(byId(panes, "record")?.spec.component).toBe("record");
  });

  it("puts the id straight into the request, so a link carries everything", () => {
    /*
     * A drill-down interpolates `{{row.Id}}` from the row it was opened from,
     * which is why a cold link can fail to supply what a pane needs. A page is
     * addressed by its id, so there is nothing to interpolate.
     */
    const params = byId(panesOf(), "record")?.spec.source?.params ?? {};
    expect(JSON.stringify(params)).not.toContain("{{");
    expect(params).toEqual({ vendorId: "41" });
  });

  it("flattens nested fields so they can be bound as columns", () => {
    // `Category.Name` is not a column until a derive makes one, and the naming
    // is what `derivedSources` reads back to resolve references.
    const record = byId(panesOf(), "record")?.spec;
    expect(record?.pipeline).toContainEqual({
      op: "derive",
      fields: { Category_Name: "Category.Name" },
    });
    expect(record?.roles.fields).toEqual(["CompanyName", "IsActive", "Category_Name"]);
    expect(byId(panesOf(), "record")?.groups).toEqual([
      { title: "Trade", fields: ["Category_Name"] },
    ]);
  });

  it("shows every field the dictionary left visible, uncapped", () => {
    // Deciding which fields belong to a person is the entity pass's job and it
    // already did it; a second cap here would drop real fields silently.
    const many = Array.from({ length: 60 }, (_, index) => ({
      path: `Field${index}`,
      label: `Field ${index}`,
      visibility: "detail" as const,
    }));
    const record = byId(panesOf({ fields: many, title: [], groups: [] }), "record")?.spec;
    expect(record?.roles.fields).toHaveLength(60);
  });

  it("carries the record type's own words for each column", () => {
    /*
     * The API-wide lexicon holds one entry per bare field name for a whole
     * API, so a task's `Title` and a file's `Title` share it and one of them
     * is always wrong. A record type's dictionary knows which record it is
     * describing — and it carries the descriptions, which the specification
     * supplied for nearly every field and which nothing has ever shown anyone.
     */
    const record = byId(panesOf(), "record");
    expect(record?.fields?.CompanyName).toEqual({
      label: "Company name",
      description: "Who they trade as.",
    });
    // No description was written for this one, and none is invented.
    expect(record?.fields?.IsActive).toEqual({ label: "Active" });
  });

  it("keys those words by column, not by field path", () => {
    // `Category.Name` is not a column until a derive step makes
    // `Category_Name`, and a component only ever sees the latter.
    const record = byId(panesOf(), "record");
    expect(record?.fields?.Category_Name).toEqual({ label: "Category" });
    expect(record?.fields?.["Category.Name"]).toBeUndefined();
  });

  it("gives the header the same words, for the facts it shows", () => {
    expect(byId(panesOf(), "header")?.fields?.CompanyName?.label).toBe("Company name");
  });

  it("omits the header when the record type has no name to show", () => {
    // `recordHeader` requires a title, so emitting one without a name would
    // fail the binding check rather than merely look bare.
    expect(byId(panesOf({ title: [] }), "header")).toBeUndefined();
    expect(byId(panesOf({ title: [] }), "record")).toBeDefined();
  });

  it("omits both when nothing returns one of these records", () => {
    /*
     * 26 of a real API's 108 record types have no by-id endpoint. There is
     * nothing to fetch for one of them, so the page is its collections alone.
     */
    const panes = panesOf({ detail: undefined });
    expect(byId(panes, "header")).toBeUndefined();
    expect(byId(panes, "record")).toBeUndefined();
  });

  it("never binds a display field the dictionary hid", () => {
    /*
     * `display.status` may point at a field marked hidden, and binding a
     * column the pipeline never derives fails the whole pane.
     */
    const panes = panesOf({ status: "Secret" });
    expect(byId(panes, "header")?.spec.roles.status).toBeUndefined();
  });

  const SECTION = {
    id: "workorder-by-VendorId",
    entity: "workorder",
    title: "Work orders",
    field: "VendorId",
    cost: "cheap" as const,
    verified: true,
    columns: ["Title", "Status"],
  };

  it("asks the endpoint for one record's rows where it can be asked", () => {
    const panes = panesOf({
      sections: [{ ...SECTION, reach: { mode: "filter", op: "wo_list", param: "vendorids" } }],
    });
    const section = byId(panes, "workorder-by-VendorId");
    expect(section?.spec.source).toEqual({
      connection: "api",
      op: "wo_list",
      params: { vendorids: "41" },
    });
    // No local filtering: the endpoint answered the question exactly.
    expect(section?.spec.pipeline.some((step) => step.op === "filter")).toBe(false);
    expect(section?.tab).toBe(true);
    // Named as the far record type, so its own references resolve on these rows.
    expect(section?.spec.entity).toBe("workorder");
  });

  it("counts a collection over the very same request the section makes", () => {
    /*
     * Why a stat is free. The query cache keys on connection, endpoint and
     * parameters — never on the pipeline — so a stat asking the same question
     * as its section shares that one fetch and merely runs a different
     * pipeline over the rows already in hand. A stat whose request differed by
     * so much as a parameter would quietly double the cost of every page.
     */
    const panes = panesOf({
      sections: [{ ...SECTION, reach: { mode: "filter", op: "wo_list", param: "vendorids" } }],
      stats: [
        { section: "workorder-by-VendorId", label: "Work items", agg: "count", cost: "cheap" },
      ],
    });

    const section = byId(panes, "workorder-by-VendorId")?.spec;
    const stat = byId(panes, "stat__workorder-by-VendorId");
    expect(stat?.spec.source).toEqual(section?.source);
    expect(stat?.title).toBe("Work items");
    expect(stat?.spec.component).toBe("stat");
    expect(stat?.spec.roles).toEqual({ value: "total" });
    // Above the record, never behind a control.
    expect(stat?.tab).toBe(false);
  });

  it("emits no number for a collection the page dropped", () => {
    // Its rows were never fetched, so counting them would need a request of
    // its own — the one thing these are supposed not to cost.
    const panes = panesOf({
      sections: [],
      stats: [{ section: "workorder-by-VendorId", label: "Work items", agg: "count", cost: "cheap" }],
    });
    expect(panes.some((pane) => pane.id.startsWith("stat__"))).toBe(false);
  });

  it("narrows a scanned collection with a comparison that survives strict equality", () => {
    /*
     * The construction is load-bearing. `VendorId == '41'` is silently false
     * against a numeric column, and `VendorId == 41` is a parse error for a
     * textual id. Coercing both sides to strings is right for either.
     */
    const panes = panesOf({
      sections: [
        {
          ...SECTION,
          reach: { mode: "scan", op: "tx_list", field: "PaymentDetail.Payee.Id", holds: "scalar" },
          cost: "partial",
        },
      ],
    });
    const section = byId(panes, "workorder-by-VendorId")?.spec;
    expect(section?.source?.params).toEqual({});
    expect(section?.pipeline).toContainEqual({
      op: "filter",
      where: "'' + PaymentDetail.Payee.Id == '41'",
    });
  });

  /*
   * A section is keyed `<record type>-by-<field path>`, and on Rentvine every
   * field path nests. Used verbatim inside a widget id — `[a-zA-Z0-9_-]`, 64 at
   * most — every one failed to parse and was dropped silently: "Showing 0 of 3
   * related collections" on a work order that had all three.
   */
  it("keeps a section keyed on a nested field, or on long names", () => {
    const reach = { mode: "filter" as const, op: "wo_list", param: "vendorids" };
    const dotted = { ...SECTION, reach, id: "invoice-by-invoice.workOrderID" };
    const twin = { ...SECTION, reach, id: "invoice-by-invoice_workOrderID" };
    const long = {
      ...SECTION,
      reach,
      id: "association-ownership-account-by-AssociationOwnershipAccount.Property.Id",
    };
    const panes = panesOf({ sections: [dotted, twin, long] });

    for (const id of [dotted.id, twin.id, long.id]) {
      const pane = byId(panes, id);
      expect(pane, id).toBeDefined();
      expect(pane!.spec.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
    /* Two sections that differ only in a dot stay two panes. */
    expect(byId(panes, dotted.id)!.spec.id).not.toBe(byId(panes, twin.id)!.spec.id);
    /* An id that was already valid is left exactly as it was. */
    expect(byId(panes, twin.id)!.spec.id).toBe("vendor__rel__invoice-by-invoice_workOrderID");
  });

  it("refuses a scan whose id cannot be embedded in an expression", () => {
    /*
     * Interpolation happens after the expression was checked, so a quote in
     * the id is a parse error at run time — thrown from a pane that nothing
     * wraps in an error boundary.
     */
    expect(canEmbedInExpression("41")).toBe(true);
    expect(canEmbedInExpression("A-B_1.2")).toBe(true);
    expect(canEmbedInExpression("O'Brien")).toBe(false);
    expect(canEmbedInExpression("a b")).toBe(false);

    const scanning = {
      page: page({
        sections: [
          {
            ...SECTION,
            reach: { mode: "scan" as const, op: "tx_list", field: "VendorId", holds: "scalar" as const },
          },
        ],
      }),
      connection: "api",
    };
    expect(entityPanes({ ...scanning, id: "41" })).toHaveLength(3);
    // The filterable panes still render; only the unsafe section is dropped.
    expect(entityPanes({ ...scanning, id: "O'Brien" })).toHaveLength(2);
  });

  it("lets a row in a section open the record it is", () => {
    /*
     * What stops a page being a dead end. A work order listed under its vendor
     * that cannot be opened leaves the reader looking at the thing they wanted
     * with no way to reach it.
     */
    const panes = panesOf({
      sections: [
        {
          ...SECTION,
          identity: "Id",
          reach: { mode: "filter", op: "wo_list", param: "vendorids" },
        },
      ],
    });
    expect(byId(panes, "workorder-by-VendorId")?.opensEntity).toEqual({
      entity: "workorder",
      column: "Id",
    });
  });

  it("derives a nested identity so a row can still be opened by it", () => {
    // The identity is not a column anybody reads, but it has to be readable
    // *off the row* — and a nested one is not, until a derive flattens it.
    const panes = panesOf({
      sections: [
        {
          ...SECTION,
          identity: "Meta.Id",
          reach: { mode: "filter", op: "wo_list", param: "vendorids" },
        },
      ],
    });
    const section = byId(panes, "workorder-by-VendorId");
    expect(section?.opensEntity?.column).toBe("Meta_Id");
    expect(section?.spec.pipeline).toContainEqual({
      op: "derive",
      fields: { Meta_Id: "Meta.Id" },
    });
    // Derived to be clicked, not to be read: it stays out of the columns.
    expect(section?.spec.roles.columns).toEqual(["Title", "Status"]);
  });

  it("leaves a section read-only when its record type has no identity", () => {
    /*
     * 11 of a real API's 108 record types have no identified field. A row that
     * looks clickable and does nothing is worse than one that plainly does
     * not, so the pane carries no target at all.
     */
    const panes = panesOf({
      sections: [{ ...SECTION, reach: { mode: "filter", op: "wo_list", param: "vendorids" } }],
    });
    expect(byId(panes, "workorder-by-VendorId")?.opensEntity).toBeUndefined();
  });

  it("skips a section whose record type has nothing to show", () => {
    // A table must bind at least one column. Defensive rather than observed:
    // every section on a real API has columns, but a stub entity has none.
    const panes = panesOf({
      sections: [
        { ...SECTION, columns: [], reach: { mode: "filter", op: "wo_list", param: "vendorids" } },
      ],
    });
    expect(byId(panes, "workorder-by-VendorId")).toBeUndefined();
  });

  it("lets a widget name which collections it wants, and in what order", () => {
    const sections = [
      { ...SECTION, reach: { mode: "filter" as const, op: "wo_list", param: "vendorids" } },
      {
        ...SECTION,
        id: "bill-by-VendorId",
        entity: "bill",
        title: "Bills",
        reach: { mode: "filter" as const, op: "bill_list", param: "vendorid" },
      },
    ];
    const panes = entityPanes({
      page: page({ sections }),
      connection: "api",
      id: "41",
      override: { sections: ["bill-by-VendorId"] },
    });
    expect(panes.filter((pane) => pane.tab).map((pane) => pane.id)).toEqual(["bill-by-VendorId"]);
  });

  it("lets a widget hide a field the shared page shows", () => {
    const panes = entityPanes({
      page: page(),
      connection: "api",
      id: "41",
      override: { hide: ["IsActive"] },
    });
    expect(byId(panes, "record")?.spec.roles.fields).toEqual(["CompanyName", "Category_Name"]);
    // Hiding the field the status pointed at unbinds the status too, rather
    // than leaving the header bound to a column that is no longer produced.
    expect(byId(panes, "header")?.spec.roles.status).toBeUndefined();
  });
});
