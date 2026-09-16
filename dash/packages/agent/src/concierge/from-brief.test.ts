import {
  compileBrief,
  entitySchema,
  resolveRange,
  resourceSchema,
  type EntitySpec,
  type WidgetBrief,
} from "@freebirdai/dash-spec";
import { executeWidget } from "@freebirdai/dash-runtime";
import { describe, expect, it } from "vitest";
import { inferShape } from "../infer.js";
import type { ConciergeContext } from "./steps.js";
import { readiness } from "./steps.js";
import { buildAll, buildFromDraft } from "./build.js";
import { newDraft } from "./draft.js";
import { patchFromBrief } from "./from-brief.js";
import { revise, takeReading } from "./revise.js";

/**
 * A brief, as an answer the existing setup already understands.
 *
 * What matters here is the direction of the translation. A widget binds
 * columns and a draft names the API's own fields, and the two differ exactly
 * where a field nests — so a patch that handed `Category_Name` to a draft
 * would name a field the endpoint does not have, and every role would fail to
 * bind one layer later.
 */

const entity = (): EntitySpec =>
  entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"], status: "Status" },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary" },
      { path: "Category.Name", label: "Category", kinds: ["string"], visibility: "detail" },
      { path: "Cost", label: "Cost", semantic: "currency", visibility: "detail" },
    ],
  });

const patchFor = (brief: Partial<WidgetBrief>) =>
  patchFromBrief({
    brief: { entity: "task", intent: "records", ...brief } as WidgetBrief,
    entity: entity(),
    resource: resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" }),
    connection: "api",
    id: "w1",
  });

describe("patchFromBrief", () => {
  it("answers the setup's own questions, so its card is untouched", () => {
    const { patch, errors } = patchFor({ intent: "records", filters: [{ field: "Category.Name" }] });

    expect(errors).toEqual([]);
    expect(patch).toMatchObject({
      connection: "api",
      endpoint: "tasks_list",
      component: "table",
    });
    // A strip above the rows, never a pipeline filter: the distinction the
    // whole brief exists to keep.
    expect(patch.filters).toEqual(["Category.Name"]);
    expect(patch.groupBy).toBeUndefined();
    expect(patch.measure).toBeUndefined();
  });

  it("names the API's own fields, not the columns a widget binds", () => {
    /*
     * The translation that has to run backwards. `Category.Name` becomes the
     * column `Category_Name` in a widget, and a draft handed that name would
     * be naming a field its endpoint does not have.
     */
    const { patch } = patchFor({ intent: "records", filters: [{ field: "Category.Name" }] });
    expect(patch.filters).not.toContain("Category_Name");
    expect(Object.values(patch.roles ?? {}).flat()).not.toContain("Category_Name");
  });

  it("binds every role the component needs, so nothing is left to ask", () => {
    // The point of deciding entity-first: the questions that used to bind raw
    // endpoint fields to roles have already been answered.
    const { patch } = patchFor({ intent: "records" });
    expect(patch.roles?.columns).toEqual(["Title", "Status"]);
  });

  it("carries a measurement as a shape, which is the key that can hold one", () => {
    /*
     * A patch cannot express a measurement as *steps* — `measure` and `groupBy`
     * change a shape that already exists, and a `value` role bound to an
     * aggregate column names a field the endpoint has not got. It can express
     * one as a shape, which is a different thing and a first-class patch key.
     *
     * Handing back nothing was not neutral. With the endpoint-first planner
     * retired there is nothing behind this, so a chart request came back as a
     * refusal to build a brief that had compiled perfectly well.
     */
    const compare = patchFor({ intent: "compare", groupBy: "Category.Name" }).patch;
    expect(compare).toMatchObject({
      endpoint: "tasks_list",
      component: "bar",
      shape: {
        // The API's own spelling, not the column the widget binds. `build`
        // flattens it again on the way out.
        groupBy: [{ field: "Category.Name" }],
        measures: [{ as: "value", agg: "count" }],
      },
    });
    /*
     * No roles: after a group step the endpoint's columns are gone, and
     * `buildFromDraft` replaces whatever a patch bound with `rolesForShape`.
     */
    expect(compare.roles).toBeUndefined();

    const measure = patchFor({ intent: "measure", measure: { agg: "sum", field: "Cost" } }).patch;
    expect(measure).toMatchObject({
      component: "stat",
      shape: { measures: [{ as: "value", agg: "sum", field: "Cost" }] },
    });
    /*
     * Totalling every row is grouping on a literal, which `shapeSteps` puts
     * back on the way out — carrying it here would name a column the endpoint
     * has never heard of.
     */
    expect(measure.shape?.groupBy).toEqual([]);
  });

  it("counts nothing on a plain list of records", () => {
    // A measure on a list would aggregate the records away, which is the same
    // failure as charting them.
    expect(patchFor({ intent: "records" }).patch.measure).toBeUndefined();
  });

  it("hands back nothing at all when the brief could not be built", () => {
    // Nothing lists these records, so there is no endpoint to build on — and
    // an empty patch leaves the setup to say so rather than half-answering.
    const { patch, errors } = patchFromBrief({
      brief: { entity: "task", intent: "records" },
      entity: entity(),
      resource: resourceSchema.parse({ id: "task", title: "Tasks" }),
      connection: "api",
      id: "w1",
    });
    expect(patch).toEqual({});
    expect(errors.join(" ")).toContain("no endpoint that returns them");
  });
});

/**
 * The seam where the two halves actually meet.
 *
 * A patch is only worth anything if the setup accepts it, and the risk is
 * specific: a draft's field pool comes from the endpoint's inferred shape
 * while these names come from the record type's dictionary. If those two
 * disagree about what a field is called, every role is rejected and the card
 * asks the questions the whole rewrite exists to stop asking — and no test on
 * either side alone would notice.
 */
describe("a brief, through the setup it feeds", () => {
  const context: ConciergeContext = {
    connections: [{ id: "api", title: "The API" }],
    ops: [{ id: "tasks_list", title: "Tasks", connection: "api" }],
    shapes: {
      tasks_list: inferShape({
        data: [
          { Id: 1, Title: "Leak", Status: "Open", Category: { Name: "Repair" }, Cost: 120 },
          { Id: 2, Title: "Paint", Status: "Done", Category: { Name: "Upkeep" }, Cost: 40 },
        ],
      }),
    },
    joins: [],
    children: [],
    drillDowns: [],
    searchable: [],
    rangeFilterable: [],
    readPlans: [],
  } as unknown as ConciergeContext;

  it("is accepted whole, with nothing left to ask", () => {
    const { patch } = patchFor({ intent: "records", filters: [{ field: "Category.Name" }] });
    const revised = revise(
      newDraft("d1", "tasks with a filter by category", "assisted"),
      patch,
      context,
    );

    // Every name the record type supplied is one the endpoint really has.
    expect(revised.rejected).toEqual([]);
  });

  it("builds the list with a filter strip that started all of this", () => {
    const { patch } = patchFor({ intent: "records", filters: [{ field: "Category.Name" }] });
    const revised = revise(
      newDraft("d1", "tasks with a filter by category", "assisted"),
      patch,
      context,
    );
    const built = buildFromDraft(revised.draft, context);

    expect(built.errors).toEqual([]);
    expect(built.widget?.component).toBe("table");
    expect(built.widget?.facets?.map((facet) => facet.field)).toEqual(["Category_Name"]);
    // Records, not counts: the failure this whole path replaces.
    expect(built.widget?.pipeline.some((step) => step.op === "group")).toBe(false);
  });

  it("carries the record type all the way onto the widget", () => {
    /*
     * The link between deciding entity-first and *behaving* entity-first.
     * Without it the brief chose a record type and the widget it produced knew
     * nothing about one — so its rows opened a private record view, planned by
     * its own model call and frozen the day it was written, instead of the
     * shared page every route into a record arrives at.
     */
    const { patch } = patchFor({ intent: "records" });
    expect(patch.entity).toBe("task");

    const revised = revise(newDraft("d1", "my tasks", "assisted"), patch, context);
    expect(revised.draft.entity).toBe("task");

    const built = buildFromDraft(revised.draft, context);
    expect(built.widget?.entity).toBe("task");
  });

  it("names the widget after the records, not after the endpoint", () => {
    /*
     * An endpoint title is the API's own vocabulary and belongs in the
     * inspector. Falling back to it put "Retrieve all units" on the card and
     * "table of retrieve all units, built from your answers" under it — a
     * sentence about somebody's REST API rather than about their work.
     */
    const named = {
      ...context,
      records: { api: { task: { id: "task", one: "Task", many: "Tasks" } } },
    } as ConciergeContext;

    const { patch } = patchFor({ intent: "records" });
    const revised = revise(newDraft("d1", "my tasks", "assisted"), patch, named);
    const built = buildFromDraft(revised.draft, named);

    expect(built.widget?.title).toBe("Tasks");
    expect(built.widget?.title.toLowerCase()).not.toContain("retrieve");
  });

  it("leaves the card nothing to ask, which is what makes it a preview", () => {
    /*
     * Measured across a real API's 108 record types: every one that is a
     * widget at all arrives with zero questions outstanding. That is the whole
     * basis of "here's the widget, adjust it" — the card shows a preview and a
     * set of controls rather than walking a queue, and it can only do that
     * because nothing is left unanswered.
     *
     * Pinned here because the failure is silent and gradual: one role the
     * compiler stops binding, or one name the two sides spell differently, and
     * the card quietly becomes a form again.
     */
    const { patch } = patchFor({ intent: "records", filters: [{ field: "Category.Name" }] });
    const revised = revise(newDraft("d1", "my tasks", "assisted"), patch, context);

    expect(revised.rejected).toEqual([]);
    expect(readiness(revised.draft, context).missing).toEqual([]);
    // Ready means the state route builds a widget, which is what gets previewed.
    expect(readiness(revised.draft, context).ready).toBe(true);
  });

  it("builds the chart it was asked for, through the card that builds it", () => {
    /*
     * The regression this exists to stop. Retiring the endpoint-first planner
     * left nothing behind `patchFromBrief`, which bailed on every intent but
     * `records` — so "how many per category" came back as "I could not build a
     * widget of Tasks from what this API offers", of a brief that had
     * compiled. Neither side alone would have noticed: the brief compiles, the
     * card accepts patches, and the patch between them was empty.
     */
    const { patch } = patchFor({ intent: "compare", groupBy: "Category.Name" });
    const revised = revise(newDraft("d2", "how many per category", "assisted"), patch, context);
    expect(revised.rejected).toEqual([]);

    const built = buildFromDraft(revised.draft, context);
    expect(built.errors).toEqual([]);
    expect(built.widget?.component).toBe("bar");
    // Grouped on the column a derive really produces, not on the dotted name.
    expect(built.widget?.pipeline).toContainEqual({
      op: "group",
      by: [{ field: "Category_Name" }],
      agg: { value: "count()" },
    });
    expect(built.widget?.roles).toEqual({ category: "Category_Name", value: "value" });
  });

  it("totals a number the same way", () => {
    const { patch } = patchFor({ intent: "measure", measure: { agg: "sum", field: "Cost" } });
    const revised = revise(newDraft("d3", "what it all costs", "assisted"), patch, context);
    expect(revised.rejected).toEqual([]);

    const built = buildFromDraft(revised.draft, context);
    expect(built.errors).toEqual([]);
    expect(built.widget?.component).toBe("stat");
    expect(built.widget?.pipeline).toContainEqual({
      op: "group",
      by: [{ field: "_all" }],
      agg: { value: "sum(Cost)" },
    });
  });
});

/**
 * Two record types, through the card that builds them.
 *
 * The half of a request the brief could not carry. "My work alongside who is
 * doing it" named two collections, and a brief names one — so it fell through
 * to a planner that hunted endpoints, and everything the record types had
 * already settled went with it.
 *
 * The seam is narrow and easy to get wrong in a way no unit test on either
 * side would see: the compiled widget prefixes the far side's columns with the
 * record type's name and the card prefixes them with the endpoint's, so a
 * patch handing the first to the second binds columns that never exist.
 */
describe("a brief that names two record types", () => {
  const task: EntitySpec = entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"], status: "Status" },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary" },
      { path: "SupplierId", label: "Supplier", visibility: "detail", reference: { entity: "supplier" } },
    ],
  });

  const supplier: EntitySpec = entitySchema.parse({
    id: "supplier",
    resource: "supplier",
    name: { one: "Supplier", many: "Suppliers" },
    kind: "party",
    identity: { field: "Id", observed: true },
    display: { title: ["Name"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Name", label: "Name", visibility: "primary" },
      { path: "Phone", label: "Phone", visibility: "primary" },
    ],
  });

  const resources = [
    resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" }),
    resourceSchema.parse({ id: "supplier", title: "Suppliers", listOp: "suppliers_list" }),
  ];

  const joined = patchFromBrief({
    brief: { entity: "task", intent: "records", alongside: { entity: "supplier" } },
    entity: task,
    resource: resources[0]!,
    connection: "api",
    id: "w1",
    related: {
      entities: [task, supplier],
      resources,
      ops: [
        { id: "tasks_list", path: "/tasks" },
        { id: "suppliers_list", path: "/suppliers" },
      ],
    },
  });

  const context: ConciergeContext = {
    connections: [{ id: "api", title: "The API" }],
    ops: [
      { id: "tasks_list", title: "Tasks", connection: "api" },
      { id: "suppliers_list", title: "Suppliers", connection: "api" },
    ],
    shapes: {
      tasks_list: inferShape({
        data: [
          { Id: 1, Title: "Leak", Status: "Open", SupplierId: 9 },
          { Id: 2, Title: "Paint", Status: "Done", SupplierId: 7 },
        ],
      }),
      suppliers_list: inferShape({
        data: [
          { Id: 9, Name: "Acme", Phone: "555-0101" },
          { Id: 7, Name: "Bright", Phone: "555-0102" },
        ],
      }),
    },
    joins: [],
    children: [],
    drillDowns: [],
    searchable: [],
    rangeFilterable: [],
    readPlans: [],
  } as unknown as ConciergeContext;

  it("hands the card a join, matched on the field the API itself records", () => {
    expect(joined.errors).toEqual([]);
    expect(joined.patch.endpoint).toBe("tasks_list");
    expect(joined.patch.joinWith).toEqual({
      endpoint: "suppliers_list",
      leftField: "SupplierId",
      rightField: "Id",
      kind: "left",
    });
  });

  it("names the far columns the way the card will, not the way the widget did", () => {
    // `runPlan` prefixes with the source's name, and the two halves of this
    // system name that source differently. One translation, here.
    expect(joined.patch.roles?.columns).toContain("suppliers_list_Name");
    expect(joined.patch.roles?.columns).not.toContain("supplier_Name");
  });

  it("is accepted whole, and builds a widget that reads both endpoints", () => {
    const revised = revise(
      newDraft("d1", "tasks alongside their suppliers", "assisted"),
      joined.patch,
      context,
    );
    expect(revised.rejected).toEqual([]);

    const built = buildFromDraft(revised.draft, context);
    expect(built.errors).toEqual([]);
    expect(built.widget?.sources.map((one) => one.op)).toEqual(["tasks_list", "suppliers_list"]);
    expect(built.widget?.combine).toMatchObject({
      op: "join",
      on: { left: "SupplierId", right: "Id" },
    });
    expect(built.widget?.roles.columns).toContain("suppliers_list_Name");
  });
});

/**
 * A link that lives inside another record.
 *
 * The common shape on a real API, and the one that failed silently: a task
 * carries a `Supplier` object, so `Supplier.Id` is a path into it rather than
 * a column, and `joinRows` reads one flat key off each row. Matching on the
 * dotted name found nothing on any row — so the join kept every row with the
 * far columns empty, having fetched the second endpoint and paid for it.
 */
describe("a join on a field inside another record", () => {
  const task: EntitySpec = entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"], status: "Status" },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary" },
      { path: "Supplier", label: "Supplier", kinds: ["object"], visibility: "detail" },
      {
        path: "Supplier.Id",
        label: "Supplier",
        visibility: "detail",
        reference: { entity: "supplier", holds: "objectRef" },
      },
    ],
  });

  const supplier: EntitySpec = entitySchema.parse({
    id: "supplier",
    resource: "supplier",
    name: { one: "Supplier", many: "Suppliers" },
    kind: "party",
    identity: { field: "Id", observed: true },
    display: { title: ["Name"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Name", label: "Name", visibility: "primary" },
    ],
  });

  const resources = [
    resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" }),
    resourceSchema.parse({ id: "supplier", title: "Suppliers", listOp: "suppliers_list" }),
  ];

  const built = patchFromBrief({
    brief: { entity: "task", intent: "records", alongside: { entity: "supplier" } },
    entity: task,
    resource: resources[0]!,
    connection: "api",
    id: "w1",
    related: {
      entities: [task, supplier],
      resources,
      ops: [
        { id: "tasks_list", path: "/tasks" },
        { id: "suppliers_list", path: "/suppliers" },
      ],
    },
  });

  const context: ConciergeContext = {
    connections: [{ id: "api", title: "The API" }],
    ops: [
      { id: "tasks_list", title: "Tasks", connection: "api" },
      { id: "suppliers_list", title: "Suppliers", connection: "api" },
    ],
    shapes: {
      tasks_list: inferShape({
        data: [
          { Id: 1, Title: "Leak", Status: "Open", Supplier: { Id: 9 } },
          { Id: 2, Title: "Paint", Status: "Done", Supplier: { Id: 7 } },
        ],
      }),
      suppliers_list: inferShape({
        data: [
          { Id: 9, Name: "Acme" },
          { Id: 7, Name: "Bright" },
        ],
      }),
    },
    joins: [],
    children: [],
    drillDowns: [],
    searchable: [],
    rangeFilterable: [],
    readPlans: [],
  } as unknown as ConciergeContext;

  it("names the field as the API spells it, nesting and all", () => {
    expect(built.patch.joinWith).toMatchObject({
      endpoint: "suppliers_list",
      leftField: "Supplier.Id",
      rightField: "Id",
    });
  });

  it("flattens the key on the side it belongs to, before the match", () => {
    const revised = revise(
      newDraft("d1", "tasks alongside their suppliers", "assisted"),
      built.patch,
      context,
    );
    expect(revised.rejected).toEqual([]);

    const widget = buildFromDraft(revised.draft, context).widget!;
    expect(widget.sources[0]?.pipeline).toContainEqual({
      op: "derive",
      fields: { Supplier_Id: "Supplier.Id" },
    });
    expect(widget.combine).toMatchObject({ on: { left: "Supplier_Id", right: "Id" } });
  });

  it("matches real rows, which a dotted key silently did not", () => {
    const revised = revise(
      newDraft("d1", "tasks alongside their suppliers", "assisted"),
      built.patch,
      context,
    );
    const widget = buildFromDraft(revised.draft, context).widget!;
    const output = executeWidget(
      widget,
      {
        tasks_list: { data: [{ Id: 1, Title: "Leak", Status: "Open", Supplier: { Id: 9 } }] },
        suppliers_list: { data: [{ Id: 9, Name: "Acme" }] },
      },
      { now: 0, params: { range: resolveRange({ preset: "30d", now: 0 }), filters: {} }, timeZone: "UTC" },
    );

    expect(output.errors).toEqual([]);
    expect(output.rows[0]).toMatchObject({ suppliers_list_Name: "Acme" });
    // The warning a join earns when it matched nothing — and must not earn here.
    expect(output.meta?.warnings.join(" ") ?? "").not.toMatch(/had no match/);
  });
});

/**
 * The brief, all the way onto the widget.
 *
 * Storing it on the compiled widget is only half of it: the chat does not save
 * what `compileBrief` returns, it turns it into a patch and rebuilds through
 * the card. So the link that matters is this one — and if it broke, every
 * chat-built widget would reach the board brief-less and its settings would
 * fall back to styling, which is the failure the whole change exists to end.
 */
describe("the brief, through the card and onto the widget", () => {
  const context: ConciergeContext = {
    connections: [{ id: "api", title: "The API" }],
    ops: [{ id: "tasks_list", title: "Tasks", connection: "api" }],
    shapes: {
      tasks_list: inferShape({
        data: [
          { Id: 1, Title: "Leak", Status: "Open", Category: { Name: "Repair" }, Cost: 120 },
          { Id: 2, Title: "Paint", Status: "Done", Category: { Name: "Upkeep" }, Cost: 40 },
        ],
      }),
    },
    joins: [],
    children: [],
    drillDowns: [],
    searchable: [],
    rangeFilterable: [],
    readPlans: [],
  } as unknown as ConciergeContext;

  it("arrives on the built widget, as the request that was actually made", () => {
    const { patch } = patchFor({ intent: "records", filters: [{ field: "Category.Name" }] });
    const revised = revise(newDraft("d1", "tasks by category", "assisted"), patch, context);
    expect(revised.rejected).toEqual([]);

    const built = buildFromDraft(revised.draft, context);
    expect(built.widget?.brief).toMatchObject({
      entity: "task",
      intent: "records",
      filters: [{ field: "Category.Name" }],
    });
  });

  it("is dropped when an answer changes something it also describes", () => {
    /*
     * A brief left standing after the card changed a view would make the next
     * settings edit quietly undo that change. Dropping costs the richer
     * controls and falls back to the ones a widget built before briefs existed
     * already gets — which is honest, where keeping it is not.
     */
    const { patch } = patchFor({ intent: "records" });
    const first = revise(newDraft("d2", "my tasks", "assisted"), patch, context);
    expect(first.draft.brief).toBeDefined();

    const changed = revise(first.draft, { component: "cards" }, context);
    expect(changed.draft.brief).toBeUndefined();
    expect(buildFromDraft(changed.draft, context).widget?.brief).toBeUndefined();
  });

  it("survives an answer that says nothing about what the widget shows", () => {
    const { patch } = patchFor({ intent: "records" });
    const first = revise(newDraft("d3", "my tasks", "assisted"), patch, context);
    const styled = revise(first.draft, { highlights: [] }, context);
    expect(styled.draft.brief).toBeDefined();
  });
});

/**
 * Two things asked for together, built together.
 *
 * The machinery for several widgets in one setup has existed and been
 * unreachable: the chat's tool schema exposed `interleave` but neither `parts`
 * nor `group`, and the proposer emitted one widget. So `buildAll`'s multi-widget
 * branch, the arrangement chips and the badged combined list were all wired to
 * nothing.
 *
 * What is guarded here is the seam. Each part has to be a whole widget in its
 * own right — its own record type, its own brief — or the second one claims to
 * answer a request about the first one's records.
 */
describe("two briefs, one setup", () => {
  const supplier: EntitySpec = entitySchema.parse({
    id: "supplier",
    resource: "supplier",
    name: { one: "Supplier", many: "Suppliers" },
    kind: "party",
    identity: { field: "Id", observed: true },
    display: { title: ["Name"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Name", label: "Name", visibility: "primary" },
      { path: "Phone", label: "Phone", visibility: "primary" },
    ],
  });

  const context: ConciergeContext = {
    connections: [{ id: "api", title: "The API" }],
    ops: [
      { id: "tasks_list", title: "Tasks", connection: "api" },
      { id: "suppliers_list", title: "Suppliers", connection: "api" },
    ],
    shapes: {
      tasks_list: inferShape({
        data: [
          { Id: 1, Title: "Leak", Status: "Open", Category: { Name: "Repair" }, Cost: 120 },
          { Id: 2, Title: "Paint", Status: "Done", Category: { Name: "Upkeep" }, Cost: 40 },
        ],
      }),
      suppliers_list: inferShape({
        data: [
          { Id: 9, Name: "Acme", Phone: "555-0101" },
          { Id: 7, Name: "Bright", Phone: "555-0102" },
        ],
      }),
    },
    joins: [],
    children: [],
    drillDowns: [],
    searchable: [],
    rangeFilterable: [],
    readPlans: [],
  } as unknown as ConciergeContext;

  const both = (view?: "list") => {
    const first = patchFor({ intent: "records", ...(view ? { view } : {}) }).patch;
    const second = patchFromBrief({
      brief: { entity: "supplier", intent: "records", ...(view ? { view } : {}) },
      entity: supplier,
      resource: resourceSchema.parse({ id: "supplier", title: "Suppliers", listOp: "suppliers_list" }),
      connection: "api",
      id: "supplier",
    }).patch;
    return { ...first, parts: [second], group: { title: "Tasks and Suppliers" } };
  };

  it("builds one widget per thing asked for, with ids that do not collide", () => {
    const revised = revise(newDraft("d1", "tasks and suppliers", "assisted"), both(), context);
    expect(revised.rejected).toEqual([]);

    const built = buildAll(revised.draft, context);
    expect(built.errors).toEqual([]);
    expect(built.widgets).toHaveLength(2);
    expect(new Set(built.widgets.map((one) => one.id)).size).toBe(2);
  });

  it("gives each widget its own record type and its own request", () => {
    /*
     * The bug this would have hit on its first day: `entity` lived only on the
     * setup, so `partView` never cleared it and both widgets would have been
     * stamped with the first one's record type — the wrong record page behind
     * every row of the second.
     */
    const revised = revise(newDraft("d2", "tasks and suppliers", "assisted"), both(), context);
    const built = buildAll(revised.draft, context);

    expect(built.widgets.map((one) => one.entity)).toEqual(["task", "supplier"]);
    expect(built.widgets.map((one) => one.brief?.entity)).toEqual(["task", "supplier"]);
  });

  it("keeps them together, which is what being asked for together means", () => {
    const revised = revise(newDraft("d3", "tasks and suppliers", "assisted"), both(), context);
    const built = buildAll(revised.draft, context);
    expect(built.group).toMatchObject({ title: "Tasks and Suppliers" });
  });

  it("stacks them into one badged list when that is what was asked for", () => {
    /*
     * `interleave` has been in the chat's tool schema all along and could never
     * fire: it is gated on there being more than one part, and nothing made a
     * second part. This is the other reading of "show me these together".
     */
    const revised = revise(
      newDraft("d4", "everything in one list", "assisted"),
      { ...both("list"), interleave: true },
      context,
    );
    const built = buildAll(revised.draft, context);

    expect(built.errors).toEqual([]);
    expect(built.widgets).toHaveLength(1);
    expect(built.widgets[0]?.combine).toMatchObject({ op: "union" });
    expect(built.widgets[0]?.sources.map((one) => one.op)).toEqual([
      "tasks_list",
      "suppliers_list",
    ]);
  });

  it("refuses to stack two record types into a table, and says why", () => {
    /*
     * A table of two kinds of record is columns that are half empty on every
     * row. Refused with the readings that would work, rather than drawn.
     */
    const revised = revise(
      newDraft("d5", "everything in one table", "assisted"),
      { ...both(), interleave: true },
      context,
    );
    const built = buildAll(revised.draft, context);

    expect(built.widgets).toEqual([]);
    expect(built.errors.join(" ")).toContain("half empty");
  });
});

/**
 * The other reading of the same words.
 *
 * "My tasks" means the records or a count of them, and both answer the one
 * thing somebody said. The assistant picks, builds, and keeps the reading it
 * did not take — the chat's system prompt has promised for a release that it
 * is "offered back as one click", and nothing could act on it: the label
 * reached the reply and stopped there.
 *
 * What is guarded here is that taking it is a *rebuild*, not a merge. A list
 * and a chart share no view, no roles and no measurement, so folding one into
 * the other leaves a chart wearing a table's column bindings — which `revise`
 * then reports as a handful of rejections rather than one swap.
 */
describe("the reading nobody took", () => {
  const context: ConciergeContext = {
    connections: [{ id: "api", title: "The API" }],
    ops: [{ id: "tasks_list", title: "Tasks", connection: "api" }],
    shapes: {
      tasks_list: inferShape({
        data: [
          { Id: 1, Title: "Leak", Status: "Open", Category: { Name: "Repair" }, Cost: 120 },
          { Id: 2, Title: "Paint", Status: "Done", Category: { Name: "Upkeep" }, Cost: 40 },
        ],
      }),
    },
    joins: [],
    children: [],
    drillDowns: [],
    searchable: [],
    rangeFilterable: [],
    readPlans: [],
  } as unknown as ConciergeContext;

  /** The records, with the count of them by category kept on the side. */
  const listing = () => {
    const { patch } = patchFor({ intent: "records", title: "My tasks" });
    return revise(newDraft("d1", "my tasks", "assisted"), {
      ...patch,
      alternative: {
        label: "how many there are in each category",
        brief: { entity: "task", intent: "compare", groupBy: "Category.Name" },
      },
    }, context).draft;
  };

  it("keeps the reading it did not take, on the draft rather than in a sentence", () => {
    expect(listing().alternative).toMatchObject({
      label: "how many there are in each category",
      brief: { entity: "task", intent: "compare" },
    });
  });

  it("leaves it alone when a later patch only adjusts what was built", () => {
    // Sorting a list says nothing about whether it should have been a chart.
    const next = revise(listing(), { title: "Open work" }, context).draft;
    expect(next.alternative?.label).toBe("how many there are in each category");
  });

  it("rebuilds from the other reading rather than merging it in", () => {
    const before = listing();
    const { patch } = patchFor({ intent: "compare", groupBy: "Category.Name" });
    const after = takeReading(before, { label: "a count by category", patch }, context);

    expect(after.rejected).toEqual([]);
    const built = buildFromDraft(after.draft, context);
    expect(built.errors).toEqual([]);
    expect(built.widget?.component).toBe("bar");
    // The list's own bindings are gone, not carried into a chart that has no
    // use for them.
    expect(after.draft.brief?.intent).toBe("compare");
  });

  it("offers the reading it just left, so the chip goes both ways", () => {
    const before = listing();
    const { patch } = patchFor({ intent: "compare", groupBy: "Category.Name" });
    const after = takeReading(before, { label: "a count by category", patch }, context);

    expect(after.draft.alternative).toMatchObject({
      label: "My tasks",
      brief: { entity: "task", intent: "records" },
    });
  });

  it("stays in the same sitting, so nobody is asked whether to resume it", () => {
    const before = listing();
    const { patch } = patchFor({ intent: "compare", groupBy: "Category.Name" });
    const after = takeReading(before, { label: "a count by category", patch }, context);

    expect(after.draft.id).toBe(before.id);
    expect(after.draft.startedAt).toBe(before.startedAt);
    expect(after.draft.intent).toBe("my tasks");
    expect(after.draft.mode).toBe("assisted");
  });

  it("offers no way back when nothing recorded what the widget was asked for", () => {
    /*
     * A brief is dropped whenever an answer redescribes the widget, and a chip
     * that rebuilt from a brief which no longer matches what is on screen
     * would undo that answer silently. Leaving the offer off says so.
     */
    const before = { ...listing(), brief: undefined };
    const { patch } = patchFor({ intent: "compare", groupBy: "Category.Name" });
    expect(takeReading(before, { label: "a count", patch }, context).draft.alternative).toBeUndefined();
  });
});

/**
 * Two kinds of record measured on one axis, through the card.
 *
 * The compiler has built these since `alongside: beside` existed, and the card
 * refused every one: "compares two kinds of record, which the setup card
 * cannot carry yet". The card could — it has carried a comparison as
 * `seriesWith` all along — but the only thing that ever wrote one was the
 * endpoint-first planner, and retiring it left the machinery complete and
 * unreachable.
 */
describe("a comparison of two record types, through the setup it feeds", () => {
  const task: EntitySpec = entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "CreatedOn", label: "Created", semantic: "timestamp", format: "iso8601", visibility: "detail" },
    ],
  });

  const bill: EntitySpec = entitySchema.parse({
    id: "bill",
    resource: "bill",
    name: { one: "Bill", many: "Bills" },
    kind: "money",
    identity: { field: "Id", observed: true },
    display: { title: ["Memo"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Memo", label: "Memo", visibility: "primary" },
      { path: "CreatedOn", label: "Created", semantic: "timestamp", format: "iso8601", visibility: "detail" },
    ],
  });

  const resources = [
    resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" }),
    resourceSchema.parse({ id: "bill", title: "Bills", listOp: "bills_list" }),
  ];

  const compared = patchFromBrief({
    brief: {
      entity: "task",
      intent: "compare",
      groupBy: "CreatedOn",
      alongside: { entity: "bill", as: "beside" },
    },
    entity: task,
    resource: resources[0]!,
    connection: "api",
    id: "w1",
    related: {
      entities: [task, bill],
      resources,
      ops: [
        { id: "tasks_list", path: "/tasks" },
        { id: "bills_list", path: "/bills" },
      ],
    },
  });

  const tasks = [
    { Id: 1, Title: "Leak", CreatedOn: "2026-01-04T10:00:00Z" },
    { Id: 2, Title: "Paint", CreatedOn: "2026-01-20T10:00:00Z" },
    { Id: 3, Title: "Roof", CreatedOn: "2026-02-02T10:00:00Z" },
  ];
  const bills = [{ Id: 9, Memo: "Water", CreatedOn: "2026-02-11T10:00:00Z" }];

  const context: ConciergeContext = {
    connections: [{ id: "api", title: "The API" }],
    ops: [
      { id: "tasks_list", title: "Tasks", connection: "api" },
      { id: "bills_list", title: "Bills", connection: "api" },
    ],
    shapes: {
      tasks_list: inferShape(tasks),
      bills_list: inferShape(bills),
    },
    joins: [],
    children: [],
    drillDowns: [],
    searchable: [],
    rangeFilterable: [],
    readPlans: [],
  } as unknown as ConciergeContext;

  it("hands the card the second record type as a side, not a refusal", () => {
    expect(compared.notes.join(" ")).not.toContain("cannot carry");
    expect(compared.patch.endpoint).toBe("tasks_list");
    expect(compared.patch.seriesWith?.map((side) => side.endpoint)).toEqual(["bills_list"]);
  });

  it("reads each side's measurement off its own source, in the API's spelling", () => {
    expect(compared.patch.shape?.groupBy[0]?.field).toBe("CreatedOn");
    expect(compared.patch.seriesWith?.[0]?.shape.groupBy[0]?.field).toBe("CreatedOn");
  });

  it("is accepted whole, and builds one chart over both endpoints", () => {
    const revised = revise(newDraft("d1", "tasks against bills by month", "assisted"), compared.patch, context);
    expect(revised.rejected).toEqual([]);

    const built = buildFromDraft(revised.draft, context);
    expect(built.errors).toEqual([]);
    expect(built.widget?.sources.map((one) => one.op)).toEqual(["tasks_list", "bills_list"]);
    expect(built.widget?.combine).toMatchObject({ op: "union" });
  });

  it("carries each side's date conversion, keyed by the API's own field", () => {
    expect(compared.patch.coercions).toEqual({ CreatedOn: "iso->datetime" });
    expect(compared.patch.seriesWith?.[0]?.coercions).toEqual({ CreatedOn: "iso->datetime" });
  });

  it("draws each side's own counts on one monthly axis", () => {
    /*
     * The end of the chain, run against rows rather than inspected: a
     * comparison the card accepted but could not execute would pass every
     * assertion above and still render nothing.
     */
    const revised = revise(newDraft("d1", "tasks against bills by month", "assisted"), compared.patch, context);
    const widget = buildFromDraft(revised.draft, context).widget!;
    // Bodies are keyed by source name, and the builder names its sides itself.
    const bodies = Object.fromEntries(
      widget.sources.map((source) => [source.as, source.op === "tasks_list" ? tasks : bills]),
    );
    const result = executeWidget(
      widget,
      bodies,
      { now: 0, params: { range: resolveRange({ preset: "12mo", now: 0 }), filters: {} }, timeZone: "UTC" },
    );

    expect(result.errors).toEqual([]);
    // Two months of tasks, one of bills — and each point says which it is.
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((row) => [row.series, row.count])).toEqual([
      ["Tasks", 2],
      ["Tasks", 1],
      ["Bills", 1],
    ]);
  });
});

/**
 * A comparison broken down by a number.
 *
 * "Posts per user" groups by `userId`, and a bar's category is a name — so the
 * widget compiled cleanly and then rendered "this widget no longer matches its
 * data", because the column it bound was numeric. The API this was built
 * against only ever grouped by names; the second one grouped by an id on the
 * first request.
 */
describe("a comparison broken down by a numeric field", () => {
  const recordType = (id: string, many: string): EntitySpec =>
    entitySchema.parse({
      id,
      resource: id,
      name: { one: id, many },
      kind: "document",
      identity: { field: "id", observed: true },
      display: { title: ["title"] },
      fields: [
        { path: "id", kinds: ["number"], visibility: "hidden" },
        { path: "title", kinds: ["string"], visibility: "primary" },
        { path: "userId", kinds: ["number"], visibility: "detail" },
        { path: "status", kinds: ["string"], visibility: "detail" },
      ],
    });
  const post = recordType("post", "Posts");
  const todo = recordType("todo", "Todos");
  const resources = [
    resourceSchema.parse({ id: "post", title: "Posts", listOp: "posts" }),
    resourceSchema.parse({ id: "todo", title: "Todos", listOp: "todos" }),
  ];
  const related = {
    entities: [post, todo],
    resources,
    ops: [
      { id: "posts", path: "/posts" },
      { id: "todos", path: "/todos" },
    ],
  };
  const posts = [
    { id: 1, title: "a", userId: 1, status: "draft" },
    { id: 2, title: "b", userId: 1, status: "live" },
    { id: 3, title: "c", userId: 2, status: "live" },
  ];
  const todos = [{ id: 7, title: "x", userId: 2, status: "open" }];
  const run = { now: 0, params: { range: resolveRange({ preset: "30d", now: 0 }), filters: {} }, timeZone: "UTC" };

  const compile = (brief: WidgetBrief) =>
    compileBrief({ brief, entity: post, resource: resources[0]!, connection: "api", id: "w1", related });

  it("draws a bar per user instead of refusing to bind", () => {
    const widget = compile({ entity: "post", intent: "compare", groupBy: "userId" }).widget!;
    const result = executeWidget(widget, posts, run);
    expect(result.binding?.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
  });

  it("does the same on both sides when two record types are set against each other", () => {
    const widget = compile({
      entity: "post",
      intent: "compare",
      groupBy: "userId",
      alongside: { entity: "todo", as: "beside" },
    }).widget!;
    const bodies = Object.fromEntries(
      widget.sources.map((source) => [source.as, source.op === "posts" ? posts : todos]),
    );
    const result = executeWidget(widget, bodies, run);
    expect(result.binding?.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(3);
  });

  it("adds nothing to a comparison that was already grouped by a name", () => {
    // A widget that worked before must compile to the same thing, or every
    // recompile of one would change its digest and ask for approval again.
    const widget = compile({ entity: "post", intent: "compare", groupBy: "status" }).widget!;
    expect(widget.pipeline.some((step) => step.op === "coerce")).toBe(false);
    expect(executeWidget(widget, posts, run).ok).toBe(true);
  });
});
