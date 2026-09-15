import {
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
import { buildFromDraft } from "./build.js";
import { newDraft } from "./draft.js";
import { patchFromBrief } from "./from-brief.js";
import { revise } from "./revise.js";

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

  it("leaves a measurement to the path that can bind one", () => {
    /*
     * A patch cannot express a measurement: the draft derives its shape from
     * the component and roles, and its measure and groupBy steps only change a
     * shape that already exists. Handing one over anyway is rejected three
     * ways, so this hands over nothing and the older path — which builds
     * charts correctly and always has — answers instead.
     */
    expect(patchFor({ intent: "compare", groupBy: "Category.Name" }).patch).toEqual({});
    expect(patchFor({ intent: "measure", measure: { agg: "sum", field: "Cost" } }).patch).toEqual(
      {},
    );
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

  it("hands a measurement over untouched, rather than half-answering it", () => {
    /*
     * Caught by this very test before it shipped: a patch carrying a
     * measurement was rejected three ways — measure and groupBy do not apply
     * to a widget whose shape does not exist yet, and a `value` role bound to
     * an aggregate column names a field the endpoint has not got. Neither side
     * alone would have noticed.
     */
    const { patch } = patchFor({ intent: "compare", groupBy: "Category.Name" });
    expect(patch).toEqual({});

    // An empty patch leaves the draft exactly as it was, for the older path.
    const revised = revise(newDraft("d2", "how many per category", "assisted"), patch, context);
    expect(revised.rejected).toEqual([]);
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
