import { describe, expect, it } from "vitest";
import { compileBrief, type WidgetBrief } from "./brief.js";
import { entitySchema, type EntitySpec } from "./entity.js";
import { resourceSchema, type ResourceSpec } from "./resource.js";
import { parseDashboard } from "./dashboard.js";

/**
 * A sentence about records, compiled into a widget.
 *
 * The test this file exists for is the first one: asked for "tasks with a
 * filter by category", the old path built a bar chart of task counts per
 * category — because a grouping was the only way to express either reading.
 * Everything else here guards the same principle from a different side: what
 * the brief says is what gets built, and where it cannot be, that is said out
 * loud rather than approximated.
 */

const entity = (input: Record<string, unknown>): EntitySpec =>
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
      /*
       * The object and the word beside it, which is the shape that matters:
       * 57 of a real API's 108 record types carry one, and binding the object
       * renders "[object Object]".
       */
      { path: "Category", label: "Task category", kinds: ["object"], visibility: "detail" },
      { path: "Category.Name", label: "Category", kinds: ["string"], visibility: "detail" },
      /* A record with nothing readable inside it. */
      { path: "Payload", label: "Payload", kinds: ["object"], visibility: "detail" },
      { path: "DueDate", label: "Due date", semantic: "timestamp", visibility: "detail" },
      { path: "Cost", label: "Cost", semantic: "currency", visibility: "detail" },
    ],
    ...input,
  });

const resource = (input: Record<string, unknown> = {}): ResourceSpec =>
  resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list", ...input });

const compile = (brief: Partial<WidgetBrief>, overrides: Record<string, unknown> = {}) =>
  compileBrief({
    brief: { entity: "task", intent: "records", ...brief } as WidgetBrief,
    entity: entity(overrides),
    resource: resource(),
    connection: "api",
    id: "w1",
  });

const stepOps = (result: ReturnType<typeof compile>): string[] =>
  (result.widget?.pipeline ?? []).map((step) => step.op);

describe("compileBrief", () => {
  it("builds records with a filter strip, and never a chart", () => {
    /*
     * The failure that started all of this. "Filter by category" and "grouped
     * by category" were one thing to the old path, so asking to *narrow* a
     * list produced a bar chart of counts. Here they are different intents,
     * and no wording can slide from one to the other.
     */
    const result = compile({ intent: "records", filters: [{ field: "Category.Name" }] });

    expect(result.errors).toEqual([]);
    expect(result.widget?.component).toBe("table");
    expect(result.widget?.facets).toEqual([{ field: "Category_Name", mode: "multi", other: "show", default: [] }]);
    // Nothing is aggregated: these are records, and they stay records.
    expect(stepOps(result)).not.toContain("group");
  });

  it("derives a nested filter field, because a strip binds to a column", () => {
    const result = compile({ intent: "records", filters: [{ field: "Category.Name" }] });
    expect(result.widget?.pipeline).toContainEqual({
      op: "derive",
      fields: { Category_Name: "Category.Name" },
    });
  });

  it("charts only when a comparison was asked for", () => {
    const result = compile({ intent: "compare", groupBy: "Category.Name" });

    expect(result.errors).toEqual([]);
    expect(result.widget?.component).toBe("bar");
    expect(result.widget?.roles).toEqual({ category: "Category_Name", value: "value" });
    expect(result.widget?.pipeline).toContainEqual({
      op: "group",
      by: [{ field: "Category_Name" }],
      agg: { value: "count()" },
    });
  });

  it("totals every row for a single number, by grouping on a constant", () => {
    // How the pipeline says "all of them" without every component having to
    // special-case it.
    const result = compile({ intent: "measure", measure: { agg: "sum", field: "Cost" } });

    expect(result.errors).toEqual([]);
    expect(result.widget?.component).toBe("stat");
    expect(result.widget?.roles).toEqual({ value: "value" });
    expect(result.widget?.pipeline).toContainEqual({
      op: "group",
      by: [{ field: "_all" }],
      agg: { value: "sum(Cost)" },
    });
  });

  it("offers no filter strip over buckets, which are not records", () => {
    // A strip on a chart would filter its own bars, which is not what anybody
    // means by a filter.
    const result = compile({ intent: "compare", groupBy: "Status", filters: [{ field: "Status" }] });
    expect(result.widget?.facets).toEqual([]);
  });

  it("names the record type, so a cell holding an id can resolve it", () => {
    expect(compile({ intent: "records" }).widget?.entity).toBe("task");
  });

  it("sorts by what this kind of record is read by", () => {
    // Work is read soonest-first, and the date is found by its meaning rather
    // than by any particular API's name for it.
    const result = compile({ intent: "records" });
    expect(result.widget?.pipeline).toContainEqual({
      op: "sort",
      by: [{ field: "DueDate", dir: "asc" }],
    });
  });

  it("starts a strip narrowed to the values a phrase named", () => {
    /*
     * Where a scope phrase lands. "Open work" is the work with the state strip
     * already narrowed — visible, and one click from being widened — rather
     * than a filter baked into the pipeline where the reader can neither see
     * what was narrowed nor undo it.
     */
    const result = compile({
      intent: "records",
      filters: [{ field: "Status", values: ["Open"] }],
    });

    expect(result.widget?.facets).toContainEqual(
      expect.objectContaining({ field: "Status", default: ["Open"] }),
    );
    // A selection, not a pipeline step: the rows are all still there.
    expect(stepOps(result)).not.toContain("filter");
  });

  it("carries those values to the field the name was remapped to", () => {
    // Asked to narrow by `Category`, which means the word inside it — and the
    // values have to follow it there, or the phrase silently stops applying.
    const result = compile({
      intent: "records",
      filters: [{ field: "Category", values: ["Maintenance"] }],
    });
    expect(result.widget?.facets).toContainEqual(
      expect.objectContaining({ field: "Category_Name", default: ["Maintenance"] }),
    );
  });

  it("offers no more filter strips than a widget can hold", () => {
    /*
     * Found by building one against a real record type, which matched six
     * fields worth narrowing by where a widget takes three — so the compiler
     * produced a widget that failed its own parse. No fixture here had enough
     * fields to reach the limit, so every test passed.
     */
    const many = entity({
      fields: [
        { path: "Id", visibility: "hidden" },
        { path: "Title", visibility: "primary" },
        { path: "Status", visibility: "primary" },
        { path: "TaskType", visibility: "detail" },
        { path: "Priority", visibility: "detail" },
        { path: "Category.Name", visibility: "detail" },
        { path: "Owner", visibility: "detail" },
      ],
      display: { title: ["Title"] },
    });
    const result = compileBrief({
      brief: { entity: "task", intent: "records" },
      entity: many,
      resource: resource(),
      connection: "api",
      id: "w1",
    });

    expect(result.errors).toEqual([]);
    expect(result.widget?.facets?.length).toBeLessThanOrEqual(3);
  });

  it("drops a field the record type does not have, and says so", () => {
    /*
     * Never approximated to the nearest match: a widget quietly filtering on
     * some other column is confidently, invisibly wrong.
     */
    const result = compile({ intent: "records", filters: [{ field: "Invented" }] });
    expect(result.errors).toEqual([]);
    expect(result.notes.join(" ")).toContain('"Invented" is not a field Task has');
    expect(result.widget?.facets?.some((facet) => facet.field === "Invented")).toBe(false);
  });

  it("reads a named record as the word inside it", () => {
    /*
     * Found by using it: asked for a filter by category, a real model named
     * `Category` — which is a declared field, so every check passed, and the
     * filter tiles would have read "[object Object]". Naming the record means
     * the name inside it, which is sitting right there.
     */
    const result = compile({ intent: "records", filters: [{ field: "Category" }] });
    expect(result.errors).toEqual([]);
    expect(result.widget?.facets?.map((facet) => facet.field)).toEqual(["Category_Name"]);
    // Not a compromise but the correct reading, so nothing is apologised for.
    expect(result.notes).toEqual([]);
  });

  it("drops a record with nothing readable inside it, and says so", () => {
    const result = compile({ intent: "records", filters: [{ field: "Payload" }] });
    expect(result.notes.join(" ")).toContain("holds a record rather than a value");
    expect(result.widget?.facets?.some((facet) => facet.field === "Payload")).toBe(false);
  });

  it("never totals a record", () => {
    // The one place the readable half must not be reached for: a name cannot
    // be added up either, so this is an error rather than a substitution.
    const result = compile({ intent: "measure", measure: { agg: "sum", field: "Category" } });
    expect(result.widget).toBeNull();
    expect(result.errors.join(" ")).toContain("holds a record rather than a number");
  });

  it("never breaks a comparison down by a record it cannot read", () => {
    const result = compile({ intent: "compare", groupBy: "Payload" });
    expect(result.widget).toBeNull();
    expect(result.errors.join(" ")).toContain("cannot be broken down by it");
  });

  it("compares across the word inside a record, where there is one", () => {
    const result = compile({ intent: "compare", groupBy: "Category" });
    expect(result.errors).toEqual([]);
    expect(result.widget?.roles).toEqual({ category: "Category_Name", value: "value" });
  });

  it("reads a column through a reference, as a column that really exists", () => {
    /*
     * A task's vendor's phone lives on the vendor, so no pipeline over tasks
     * could produce it. The column is made empty here so a role can bind to it
     * and the binding check passes; the value arrives with the record it
     * belongs to.
     */
    const result = compile(
      {
        intent: "records",
        columns: ["Title"],
        linked: [{ through: "VendorId", field: "Phone", label: "Vendor phone" }],
      },
      {
        fields: [
          { path: "Id", visibility: "hidden" },
          { path: "Title", visibility: "primary" },
          { path: "VendorId", label: "Vendor", reference: { entity: "vendor" } },
        ],
        display: { title: ["Title"] },
      },
    );

    expect(result.errors).toEqual([]);
    expect(result.widget?.linked).toEqual([
      { through: "VendorId", field: "Phone", as: "VendorId_Phone", label: "Vendor phone" },
    ]);
    expect(result.widget?.pipeline).toContainEqual(
      expect.objectContaining({
        op: "derive",
        fields: expect.objectContaining({ VendorId_Phone: "null" }),
      }),
    );
    // And it is shown, which is the whole reason somebody added it.
    expect(result.widget?.roles.columns).toContain("VendorId_Phone");
  });

  it("refuses to read through a field that points at nothing", () => {
    /*
     * Following something that is not a reference fetches nothing, leaving a
     * column blank forever — which looks exactly like a value this record
     * happens not to have.
     */
    const result = compile({
      intent: "records",
      linked: [{ through: "Status", field: "Phone" }],
    });
    expect(result.widget?.linked ?? []).toEqual([]);
    expect(result.notes.join(" ")).toContain("does not point at another record");
  });

  it("refuses a comparison with nothing to break it down by", () => {
    const result = compile({ intent: "compare" });
    expect(result.widget).toBeNull();
    expect(result.errors.join(" ")).toContain("break the number down by");
  });

  it("refuses to total a field nobody named", () => {
    // A sum over nothing silently produces zero, which renders as a confident
    // answer to a question nobody asked.
    const result = compile({ intent: "measure", measure: { agg: "sum" } });
    expect(result.widget).toBeNull();
    expect(result.errors.join(" ")).toContain("needs a field to add up");
  });

  it("refuses a record type this API cannot list", () => {
    const result = compileBrief({
      brief: { entity: "task", intent: "records" },
      entity: entity({}),
      resource: resourceSchema.parse({ id: "task", title: "Tasks" }),
      connection: "api",
      id: "w1",
    });
    expect(result.widget).toBeNull();
    expect(result.errors[0]).toContain("no endpoint that returns them");
  });

  it("reads a kind that browses as cards rather than as a grid", () => {
    const result = compile({ intent: "records" }, { kind: "place" });
    expect(result.widget?.component).toBe("cards");
    expect(result.widget?.roles).toMatchObject({ title: "Title", status: "Status" });
  });

  it("falls back to a table when the kind's own reading cannot be bound", () => {
    /*
     * An event reads as a feed, and a feed cannot render without a date. A
     * table of the same columns always can — and saying which happened beats a
     * widget that renders as a binding error.
     */
    const result = compile(
      { intent: "records" },
      {
        kind: "event",
        display: { title: ["Title"] },
        fields: [
          { path: "Id", visibility: "hidden" },
          { path: "Title", visibility: "primary" },
          { path: "Status", visibility: "primary" },
        ],
      },
    );
    expect(result.widget?.component).toBe("table");
    expect(result.notes.join(" ")).toContain("says when it happened");
  });

  it("takes the title it was given, and the record type's plural otherwise", () => {
    expect(compile({ intent: "records" }).widget?.title).toBe("Tasks");
    expect(compile({ intent: "records", title: "Overdue work" }).widget?.title).toBe("Overdue work");
  });
});

/**
 * Saying "none" and saying nothing.
 *
 * The distinction a hand-built widget depends on: without it every untick
 * arrives as an empty list, is answered with the defaults, and the last strip
 * can never be taken off.
 */
/**
 * A strip that knows a value the account has none of.
 *
 * The one thing a sample cannot establish. Rows show the statuses somebody is
 * currently in, so a strip built from them alone has no tile for the one
 * nobody is in — and "Overdue 0" is exactly the tile worth having.
 */
describe("declared values on a filter strip", () => {
  const withValues = {
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      {
        path: "Status",
        label: "Status",
        visibility: "primary",
        values: ["New", "InProgress", "Completed"],
      },
    ],
  };

  it("offers every value the API declares, in the order it declared them", () => {
    const built = compile({ filters: [{ field: "Status" }] }, withValues);
    expect(built.widget?.facets?.[0]?.values?.map((option) => option.value)).toEqual([
      "New",
      "InProgress",
      "Completed",
    ]);
  });

  it("says nothing where the API declared nothing, rather than guessing", () => {
    const built = compile({ filters: [{ field: "Status" }] });
    expect(built.widget?.facets?.[0]?.values).toBeUndefined();
  });

  it("leaves the remainder shown, so a stale declaration cannot hide a row", () => {
    /*
     * A vendor adding a status without updating their spec is ordinary. With
     * `other` shown — the default — that row gets an "Other" tile instead of
     * disappearing, and the numbers still add up to the rows underneath.
     */
    const built = compile({ filters: [{ field: "Status" }] }, withValues);
    expect(built.widget?.facets?.[0]?.other).toBe("show");
  });
});

describe("filter strips asked for explicitly", () => {
  it("chooses for you when nothing is said", () => {
    const built = compile({});
    expect(built.widget?.facets?.length ?? 0).toBeGreaterThan(0);
  });

  it("takes none when none are asked for", () => {
    const built = compile({ filters: [] });
    expect(built.widget?.facets ?? []).toEqual([]);
  });

  it("takes exactly what is asked for", () => {
    const built = compile({ filters: [{ field: "Status" }] });
    expect(built.widget?.facets?.map((one) => one.field)).toEqual(["Status"]);
  });
});

/**
 * A collection that only exists under another record.
 *
 * Its URL still has a parameter in it, and a widget on a board has nothing to
 * fill that from — so it could be built and could never fetch. Compiled
 * anyway, it produced a source of `/leases/{{param.leaseId}}/moveouts` with no
 * `leaseId`, offered as though it worked, and said nothing. On a real API that
 * was 69 of 108 record types.
 */
describe("a record type only reachable through a parent", () => {
  it("refuses, and says where those records actually live", () => {
    const built = compile({}, {
      scope: { parent: "lease", param: "leaseId" },
    });
    // `compile` supplies no path, so nothing changes without one.
    expect(built.widget).not.toBeNull();

    const scoped = compileBrief({
      brief: { entity: "task", intent: "records" },
      entity: entity({ scope: { parent: "lease", param: "leaseId" } }),
      resource: resource(),
      connection: "api",
      id: "w1",
      listPath: "/v1/leases/{{param.leaseId}}/moveouts",
    });
    expect(scoped.widget).toBeNull();
    expect(scoped.errors.join(" ")).toContain("lease");
  });

  it("still builds a collection whose path needs nothing", () => {
    const plain = compileBrief({
      brief: { entity: "task", intent: "records" },
      entity: entity({}),
      resource: resource(),
      connection: "api",
      id: "w1",
      listPath: "/v1/tasks",
    });
    expect(plain.widget).not.toBeNull();
  });

  it("says something useful even when nothing named a parent", () => {
    const scoped = compileBrief({
      brief: { entity: "task", intent: "records" },
      entity: entity({}),
      resource: resource(),
      connection: "api",
      id: "w1",
      listPath: "/v1/applications/{{param.applicationId}}/transactions",
    });
    expect(scoped.widget).toBeNull();
    expect(scoped.errors.join(" ")).toContain("one record at a time");
  });
});

/**
 * Two record types in one widget.
 *
 * The last thing a brief could not say. "My vendors alongside their open work"
 * named two collections, and a brief names one — so the request fell through
 * to a planner that hunted endpoints, taking everything the record types had
 * already established with it.
 *
 * The rule these all guard is the one the join makes tempting to break: the
 * link is derived from what the API states, in both directions, and where
 * nothing states one the answer is the record type that was asked for first
 * with a sentence about the other — never two collections matched on a guess,
 * which reads exactly like data because every row in it is real.
 */

const vendor = (input: Record<string, unknown> = {}): EntitySpec =>
  entitySchema.parse({
    id: "vendor",
    resource: "vendor",
    name: { one: "Vendor", many: "Vendors" },
    kind: "party",
    identity: { field: "Id", observed: true },
    display: { title: ["Name"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Name", label: "Name", visibility: "primary" },
      { path: "PhoneNumber", label: "Phone", visibility: "primary" },
      { path: "CreatedOn", label: "Added", semantic: "timestamp", visibility: "detail" },
    ],
    ...input,
  });

/** A task that knows whose vendor it is. */
const taskWithVendor = (input: Record<string, unknown> = {}): EntitySpec =>
  entity({
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary" },
      { path: "Category", label: "Task category", kinds: ["object"], visibility: "detail" },
      { path: "Category.Name", label: "Category", kinds: ["string"], visibility: "detail" },
      { path: "DueDate", label: "Due date", semantic: "timestamp", visibility: "detail" },
      { path: "Cost", label: "Cost", semantic: "currency", visibility: "detail" },
      {
        path: "VendorId",
        label: "Vendor",
        visibility: "detail",
        reference: { entity: "vendor" },
      },
    ],
    ...input,
  });

const vendorResource = resourceSchema.parse({
  id: "vendor",
  title: "Vendors",
  listOp: "vendors_list",
});

/**
 * Both record types, as an API the graph can be read from.
 *
 * `taskFilter` is the whole of what separates a link this will act on from one
 * it refuses: a declared query parameter is the API saying the two really go
 * together, where a bare field name is a resemblance somebody's describer
 * noticed.
 */
const bothSides = (options: { taskFilter?: boolean; task?: EntitySpec } = {}) => ({
  entities: [options.task ?? taskWithVendor(), vendor()],
  resources: [resource(), vendorResource],
  ops: [
    {
      id: "tasks_list",
      path: "/tasks",
      ...(options.taskFilter === false ? {} : { params: [{ name: "vendorids", in: "query" }] }),
    },
    { id: "vendors_list", path: "/vendors" },
  ],
});

describe("compileBrief, alongside", () => {
  it("joins on the field this record already points at", () => {
    const result = compileBrief({
      brief: {
        entity: "task",
        intent: "records",
        alongside: { entity: "vendor" },
      },
      entity: taskWithVendor(),
      resource: resource(),
      connection: "api",
      id: "w1",
      related: bothSides(),
    });

    expect(result.errors).toEqual([]);
    // Two endpoints, one dataset — never a chart, and never two widgets.
    expect(result.widget?.sources.map((one) => one.op)).toEqual(["tasks_list", "vendors_list"]);
    expect(result.widget?.combine).toEqual({
      op: "join",
      left: "task",
      right: "vendor",
      on: { left: "VendorId", right: "Id" },
      kind: "left",
    });
    expect(result.widget?.source).toBeUndefined();
    // The far record's own columns, under the name the join gives them.
    expect(result.widget?.roles.columns).toContain("vendor_Name");
  });

  it("joins the other way round, from a back reference the API can filter by", () => {
    const result = compileBrief({
      brief: { entity: "vendor", intent: "records", alongside: { entity: "task" } },
      entity: vendor(),
      resource: vendorResource,
      connection: "api",
      id: "w1",
      related: bothSides(),
    });

    expect(result.errors).toEqual([]);
    expect(result.widget?.combine).toEqual({
      op: "join",
      left: "vendor",
      right: "task",
      on: { left: "Id", right: "VendorId" },
      kind: "left",
    });
  });

  it("refuses a link the API only resembles, rather than matching on a guess", () => {
    /*
     * The same two record types, with nothing on the API saying tasks can be
     * looked up by vendor. The describer's reading of a field name is not
     * evidence, and rows paired on it are indistinguishable from real ones.
     */
    const result = compileBrief({
      brief: { entity: "vendor", intent: "records", alongside: { entity: "task" } },
      entity: vendor(),
      resource: vendorResource,
      connection: "api",
      id: "w1",
      related: bothSides({ taskFilter: false }),
    });

    expect(result.errors).toEqual([]);
    expect(result.widget?.sources).toEqual([]);
    expect(result.widget?.source?.op).toBe("vendors_list");
    expect(result.notes.join(" ")).toContain("matched on a guess");
  });

  it("says so when nothing links the two at all", () => {
    const unrelated = taskWithVendor({
      fields: [
        { path: "Id", visibility: "hidden" },
        { path: "Title", label: "Summary", visibility: "primary" },
        { path: "Status", label: "Status", visibility: "primary" },
      ],
    });
    const result = compileBrief({
      brief: { entity: "task", intent: "records", alongside: { entity: "vendor" } },
      entity: unrelated,
      resource: resource(),
      connection: "api",
      id: "w1",
      related: { ...bothSides({ task: unrelated, taskFilter: false }) },
    });

    expect(result.errors).toEqual([]);
    expect(result.widget?.source?.op).toBe("tasks_list");
    expect(result.notes.join(" ")).toContain("Nothing links Tasks to Vendors");
  });

  it("refuses a record type that cannot be listed on its own", () => {
    const result = compileBrief({
      brief: { entity: "task", intent: "records", alongside: { entity: "vendor" } },
      entity: taskWithVendor(),
      resource: resource(),
      connection: "api",
      id: "w1",
      related: {
        ...bothSides(),
        ops: [
          { id: "tasks_list", path: "/tasks" },
          { id: "vendors_list", path: "/properties/{{param.propertyId}}/vendors" },
        ],
      },
    });

    expect(result.widget?.sources).toEqual([]);
    expect(result.notes.join(" ")).toContain("one record at a time");
  });

  it("leaves a second record type out of a number rather than counting pairs", () => {
    // A join multiplies rows, and a count over multiplied rows counts the
    // pairings. Nobody asking how many tasks there are means that.
    const result = compileBrief({
      brief: { entity: "task", intent: "measure", alongside: { entity: "vendor" } },
      entity: taskWithVendor(),
      resource: resource(),
      connection: "api",
      id: "w1",
      related: bothSides(),
    });

    expect(result.widget?.component).toBe("stat");
    expect(result.widget?.sources).toEqual([]);
    expect(result.notes.join(" ")).toContain("once for each match");
  });

  it("stacks two measurements on the axis they share", () => {
    const result = compileBrief({
      brief: {
        entity: "task",
        intent: "compare",
        groupBy: "DueDate",
        alongside: { entity: "vendor", as: "beside" },
      },
      entity: taskWithVendor(),
      resource: resource(),
      connection: "api",
      id: "w1",
      related: bothSides(),
    });

    expect(result.errors).toEqual([]);
    // A comparison needs no link: neither set of rows is an attribute of the
    // other, and a join would have nothing to match on.
    expect(result.widget?.combine).toEqual({ op: "union", as: "series" });
    expect(result.widget?.component).toBe("timeseries");
    expect(result.widget?.roles).toEqual({ time: "bucket", value: "count", series: "series" });
    // Each side groups its own date into the same column, or the stack draws
    // nothing: they are different record types with different field names.
    expect(result.widget?.sources.map((one) => one.label)).toEqual(["Tasks", "Vendors"]);
    for (const source of result.widget?.sources ?? []) {
      expect(source.pipeline).toContainEqual(
        expect.objectContaining({ op: "group", agg: { count: "count()" } }),
      );
    }
    // Two record types stacked are not records of either kind.
    expect(result.widget?.entity).toBeUndefined();
  });

  it("refuses a comparison with no axis both sides can be read along", () => {
    const result = compileBrief({
      brief: {
        entity: "task",
        intent: "compare",
        groupBy: "Status",
        alongside: { entity: "vendor", as: "beside" },
      },
      entity: taskWithVendor(),
      resource: resource(),
      connection: "api",
      id: "w1",
      related: bothSides(),
    });

    expect(result.errors).toEqual([]);
    expect(result.widget?.component).toBe("bar");
    expect(result.widget?.sources).toEqual([]);
    expect(result.notes.join(" ")).toContain("one axis");
  });

  it("buckets a date axis, because one bar per moment compares nothing", () => {
    const result = compileBrief({
      brief: { entity: "task", intent: "compare", groupBy: "DueDate" },
      entity: taskWithVendor(),
      resource: resource(),
      connection: "api",
      id: "w1",
    });

    expect(result.widget?.component).toBe("timeseries");
    expect(result.widget?.pipeline).toContainEqual({
      op: "group",
      by: [{ field: "DueDate", bucket: "1mo" }],
      agg: { value: "count()" },
    });
    expect(result.notes.join(" ")).toContain("counted by month");
  });

  it("says nothing about a second record type nobody asked for", () => {
    // The whole feature is inert unless a brief names one: a widget over a
    // single record type compiles exactly as it did.
    const result = compileBrief({
      brief: { entity: "task", intent: "records" },
      entity: taskWithVendor(),
      resource: resource(),
      connection: "api",
      id: "w1",
      related: bothSides(),
    });

    expect(result.widget?.sources).toEqual([]);
    expect(result.widget?.source?.op).toBe("tasks_list");
    expect(result.notes).toEqual([]);
  });
});

/**
 * A collection that only exists inside one record.
 *
 * Sixty of the hundred and eight record types on the API this was built
 * against are like this: `/leases/{leaseId}/transactions` and its siblings. The
 * endpoint cannot be called once for a whole account, so "leases beside their
 * transactions" was refused outright — *"can only be listed for one record at
 * a time"* — and the refusal was the only answer anybody ever got.
 *
 * It is one request per record, which is why the cap and the price are on the
 * widget rather than discovered in a rate-limit error. What makes it safe to
 * offer at all is that nothing is inferred: the API put the parent in the URL,
 * so `scope` is the strongest link this model has, and the graph is what says
 * which parameter the id fills.
 */

/** Lease charges, which only exist under a lease and say which one. */
const charge = (input: Record<string, unknown> = {}): EntitySpec =>
  entitySchema.parse({
    id: "charge",
    resource: "charge",
    name: { one: "Charge", many: "Charges" },
    kind: "money",
    scope: { parent: "vendor", param: "vendorId" },
    identity: { field: "Id", observed: true },
    display: { title: ["Memo"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Memo", label: "Memo", visibility: "primary" },
      { path: "TotalAmount", label: "Amount", semantic: "currency", visibility: "primary" },
      { path: "VendorId", label: "Vendor", visibility: "hidden", reference: { entity: "vendor" } },
      ...((input.fields as unknown[]) ?? []),
    ],
  });

const chargeResource = resourceSchema.parse({
  id: "charge",
  title: "Charges",
  listOp: "charges_list",
});

/** The vendor, and the charges that live under one. */
const underOne = (options: { charge?: EntitySpec } = {}) => ({
  entities: [vendor(), options.charge ?? charge()],
  resources: [vendorResource, chargeResource],
  ops: [
    { id: "vendors_list", path: "/vendors" },
    { id: "charges_list", path: "/vendors/{{param.vendorId}}/charges" },
  ],
});

describe("compileBrief, a collection listed one record at a time", () => {
  const built = (related = underOne()) =>
    compileBrief({
      brief: { entity: "vendor", intent: "records", alongside: { entity: "charge" } },
      entity: vendor(),
      resource: vendorResource,
      connection: "api",
      id: "w1",
      related,
    });

  it("reads it per record rather than refusing the request", () => {
    const result = built();
    expect(result.errors).toEqual([]);
    expect(result.widget?.sources.map((one) => one.op)).toEqual(["vendors_list", "charges_list"]);
  });

  it("drives it from the record's own id, into the parameter the URL names", () => {
    /*
     * The parameter is read off the graph's reach plan, never guessed from the
     * path: a fan-out into the wrong input fetches the wrong records and every
     * one of them is real.
     */
    expect(built().widget?.sources[1]?.fanOut).toEqual({
      from: "vendor",
      field: "Id",
      as: "vendorId",
      maxRows: 25,
    });
  });

  it("matches them back by what the rows themselves say, not by arrival order", () => {
    expect(built().widget?.combine).toMatchObject({
      op: "join",
      on: { left: "Id", right: "VendorId" },
      kind: "left",
    });
  });

  it("says what it costs and where it stops, before anybody spends it", () => {
    const said = built().notes.join(" ");
    expect(said).toContain("25");
    expect(said).toContain("extra requests");
    expect(said).toContain("shows none");
  });

  it("refuses when the rows carry nothing saying which record they belong to", () => {
    /*
     * The fan-out asks the right question — these are that vendor's charges —
     * but every answer arrives in one pile, and without a back-pointer on the
     * row the only way to pair them is arrival order. Rows in the wrong order
     * are still real rows, which is precisely what makes it worth refusing.
     */
    const anonymous = entitySchema.parse({
      ...charge(),
      fields: charge().fields.filter((one) => one.path !== "VendorId"),
    });
    const result = built(underOne({ charge: anonymous }));

    expect(result.widget?.sources).toEqual([]);
    expect(result.notes.join(" ")).toContain("carry nothing saying which one");
  });

  it("still refuses a path parameter nothing in the graph fills", () => {
    // A scope is the API stating the link. A stray parameter is not, and a
    // widget has nowhere to get a value for it.
    const stray = {
      ...underOne(),
      ops: [
        { id: "vendors_list", path: "/vendors" },
        { id: "charges_list", path: "/accounts/{{param.accountId}}/charges" },
      ],
    };
    expect(built(stray).notes.join(" ")).toContain("one record at a time");
  });

  it("parses as a dashboard, which is what a fan-out source has to survive", () => {
    /*
     * The schema refuses a source that fans out from itself or from a name
     * nothing declares, and it refuses the whole board rather than the tile —
     * so a widget this compiles has to pass it whole.
     */
    const widget = built().widget!;
    const parsed = parseDashboard({
      id: "b",
      title: "Board",
      widgets: [widget],
      layout: { cells: [{ widgetId: widget.id, x: 0, y: 0, w: 6, h: 6 }] },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
  });
});
