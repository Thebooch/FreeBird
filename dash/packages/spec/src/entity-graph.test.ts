import { describe, expect, it } from "vitest";
import { entitySchema, type EntitySpec } from "./entity.js";
import {
  entityGraph,
  entityLinkViews,
  entityPageView,
  targetFor,
  targetsOf,
} from "./entity-graph.js";
import { humanLabel } from "./presentation.js";
import { defaultFacets, defaultSort } from "./recipes.js";
import { resourceSchema, type ResourceSpec } from "./resource.js";

/**
 * One reference recorded, one link on each page.
 *
 * A task row carries a vendor's id. That single fact has to produce a vendor
 * *link* on the task and a task *section* on the vendor, and the two can never
 * disagree — which is the whole reason this derives the second rather than
 * storing it.
 */

const entity = (input: Record<string, unknown>): EntitySpec => entitySchema.parse(input);

const resource = (input: Record<string, unknown>): ResourceSpec => resourceSchema.parse(input);

/** Tasks point at vendors; the task collection can be filtered by vendor. */
const TASK = entity({
  id: "task",
  resource: "task",
  name: { one: "Task", many: "Tasks" },
  kind: "work",
  fields: [
    { path: "Id" },
    { path: "Title" },
    { path: "VendorId", label: "Vendor", reference: { entity: "vendor", verified: true } },
  ],
  identity: { field: "Id", observed: true },
});

const VENDOR = entity({
  id: "vendor",
  resource: "vendor",
  name: { one: "Vendor", many: "Vendors" },
  kind: "party",
  fields: [{ path: "Id" }, { path: "CompanyName" }],
  identity: { field: "Id", observed: true },
  display: { title: ["CompanyName"] },
});

const RESOURCES = [
  resource({
    id: "task",
    title: "Tasks",
    listOp: "tasks_list",
    detailOp: "tasks_byid",
    detailParam: "taskId",
  }),
  resource({
    id: "vendor",
    title: "Vendors",
    listOp: "vendors_list",
    detailOp: "vendors_byid",
    detailParam: "vendorId",
  }),
];

const OPS = [
  {
    id: "tasks_list",
    path: "/v1/tasks",
    params: [{ name: "vendorids", in: "query" }],
  },
  { id: "tasks_byid", path: "/v1/tasks/{{param.taskId}}", params: [] },
  { id: "vendors_list", path: "/v1/vendors", params: [] },
  { id: "vendors_byid", path: "/v1/vendors/{{param.vendorId}}", params: [] },
];

const graphOf = (entities: readonly EntitySpec[], ops = OPS, resources = RESOURCES) =>
  entityGraph({ entities, resources, ops });

describe("entityPageView", () => {
  /**
   * What one record's page needs, and nothing more.
   *
   * Fetched when a page opens rather than carried on every connection read, so
   * the interesting properties are what it *leaves out*: the fields the pass
   * called noise, the relationships it cannot show honestly, and the ones past
   * the cap — none of which may disappear quietly.
   */
  const SUPPLIER = entity({
    id: "vendor",
    resource: "vendor",
    name: { one: "Vendor", many: "Vendors" },
    kind: "party",
    description: "Somebody who does work for you.",
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Href", visibility: "hidden" },
      { path: "CompanyName", visibility: "primary", description: "Who they trade as." },
      { path: "FirstName", label: "First name", group: "Contact" },
      { path: "LastName", group: "Contact" },
      { path: "IsActive", group: "Standing" },
    ],
    identity: { field: "Id", observed: true },
    display: { title: ["CompanyName", "FirstName", "LastName"], status: "IsActive" },
  });

  const pageOf = (
    entities: readonly EntitySpec[],
    id: string,
    ops = OPS,
    resources = RESOURCES,
  ) => entityPageView({ entities, resources, ops }, id);

  it("is nothing at all for a record type nobody has described", () => {
    expect(pageOf([SUPPLIER], "nothing")).toBeNull();
  });

  it("leaves out the fields the pass called noise", () => {
    // Self-links and internal keys are what this layer exists to remove, so
    // carrying them for a client to re-filter would defeat the point.
    const page = pageOf([SUPPLIER], "vendor");
    expect(page?.fields.map((field) => field.path)).toEqual([
      "CompanyName",
      "FirstName",
      "LastName",
      "IsActive",
    ]);
  });

  it("keeps a hidden field that is the way into another record", () => {
    /*
     * The failure this exists for: a foreign key is hidden — correctly, nobody
     * wants to read `VendorId: 55` — and hiding it took the *link* with it. On
     * a real API every foreign key is hidden, so a work order's page had no way
     * to reach the vendor who did the work, and the vendor's page (with its
     * work orders, bills and notes) was unreachable from anywhere.
     */
    const linked = entity({
      ...TASK,
      fields: [
        { path: "Id", visibility: "hidden" },
        { path: "Title" },
        {
          path: "VendorId",
          label: "Vendor",
          visibility: "hidden",
          reference: { entity: "vendor", verified: true },
        },
      ],
    });
    const page = pageOf([linked, VENDOR], "task");

    expect(page?.fields.map((field) => field.path)).toEqual(["Title", "VendorId"]);
    // Kept as a detail, never promoted: it is a way through, not a headline.
    expect(page?.fields.find((field) => field.path === "VendorId")?.visibility).toBe("detail");
    // `Id` is an internal key pointing nowhere, and stays gone.
    expect(page?.fields.some((field) => field.path === "Id")).toBe(false);
  });

  it("leaves out a hidden reference nothing here can open", () => {
    // Kept only where the far record can be fetched. Otherwise the cell has no
    // name to show and falls back to the bare id this rule exists to avoid.
    const linked = entity({
      ...TASK,
      fields: [
        { path: "Id", visibility: "hidden" },
        { path: "Title" },
        {
          path: "VendorId",
          label: "Vendor",
          visibility: "hidden",
          reference: { entity: "vendor", verified: true },
        },
      ],
    });
    const orphaned = entity({ ...VENDOR, resource: "nowhere" });
    const page = pageOf(
      [linked, orphaned],
      "task",
      OPS.filter((op) => !op.id.startsWith("vendors")),
      RESOURCES.filter((one) => one.id !== "vendor"),
    );
    expect(page?.fields.map((field) => field.path)).toEqual(["Title"]);
  });

  it("gives every field a label, stated or read off the path", () => {
    const page = pageOf([SUPPLIER], "vendor");
    const byPath = new Map(page?.fields.map((field) => [field.path, field]));
    expect(byPath.get("FirstName")?.label).toBe("First name");
    // No label was stated, so the one a reader would infer is used rather than
    // the raw name reaching the screen.
    expect(byPath.get("CompanyName")?.label).toBe(humanLabel("CompanyName"));
    expect(byPath.get("CompanyName")?.description).toBe("Who they trade as.");
  });

  it("sections the page from the dictionary when nobody chose a layout", () => {
    /*
     * The views pass is optional and has been run on nothing, so a page that
     * waited for it would be one long list forever — while the entity pass
     * already grouped the fields.
     */
    expect(pageOf([SUPPLIER], "vendor")?.groups).toEqual([
      { title: "Contact", fields: ["FirstName", "LastName"] },
      { title: "Standing", fields: ["IsActive"] },
    ]);
  });

  it("prefers a layout the entity states over the one implied by its fields", () => {
    const stated = entity({
      ...SUPPLIER,
      views: { record: { groups: [{ title: "Who they are", fields: ["CompanyName"] }] } },
    });
    expect(pageOf([stated], "vendor")?.groups).toEqual([
      { title: "Who they are", fields: ["CompanyName"] },
    ]);
  });

  it("carries how the name is assembled, so a page never joins alternatives", () => {
    // A company name *or* a person's: joining them names nobody.
    expect(pageOf([SUPPLIER], "vendor")?.titleMode).toBe("first");
  });

  it("says where one of these is fetched from", () => {
    expect(pageOf([SUPPLIER], "vendor")?.detail).toEqual({
      op: "vendors_byid",
      param: "vendorId",
    });
  });

  it("turns a back-reference into a section led by the far record's name", () => {
    const named = entity({ ...TASK, display: { title: ["Title"] } });
    const page = pageOf([named, SUPPLIER], "vendor");
    expect(page?.sections).toHaveLength(1);
    expect(page?.sections[0]).toMatchObject({
      id: "task-by-VendorId",
      entity: "task",
      title: "Tasks",
      field: "VendorId",
      reach: { mode: "filter", op: "tasks_list", param: "vendorids" },
      cost: "cheap",
    });
    // The name leads: a section opening on an id column is a table of numbers.
    expect(page?.sections[0]?.columns[0]).toBe("Title");
    // And the far record's identity, so a row in the section can be opened.
    expect(page?.sections[0]?.identity).toBe("Id");
  });

  it("leaves a section read-only when the far record type has no identity", () => {
    /*
     * 11 of a real API's 108 record types have no identified field. A row
     * click promising a page that cannot be addressed is worse than a row that
     * plainly does nothing.
     */
    const anonymous = entity({
      id: "reading",
      resource: "reading",
      name: { one: "Reading", many: "Readings" },
      fields: [{ path: "Taken" }, { path: "VendorId", reference: { entity: "vendor" } }],
    });
    const page = pageOf(
      [anonymous, SUPPLIER],
      "vendor",
      [...OPS, { id: "readings", path: "/v1/readings", params: [] }],
      [...RESOURCES, resource({ id: "reading", title: "Readings", listOp: "readings" })],
    );
    expect(page?.sections[0]?.identity).toBeUndefined();
  });

  it("will not show a list-valued link it cannot narrow honestly", () => {
    /*
     * Narrowing this means asking whether the id is *in* a list on each far
     * row, and equality here is strict — so the section would render empty for
     * a record that has rows, which is indistinguishable from the truth.
     */
    const crew = entity({
      id: "crew",
      resource: "crew",
      name: { one: "Crew", many: "Crews" },
      fields: [{ path: "Id" }, { path: "VendorIds", reference: { entity: "vendor", holds: "array" } }],
      identity: { field: "Id" },
    });
    const page = pageOf(
      [crew, VENDOR],
      "vendor",
      [...OPS, { id: "crew_list", path: "/v1/crews", params: [] }],
      [...RESOURCES, resource({ id: "crew", title: "Crews", listOp: "crew_list" })],
    );
    expect(page?.sections).toEqual([]);
    expect(page?.omitted).toHaveLength(1);
    expect(page?.omitted[0]).toMatchObject({ id: "crew-by-VendorIds" });
    expect(page?.omitted[0]?.reason).toMatch(/list of ids/);
  });

  it("caps the sections and says how many there really are", () => {
    /*
     * Measured on a real API: one record type has 26 related collections, and
     * a page of 26 tabs is a filing cabinet. The count is carried so the page
     * can say "8 of 11" rather than implying there are eight.
     */
    const others = Array.from({ length: 10 }, (_, index) =>
      entity({
        id: `thing-${index}`,
        resource: `thing-${index}`,
        name: { one: `Thing ${index}`, many: `Things ${index}` },
        fields: [{ path: "Id" }, { path: "VendorId", reference: { entity: "vendor" } }],
        identity: { field: "Id" },
      }),
    );
    const page = pageOf(
      [TASK, ...others, SUPPLIER],
      "vendor",
      [
        ...OPS,
        ...others.map((_, index) => ({
          id: `thing_${index}_list`,
          path: `/v1/things${index}`,
          params: [],
        })),
      ],
      [
        ...RESOURCES,
        ...others.map((_, index) =>
          resource({
            id: `thing-${index}`,
            title: `Things ${index}`,
            listOp: `thing_${index}_list`,
          }),
        ),
      ],
    );
    expect(page?.sections).toHaveLength(8);
    expect(page?.sectionsTotal).toBe(11);
    /*
     * Complete answers lead. None of these endpoints declares a filter for the
     * vendor's id, so they are all capped scans — and a section that is all of
     * it should never sit below one that might not be.
     */
    expect(page?.sections[0]?.cost).toBe("cheap");
    expect(page?.sections[0]?.entity).toBe("task");
    expect(page?.sections.slice(1).every((one) => one.cost === "partial")).toBe(true);
  });
});

/**
 * The strips a widget would get, carried on the page that offers them.
 *
 * The builder shows these ticked before anybody changes anything, so if the
 * page and the compiler ever disagreed the screen would be describing a widget
 * other than the one it is about to make. One function answers both, and this
 * is what pins that.
 */
describe("entityPageView filters", () => {
  const WITH_STATUS = entity({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    fields: [
      { path: "Id" },
      { path: "Title" },
      { path: "Status" },
      // Hidden is the describing pass's verdict, and a strip over a field the
      // page does not show is a control whose effect nobody can see.
      { path: "InternalType", visibility: "hidden" },
    ],
    identity: { field: "Id", observed: true },
  });

  it("offers what the kind would reach for, and nothing hidden", () => {
    const page = entityPageView(
      { entities: [WITH_STATUS, VENDOR], resources: RESOURCES, ops: OPS },
      "task",
    );
    expect(page?.filters).toEqual(["Status"]);
  });

  it("prefers what the record type states over what its kind guesses", () => {
    const stated = entity({
      ...WITH_STATUS,
      views: { facets: ["Title"] },
    });
    const page = entityPageView(
      { entities: [stated, VENDOR], resources: RESOURCES, ops: OPS },
      "task",
    );
    expect(page?.filters).toEqual(["Title"]);
  });

  it("carries the order a list of these gets, and agrees with the compiler", () => {
    const dated = entity({
      ...WITH_STATUS,
      fields: [
        ...WITH_STATUS.fields,
        { path: "DueDate", semantic: "timestamp" },
      ],
    });
    const page = entityPageView(
      { entities: [dated, VENDOR], resources: RESOURCES, ops: OPS },
      "task",
    );
    expect(page?.sort).toEqual(defaultSort(dated));
    expect(page?.sort?.field).toBe("DueDate");
  });

  it("says nothing about order where the record type has nothing to order by", () => {
    // A real answer rather than a failure: imposing an order on a record type
    // with no date and no amount would be inventing a meaning for one.
    const page = entityPageView(
      { entities: [WITH_STATUS, VENDOR], resources: RESOURCES, ops: OPS },
      "task",
    );
    expect(page?.sort).toBeUndefined();
  });

  it("says the same thing the compiler does", () => {
    // The property the builder depends on, checked against the compiler's own
    // answer rather than against a copy of the expectation.
    const page = entityPageView(
      { entities: [WITH_STATUS, VENDOR], resources: RESOURCES, ops: OPS },
      "task",
    );
    expect(page?.filters).toEqual(defaultFacets(WITH_STATUS));
  });
});

/**
 * The numbers a record page leads with.
 *
 * Each counts a collection the page already loads, which is what makes them
 * free — the cache keys on the request rather than on the pipeline, so a stat
 * over a section's endpoint shares that section's fetch.
 */
describe("entityPageView stats", () => {
  const pageOf = (entities: readonly EntitySpec[], id: string) =>
    entityPageView({ entities, resources: RESOURCES, ops: OPS, }, id);

  it("counts each collection the page shows, by the name the section has", () => {
    const page = pageOf([TASK, VENDOR], "vendor");
    expect(page?.stats).toEqual([
      { section: page!.sections[0]!.id, label: page!.sections[0]!.title, agg: "count", cost: "cheap" },
    ]);
  });

  it("never names a collection the page does not show", () => {
    // A number with nothing fetched behind it would need a request of its own,
    // which is the one thing these are supposed not to cost.
    const page = pageOf([TASK, VENDOR], "task");
    const shown = new Set(page?.sections.map((section) => section.id));
    expect((page?.stats ?? []).every((stat) => shown.has(stat.section))).toBe(true);
  });

  it("takes what the record type states over what it would count", () => {
    const stated = entity({
      ...VENDOR,
      views: {
        stats: [{ label: "Open jobs", backref: "task-by-VendorId", agg: "count" }],
      },
    });
    const page = pageOf([TASK, stated], "vendor");
    expect(page?.stats[0]?.label).toBe("Open jobs");
    // And not counted a second time under the section's own name.
    expect(page?.stats).toHaveLength(1);
  });

  it("drops a stated stat naming a collection this page has not got", () => {
    const stated = entity({
      ...VENDOR,
      views: { stats: [{ label: "Ghosts", backref: "nothing_here", agg: "count" }] },
    });
    const page = pageOf([TASK, stated], "vendor");
    expect(page?.stats.some((stat) => stat.label === "Ghosts")).toBe(false);
  });
});

describe("entityGraph", () => {
  it("turns one reference into a link out and a section back", () => {
    const graph = graphOf([TASK, VENDOR]);

    const out = graph.referencesOf("task");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      field: "VendorId",
      target: "vendor",
      label: "Vendor",
      reach: { mode: "record", op: "vendors_byid", param: "vendorId" },
      verified: true,
    });

    const back = graph.backrefsOf("vendor");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      entity: "task",
      title: "Tasks",
      field: "VendorId",
      // The API declares `vendorids`, so this is one request and complete.
      reach: { mode: "filter", op: "tasks_list", param: "vendorids" },
      cost: "cheap",
    });
  });

  it("says so when the far collection cannot be filtered", () => {
    /*
     * The honesty that makes the feature usable. A scan stops at the page cap,
     * so rows belonging to this record can sit past the last page fetched and
     * the section renders empty for a record that does have some.
     */
    const graph = graphOf([TASK, VENDOR], [
      { id: "tasks_list", path: "/v1/tasks", params: [] },
      ...OPS.slice(1),
    ]);
    expect(graph.backrefsOf("vendor")[0]).toMatchObject({
      reach: { mode: "scan", op: "tasks_list", field: "VendorId", holds: "scalar" },
      cost: "partial",
    });
  });

  it("prefers the parameter the pass recorded over the naming convention", () => {
    // `taskcategoryid` filters `Category.Id`, and no convention connects those
    // two names — which is exactly why the pass writes it down.
    const task = entity({
      ...TASK,
      fields: [
        { path: "Id" },
        {
          path: "Category.Id",
          filter: { param: "taskcategoryid", via: "Category.Id" },
          reference: { entity: "category" },
        },
      ],
    });
    const category = entity({
      id: "category",
      resource: "category",
      name: { one: "Category", many: "Categories" },
      kind: "lookup",
    });
    const graph = graphOf([task, category], OPS, [
      ...RESOURCES,
      resource({ id: "category", title: "Categories", listOp: "categories_list" }),
    ]);
    expect(graph.backrefsOf("category")[0]?.reach).toEqual({
      mode: "filter",
      op: "tasks_list",
      param: "taskcategoryid",
    });
  });

  it("keeps two links from the same entity apart", () => {
    /*
     * "Created by" and "assigned to" both point at a person and are not the
     * same section. Collapsing them would put one list under two headings.
     */
    const task = entity({
      ...TASK,
      fields: [
        { path: "Id" },
        { path: "CreatedById", reference: { entity: "user" } },
        { path: "AssignedToId", reference: { entity: "user" } },
      ],
    });
    const user = entity({
      id: "user",
      resource: "user",
      name: { one: "Person", many: "People" },
      kind: "party",
    });
    const graph = graphOf([task, user], OPS, [
      ...RESOURCES,
      resource({ id: "user", title: "Users", listOp: "users_list" }),
    ]);
    expect(graph.backrefsOf("user").map((entry) => entry.id)).toEqual([
      "task-by-CreatedById",
      "task-by-AssignedToId",
    ]);
  });

  it("reaches an object reference through the id inside it", () => {
    const task = entity({
      ...TASK,
      fields: [
        { path: "Id" },
        { path: "Vendor", reference: { entity: "vendor", holds: "objectRef" } },
      ],
    });
    const graph = graphOf([task, VENDOR]);
    // Comparing the object itself is false for every row, silently.
    expect(graph.backrefsOf("vendor")[0]?.field).toBe("Vendor.Id");
  });

  it("drops a reference to something the API does not describe, and says why", () => {
    const task = entity({
      ...TASK,
      fields: [{ path: "Id" }, { path: "GhostId", reference: { entity: "ghost" } }],
    });
    const graph = graphOf([task]);
    expect(graph.referencesOf("task")).toEqual([]);
    expect(graph.unreachable[0]?.reason).toMatch(/does not describe/);
  });

  it("reports a link with nowhere to go and no name on the row", () => {
    const vendor = entity({ ...VENDOR, resource: "vendor-listonly" });
    const graph = graphOf([TASK, vendor], OPS, [
      RESOURCES[0]!,
      resource({ id: "vendor-listonly", title: "Vendors", listOp: "vendors_list" }),
    ]);
    expect(graph.referencesOf("task")[0]?.reach).toBeNull();
    expect(graph.unreachable[0]?.reason).toMatch(/no by-id endpoint/);
  });

  it("costs nothing when the row already carries the name", () => {
    const task = entity({
      ...TASK,
      fields: [
        { path: "Id" },
        { path: "Vendor.Id", reference: { entity: "vendor", embedded: ["Vendor.Name"] } },
        { path: "Vendor.Name" },
      ],
    });
    expect(graphOf([task, VENDOR]).referencesOf("task")[0]?.cost).toBe("free");
  });

  it("hangs a scoped collection off the record it belongs to", () => {
    const note = entity({
      id: "task-note",
      resource: "task-note",
      name: { one: "Note", many: "Notes" },
      kind: "note",
      scope: { parent: "task", param: "taskId" },
    });
    const graph = graphOf([TASK, VENDOR, note], OPS, [
      ...RESOURCES,
      resource({ id: "task-note", title: "Notes", listOp: "task_notes_list" }),
    ]);
    expect(graph.backrefsOf("task")[0]).toMatchObject({
      entity: "task-note",
      reach: { mode: "path", op: "task_notes_list", param: "taskId" },
      cost: "cheap",
    });
  });

  it("finds the entity behind an endpoint, by either of its ops", () => {
    const graph = graphOf([TASK, VENDOR]);
    expect(graph.entityOf("tasks_list")?.id).toBe("task");
    expect(graph.entityOf("tasks_byid")?.id).toBe("task");
    expect(graph.entityOf("nothing")).toBeUndefined();
  });

  it("resolves a column back through the derive step that produced it", () => {
    const task = entity({
      ...TASK,
      fields: [{ path: "Id" }, { path: "Vendor.Id", reference: { entity: "vendor" } }],
    });
    const graph = graphOf([task, VENDOR]);

    // What the table renders is `Vendor_Id`; what the entity describes is
    // `Vendor.Id`. Without the translation every nested reference is invisible.
    expect(graph.resolveField("tasks_list", "Vendor_Id", { Vendor_Id: "Vendor.Id" })?.reference.target).toBe(
      "vendor",
    );
    expect(graph.resolveField("tasks_list", "Vendor_Id")).toBeUndefined();
    expect(graph.resolveField("tasks_list", "Title")).toBeUndefined();
  });
});

describe("entityLinkViews", () => {
  const views = entityLinkViews({ entities: [TASK, VENDOR], resources: RESOURCES, ops: OPS });
  const task = views.find((view) => view.entity === "task")!;

  it("says which endpoints' rows are this record type", () => {
    // So a browser answers "what am I showing?" with a lookup rather than by
    // reasoning about resources it would have to be sent as well.
    expect(task.ops).toEqual(["tasks_list", "tasks_byid"]);
  });

  it("carries the name, the identity and the display fields", () => {
    expect(task).toMatchObject({
      name: { one: "Task", many: "Tasks" },
      identity: "Id",
      title: [],
    });
    expect(views.find((view) => view.entity === "vendor")?.title).toEqual(["CompanyName"]);
  });

  it("flattens each reference into what a renderer needs", () => {
    expect(task.references).toEqual([
      {
        field: "VendorId",
        label: "Vendor",
        target: "vendor",
        targetName: "Vendor",
        holds: "scalar",
        embedded: [],
        lookup: { op: "vendors_byid", param: "vendorId" },
        free: false,
      },
    ]);
  });

  it("marks a link free when the row already carries the name", () => {
    const embedded = entity({
      ...TASK,
      fields: [
        { path: "Id" },
        { path: "Vendor.Id", reference: { entity: "vendor", embedded: ["Vendor.Name"] } },
        { path: "Vendor.Name" },
      ],
    });
    const [one] = entityLinkViews({
      entities: [embedded, VENDOR],
      resources: RESOURCES,
      ops: OPS,
    });
    expect(one?.references[0]).toMatchObject({ free: true, embedded: ["Vendor.Name"] });
  });

  it("offers no lookup when nothing can open the far record", () => {
    // A record type with no by-id endpoint. The link still renders as a name
    // where one is embedded; it simply cannot be followed.
    const views = entityLinkViews({
      entities: [TASK, entity({ ...VENDOR, resource: "vendor-listonly" })],
      resources: [
        RESOURCES[0]!,
        resource({ id: "vendor-listonly", title: "Vendors", listOp: "vendors_list" }),
      ],
      ops: OPS,
    });
    expect(views.find((view) => view.entity === "task")?.references[0]?.lookup).toBeUndefined();
  });

  it("leaves out a link whose target this API does not describe", () => {
    const views = entityLinkViews({ entities: [TASK], resources: RESOURCES, ops: OPS });
    expect(views[0]?.references).toEqual([]);
  });

  it("carries nothing that would make it mistakeable for the whole record type", () => {
    /*
     * The payload is read on every page load, and a real API's descriptions
     * run to well over a megabyte. This shape exists to be small.
     *
     * `labels` is the one dictionary-ish thing here and it earns its place:
     * without it a column has to be named from an API-wide lexicon with one
     * entry per bare field name, which gives `Title` a single meaning for
     * every record type that has one. Kept honest by carrying only the labels
     * that differ from what is already readable off the path — see below.
     */
    expect(Object.keys(task).sort()).toEqual([
      "entity",
      "identity",
      "labels",
      "name",
      "ops",
      "references",
      "resource",
      "title",
      "titleMode",
    ]);
  });

  it("spends nothing on a label a reader could work out from the path", () => {
    const named = entity({
      ...TASK,
      fields: [
        // Exactly what `humanLabel` would produce, so it teaches nothing.
        { path: "DueDate", label: "Due date" },
        { path: "Id", label: "Reference number" },
        // No label at all.
        { path: "Title" },
      ],
    });
    const views = entityLinkViews({ entities: [named], resources: RESOURCES, ops: OPS });
    expect(views[0]?.labels).toEqual({ Id: "Reference number" });
  });
});

describe("polymorphic references", () => {
  const reference = {
    entity: "rental",
    holds: "objectRef" as const,
    embedded: [],
    verified: false,
    typeField: { field: "Property.Type", map: { Rental: "rental", Association: "association" } },
  };

  it("lists every type it could resolve to, the default first", () => {
    expect(targetsOf(reference)).toEqual(["rental", "association"]);
  });

  it("reads the row's own type, flattened or not", () => {
    expect(targetFor(reference, { "Property.Type": "Association" })).toBe("association");
    expect(targetFor(reference, { Property_Type: "Association" })).toBe("association");
  });

  it("falls back to the default rather than guessing", () => {
    // A type nobody recorded is a link that cannot be followed, and following
    // it to the wrong record type is worse than not offering it.
    expect(targetFor(reference, { Property_Type: "Something else" })).toBe("rental");
    expect(targetFor(reference, {})).toBe("rental");
  });
});
