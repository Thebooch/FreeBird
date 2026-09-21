import { describe, expect, it } from "vitest";
import { answerBrief, briefOptions } from "./brief-options.js";
import { compileBrief, type WidgetBrief } from "./brief.js";
import { entityGraph } from "./entity-graph.js";
import { entitySchema, type EntitySpec } from "./entity.js";
import { resourceSchema } from "./resource.js";

/**
 * What a widget could be changed to, and changing it.
 *
 * The pair has to be tested together: a control that reads one field and an
 * answer that writes another is a setting that appears to do nothing, and
 * neither half alone would show it. The property every test here rests on is
 * that answering a control and compiling the result is a change of exactly
 * that one thing.
 */

const task: EntitySpec = entitySchema.parse({
  id: "task",
  resource: "task",
  name: { one: "Task", many: "Tasks" },
  kind: "work",
  identity: { field: "Id", observed: true },
  display: { title: ["Title"], status: "Status" },
  views: { columns: ["Title", "Status"] },
  fields: [
    { path: "Id", visibility: "hidden" },
    { path: "Title", label: "Summary", visibility: "primary" },
    { path: "Status", label: "Status", visibility: "primary", values: ["Open", "Done"] },
    { path: "Priority", label: "Priority", visibility: "detail" },
    { path: "DueDate", label: "Due date", semantic: "timestamp", visibility: "detail" },
    { path: "Cost", label: "Cost", semantic: "currency", visibility: "detail" },
    { path: "Payload", label: "Payload", kinds: ["object"], visibility: "detail" },
    {
      path: "SupplierId",
      label: "Supplier",
      visibility: "detail",
      reference: { entity: "supplier" },
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
    { path: "Phone", label: "Phone", visibility: "primary" },
  ],
});

const resources = [
  resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" }),
  resourceSchema.parse({ id: "supplier", title: "Suppliers", listOp: "suppliers_list" }),
];

const graph = entityGraph({
  entities: [task, supplier],
  resources,
  ops: [
    { id: "tasks_list", path: "/tasks" },
    { id: "suppliers_list", path: "/suppliers" },
  ],
});

const controlsFor = (brief: Partial<WidgetBrief>) =>
  briefOptions({
    brief: { entity: "task", intent: "records", ...brief } as WidgetBrief,
    entity: task,
    graph,
    entities: [task, supplier],
  });

const find = (brief: Partial<WidgetBrief>, stepId: string) =>
  controlsFor(brief).find((control) => control.stepId === stepId);

const compile = (brief: WidgetBrief) =>
  compileBrief({
    brief,
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

describe("what a widget could be changed to", () => {
  it("shows what the record type chose, until somebody chooses", () => {
    /*
     * The distinction a settings panel lives or dies by: a control showing a
     * default must not claim it was decided, or every widget looks
     * hand-configured and nobody can tell what they actually said.
     */
    const columns = find({}, "columns")!;
    expect(columns.value).toEqual(["Title", "Status"]);
    expect(columns.settled).toBe(false);

    const asked = find({ columns: ["Title", "Cost"] }, "columns")!;
    expect(asked.value).toEqual(["Title", "Cost"]);
    expect(asked.settled).toBe(true);
  });

  it("offers only views this record type can actually be read as", () => {
    const named = find({}, "view")!;
    expect(named.options.map((one) => one.value)).toEqual(["table", "cards", "list", "feed"]);

    const anonymous = briefOptions({
      brief: { entity: "task", intent: "records" },
      entity: entitySchema.parse({
        id: "row",
        resource: "row",
        name: { one: "Row", many: "Rows" },
        kind: "other",
        fields: [{ path: "Value", visibility: "primary" }],
      }),
    }).find((control) => control.stepId === "view")!;
    // Nothing says what to call one, so a card or a list would be a binding
    // error wearing a friendly name.
    expect(anonymous.options.map((one) => one.value)).toEqual(["table"]);
  });

  it("never offers a record as something to narrow or compare by", () => {
    // Binding one renders "[object Object]" in every tile.
    const filters = find({}, "filters")!;
    expect(filters.options.map((one) => one.value)).not.toContain("Payload");

    const across = briefOptions({
      brief: { entity: "task", intent: "compare", groupBy: "Status" },
      entity: task,
    }).find((control) => control.stepId === "groupBy")!;
    expect(across.options.map((one) => one.value)).not.toContain("Payload");
  });

  it("offers the values a strip can start on, only where the API states them", () => {
    const stated = find({ filters: [{ field: "Status" }] }, "narrow:Status")!;
    expect(stated.options.map((one) => one.value)).toEqual(["Open", "Done"]);
    // A sample cannot establish a closed set, so a field the API says nothing
    // about gets no control rather than a guess built from whatever rows exist.
    expect(find({ filters: [{ field: "Priority" }] }, "narrow:Priority")).toBeUndefined();
  });

  it("offers only what the graph can actually reach", () => {
    const alongside = find({}, "alongside")!;
    expect(alongside.options.map((one) => one.value)).toEqual(["supplier"]);

    // With no graph there is nothing to say, so nothing is offered.
    expect(
      briefOptions({ brief: { entity: "task", intent: "records" }, entity: task }).some(
        (control) => control.stepId === "alongside",
      ),
    ).toBe(false);
  });

  it("asks about a measurement instead, when that is what the widget is", () => {
    const measure = briefOptions({
      brief: { entity: "task", intent: "measure" },
      entity: task,
    });
    const ids = measure.map((control) => control.stepId);
    expect(ids).toContain("measure");
    // Columns, strips and ordering are all statements about rows, and a
    // measurement has none.
    expect(ids).not.toContain("columns");
    expect(ids).not.toContain("filters");
  });

  it("never offers to change which records it is about", () => {
    // That is a different widget, not an edit — and treating it as one would
    // silently drop every column naming a field the new type has not got.
    expect(controlsFor({}).map((control) => control.stepId)).not.toContain("entity");
  });
});

describe("answering a control", () => {
  const brief: WidgetBrief = { entity: "task", intent: "records" };

  it("changes exactly the one thing, and compiles to prove it", () => {
    const edited = answerBrief(brief, "columns", ["Title", "Cost"]);
    expect(edited).toEqual({ entity: "task", intent: "records", columns: ["Title", "Cost"] });

    const widget = compile(edited).widget!;
    expect(widget.roles.columns).toEqual(["Title", "Cost"]);
  });

  it("treats an empty answer as cleared, so a strip can be turned off", () => {
    /*
     * Saying nothing and saying "none" are different answers. Collapsing them
     * would make the last strip impossible to remove: every untick would land
     * as an empty list and be answered with the defaults again.
     */
    const none = answerBrief({ ...brief, filters: [{ field: "Status" }] }, "filters", []);
    expect(none.filters).toEqual([]);
    expect(compile(none).widget?.facets).toEqual([]);
  });

  it("keeps what a strip was narrowed to when the strips change", () => {
    const narrowed: WidgetBrief = {
      ...brief,
      filters: [{ field: "Status", values: ["Open"] }],
    };
    const both = answerBrief(narrowed, "filters", ["Status", "Priority"]);
    expect(both.filters).toEqual([{ field: "Status", values: ["Open"] }, { field: "Priority" }]);
  });

  it("gives a title back to the record type when it is cleared", () => {
    const named = answerBrief(brief, "title", ["Overdue work"]);
    expect(compile(named).widget?.title).toBe("Overdue work");
    expect(compile(answerBrief(named, "title", [])).widget?.title).toBe("Tasks");
  });

  it("carries a view through to the widget, and falls back when it cannot bind", () => {
    const cards = answerBrief(brief, "view", ["cards"]);
    expect(compile(cards).widget?.component).toBe("cards");

    const anonymous = entitySchema.parse({
      id: "task",
      resource: "task",
      name: { one: "Task", many: "Tasks" },
      kind: "work",
      fields: [{ path: "Value", visibility: "primary" }],
    });
    const fallen = compileBrief({
      brief: cards,
      entity: anonymous,
      resource: resources[0]!,
      connection: "api",
      id: "w1",
    });
    expect(fallen.widget?.component).toBe("table");
    expect(fallen.notes.join(" ")).toContain("what to call one");
  });

  it("round-trips a second record type through the control that offers it", () => {
    const beside = answerBrief(brief, "alongside", ["supplier"]);
    expect(beside.alongside).toEqual({ entity: "supplier", as: "join" });

    const widget = compile(beside).widget!;
    expect(widget.combine).toMatchObject({ op: "join" });
    // And the control now reads back as settled, on the widget's own brief.
    expect(find(widget.brief!, "alongside")?.settled).toBe(true);
  });

  it("reads a field through a reference, and back", () => {
    const linked = answerBrief(brief, "linked", ["SupplierId.Name"]);
    expect(linked.linked).toEqual([{ through: "SupplierId", field: "Name" }]);
    expect(compile(linked).widget?.linked).toContainEqual(
      expect.objectContaining({ through: "SupplierId", field: "Name" }),
    );
  });

  it("leaves the brief alone for a control it does not know", () => {
    expect(answerBrief(brief, "invented", ["x"])).toEqual(brief);
  });
});

/**
 * A collection that only exists inside one of these, offered with its price.
 *
 * The control reads the graph, so what it offers is what could actually be
 * built — and this kind can be built now, one request per record. It is last
 * and it says so: an option whose cost is discovered after clicking is an
 * option offered dishonestly.
 */
describe("the second record type, where it is reached one record at a time", () => {
  /** Notes on a task, which exist only under a task and say which one. */
  const note: EntitySpec = entitySchema.parse({
    id: "note",
    resource: "note",
    name: { one: "Note", many: "Notes" },
    kind: "event",
    scope: { parent: "task", param: "taskId" },
    identity: { field: "Id", observed: true },
    display: { title: ["Body"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Body", label: "Note", visibility: "primary" },
      { path: "TaskId", label: "Task", visibility: "hidden", reference: { entity: "task" } },
    ],
  });

  /** The same notes, with nothing on them saying whose they are. */
  const anonymous: EntitySpec = entitySchema.parse({
    ...note,
    fields: note.fields.filter((one) => one.path !== "TaskId"),
  });

  const withNotes = (far: EntitySpec) => {
    const all = [task, supplier, far];
    const inner = entityGraph({
      entities: all,
      resources: [
        ...resources,
        resourceSchema.parse({ id: "note", title: "Notes", listOp: "notes_list" }),
      ],
      ops: [
        { id: "tasks_list", path: "/tasks" },
        { id: "suppliers_list", path: "/suppliers" },
        { id: "notes_list", path: "/tasks/{{param.taskId}}/notes" },
      ],
    });
    return briefOptions({
      brief: { entity: "task", intent: "records" },
      entity: task,
      graph: inner,
      entities: all,
    }).find((control) => control.stepId === "alongside");
  };

  it("offers it, after the ones that cost nothing extra", () => {
    const control = withNotes(note)!;
    expect(control.options.map((one) => one.value)).toEqual(["supplier", "note"]);
  });

  it("says what it costs on the option itself", () => {
    const offered = withNotes(note)!.options.find((one) => one.value === "note");
    expect(offered?.description).toContain("request each");
  });

  it("leaves it off when choosing it would produce a sentence instead of a widget", () => {
    /*
     * The compiler refuses a per-record collection whose rows carry nothing
     * saying which record they belong to, so offering it here would be a
     * control that does nothing — which is worse than one that is absent.
     */
    expect(withNotes(anonymous)!.options.map((one) => one.value)).toEqual(["supplier"]);
  });
});
