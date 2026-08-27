import { fakeLlm } from "@freebirdai/dash-agent";
import type { CapabilityReport, CatalogEntry, ConnectionSpec } from "@freebirdai/dash-spec";
import { capabilityReportSchema, catalogEntrySchema, connectionSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { buildConciergeContext } from "./context.js";
import { opensRecords, planDetailSetup, settleDetail } from "./detail.js";

/**
 * The Buildium shape that prompted this: tasks, the notes that hang off one,
 * and a categories collection that does not hang off anything.
 *
 * The notes endpoint needs the task's id in its path, which is exactly what
 * makes it a child rather than a peer — a join has to discard it for the same
 * reason a record can use it.
 */
const connection: ConnectionSpec = connectionSchema.parse({
  id: "pm",
  title: "Property API",
  kind: "rest",
  baseUrl: "https://api.example.com",
  ops: [
    { id: "list_tasks", title: "Retrieve all tasks", path: "/v1/tasks" },
    { id: "task_by_id", title: "Retrieve a task", path: "/v1/tasks/{{param.taskId}}" },
    {
      id: "list_task_notes",
      title: "Retrieve all task notes",
      path: "/v1/tasks/{{param.taskId}}/notes",
    },
    // A notes collection that can be called with nothing, so a relation
    // recorded on the note can be read backwards into a section under a task.
    { id: "list_notes", title: "Retrieve all notes", path: "/v1/notes" },
  ],
});

const map: CatalogEntry = catalogEntrySchema.parse({
  id: "pm",
  title: "Property API",
  baseUrl: "https://api.example.com",
  dialect: { auth: { type: "none" } },
  ops: [
    { id: "list_tasks", title: "Retrieve all tasks", path: "/v1/tasks" },
    { id: "task_by_id", title: "Retrieve a task", path: "/v1/tasks/{{param.taskId}}" },
    {
      id: "list_task_notes",
      title: "Retrieve all task notes",
      path: "/v1/tasks/{{param.taskId}}/notes",
    },
    { id: "list_notes", title: "Retrieve all notes", path: "/v1/notes" },
  ],
  resources: [
    {
      id: "task",
      title: "Task",
      listOp: "list_tasks",
      detailOp: "task_by_id",
      detailParam: "taskId",
      relations: [
        {
          id: "task-notes",
          title: "Notes",
          resource: "task-note",
          cardinality: "many",
          via: "path",
          op: "list_task_notes",
          param: "taskId",
          confidence: "declared",
          verified: false,
        },
      ],
    },
    { id: "task-note", title: "Task note", listOp: "list_task_notes" },
  ],
});

const report: CapabilityReport = capabilityReportSchema.parse({
  connection: "pm",
  generatedAt: new Date("2026-08-01T00:00:00Z").toISOString(),
  opsFingerprint: "abc",
  resources: [
    {
      id: "task",
      title: "Task",
      idField: "Id",
      listOp: "list_tasks",
      detailOp: "task_by_id",
      detailParam: "taskId",
      verified: true,
    },
    { id: "task-note", title: "Task note", idField: "Id", listOp: "list_task_notes", verified: true },
  ],
  shapes: {
    task: {
      rowsPath: "$",
      rowCount: 4,
      schemaHash: "h1",
      fields: [
        { name: "Id", kinds: ["number"], distinct: 4, samples: [1, 2] },
        { name: "Title", kinds: ["string"], distinct: 4, samples: ["Leak"] },
        { name: "TaskStatus", kinds: ["string"], distinct: 2, samples: ["New"] },
        { name: "Category.Href", kinds: ["string"], distinct: 4, samples: ["https://api/x"] },
      ],
    },
    "task-note": {
      rowsPath: "$",
      rowCount: 3,
      schemaHash: "h2",
      fields: [
        { name: "Id", kinds: ["number"], distinct: 3, samples: [9] },
        { name: "Note", kinds: ["string"], distinct: 3, samples: ["Called back"] },
      ],
    },
  },
});

const context = buildConciergeContext({
  connections: [connection],
  reports: [report],
  maps: [map],
});

const chose = (fields: string[], children?: string[]) => [
  { args: { fields, children, reason: "What somebody opens a task to see." } },
];

describe("opensRecords", () => {
  it("is true where the marks are records", () => {
    expect(opensRecords("table")).toBe(true);
    expect(opensRecords("cards")).toBe(true);
    expect(opensRecords("list")).toBe(true);
  });

  it("is false where the marks are aggregates", () => {
    // A point on a monthly count is not a record and has no detail to open.
    expect(opensRecords("timeseries")).toBe(false);
    expect(opensRecords("bar")).toBe(false);
    expect(opensRecords("stat")).toBe(false);
  });

  it("is false for a component this build has never heard of", () => {
    expect(opensRecords("sankey")).toBe(false);
  });
});

describe("planDetailSetup", () => {
  const base = {
    context,
    listOp: "list_tasks",
    detailOp: "task_by_id",
    component: "table",
  };

  it("spends no model call on a widget with no records behind it", async () => {
    const llm = fakeLlm(chose(["Title"]));
    const setup = await planDetailSetup({ ...base, component: "timeseries", llm });

    expect(setup.fields).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("proposes the fields a person opened the record for", async () => {
    const llm = fakeLlm(chose(["Title", "TaskStatus"]));
    const setup = await planDetailSetup({ ...base, llm });

    expect(setup.fields).toEqual(["Title", "TaskStatus"]);
    // Not everything the endpoint returns — `Category.Href` exists for the API.
    expect(setup.fields).not.toContain("Category.Href");
  });

  it("offers the collections that hang off this record", async () => {
    const llm = fakeLlm(chose(["Title"], ["task-note-of-task"]));
    const setup = await planDetailSetup({ ...base, llm });

    expect(setup.sections).toHaveLength(1);
    expect(setup.sections[0]?.op).toBe("list_task_notes");
    /*
     * The notes endpoint takes the task's id in its path, so the section
     * narrows the request rather than fetching every note in the account and
     * matching rows.
     */
    expect(setup.sections[0]?.filterParam).toBe("taskId");
    expect(setup.sections[0]?.columns).toContain("Note");
  });

  it("reports everything it could have shown, so the chat can answer for it", async () => {
    const llm = fakeLlm(chose(["Title"]));
    const setup = await planDetailSetup({ ...base, llm });

    // "What other fields are there?" is a question the chat should not have to
    // go and look up again.
    expect(setup.available.fields).toContain("Category.Href");
    expect(setup.available.fields).toContain("TaskStatus");
    expect(setup.available.children.map((child) => child.title)).toContain("Notes");
  });

  it("offers no children to a component that cannot carry them", async () => {
    const llm = fakeLlm(chose(["Title"], ["task-note-of-task"]));
    // `record` is the detail view; it does not open another one.
    const setup = await planDetailSetup({ ...base, component: "record", llm });
    expect(setup.fields).toEqual([]);
  });

  it("says so when the record endpoint has never been read", async () => {
    const llm = fakeLlm(chose(["Title"]));
    const setup = await planDetailSetup({ ...base, detailOp: "not_read", llm });

    expect(setup.notes.join(" ")).toContain("Nothing has been read");
    expect(llm.calls).toHaveLength(0);
  });

  it("proposes nothing rather than a record of invented fields", async () => {
    const llm = fakeLlm(chose(["Owner", "Assignee"]));
    const setup = await planDetailSetup({ ...base, llm });

    expect(setup.fields).toEqual([]);
    // The options still come back, so the caller can fall back to asking.
    expect(setup.available.fields.length).toBeGreaterThan(0);
  });
});

describe("a link field that names an object", () => {
  /**
   * Relations often name the reference itself — `Property` rather than
   * `Property.Id`. Matching an object against an id compares a value to
   * `[object Object]`, which is false for every row, so the section renders as
   * an empty tab: not wrong data, but a promise of children that never arrive,
   * which is harder to notice than an error.
   */
  const withObjectLink = (childFields: { name: string; kinds: string[] }[]) =>
    buildConciergeContext({
      connections: [connection],
      reports: [
        capabilityReportSchema.parse({
          ...report,
          resources: [
            ...report.resources,
            { id: "note", title: "Note", idField: "Id", listOp: "list_notes", verified: true },
          ],
          shapes: {
            ...report.shapes,
            note: {
              rowsPath: "$",
              rowCount: 3,
              schemaHash: "h2",
              fields: childFields.map((field) => ({ ...field, distinct: 3 })),
            },
          },
        }),
      ],
      maps: [
        catalogEntrySchema.parse({
          ...map,
          resources: [
            { id: "task", title: "Task", listOp: "list_tasks", relations: [] },
            {
              id: "note",
              title: "Note",
              listOp: "list_notes",
              relations: [
                {
                  id: "note-task",
                  title: "Task",
                  resource: "task",
                  cardinality: "one",
                  via: "fanOut",
                  localField: "Task",
                  foreignField: "Id",
                  confidence: "inferred",
                  verified: false,
                },
              ],
            },
          ],
        }),
      ],
    });

  it("uses the readable half when the object has an id inside it", () => {
    const context = withObjectLink([
      { name: "Task", kinds: ["object"] },
      { name: "Task.Id", kinds: ["number"] },
      { name: "Note", kinds: ["string"] },
    ]);

    const child = context.children.find((entry) => entry.parentOp === "list_tasks");
    // `inferShape` flattens one level, so the usable field is right there.
    expect(child?.linkField).toBe("Task.Id");
  });

  it("offers nothing at all when the object has no id inside it", () => {
    const context = withObjectLink([
      { name: "Task", kinds: ["object"] },
      { name: "Note", kinds: ["string"] },
    ]);

    // Better than a tab that is always empty for a reason nobody can see.
    expect(context.children.filter((entry) => entry.parentOp === "list_tasks")).toEqual([]);
  });

  it("leaves a plain scalar link alone", () => {
    const context = withObjectLink([
      { name: "Task", kinds: ["number"] },
      { name: "Note", kinds: ["string"] },
    ]);
    expect(context.children.find((entry) => entry.parentOp === "list_tasks")?.linkField).toBe("Task");
  });
});

describe("settleDetail", () => {
  /**
   * The two confirm paths — the chat's `confirm_setup` and the card's
   * `POST /confirm` — used to diverge here: only the chat planned the record
   * view, so pressing Add on the card produced a record with no related
   * collections however good the relationship graph underneath it was. One
   * implementation, called from both, is the only version that stays true.
   */
  const draft = {
    id: "d1",
    mode: "assisted",
    op: "list_tasks",
    component: "table",
    intent: "tasks and their notes",
    options: [],
    confirmed: [],
    skipped: [],
    drilldown: {
      op: "task_by_id",
      param: "taskId",
      idField: "Id",
      fields: [],
      groups: [],
      sections: [],
    },
  } as unknown as Parameters<typeof settleDetail>[0];

  const plan =
    (result: Partial<Awaited<ReturnType<typeof planDetailSetup>>>) =>
    async (): Promise<Awaited<ReturnType<typeof planDetailSetup>>> => ({
      fields: [],
      groups: [],
      sections: [],
      reason: "",
      available: { fields: [], children: [] },
      notes: [],
      ...result,
    });

  it("folds the planned fields and sections into the draft", async () => {
    const { draft: settled } = await settleDetail(
      draft,
      plan({
        fields: ["Title", "Status"],
        sections: [
          { id: "notes", title: "Notes", op: "list_notes", columns: ["Note"], rowsPath: "$" },
        ],
      }),
    );

    expect(settled.drilldown?.fields).toEqual(["Title", "Status"]);
    expect(settled.drilldown?.sections.map((section) => section.op)).toEqual(["list_notes"]);
  });

  it("hands the plan back as well, so the chat can say what else was available", async () => {
    const { detail } = await settleDetail(
      draft,
      plan({ fields: ["Title"], available: { fields: ["Title", "Owner"], children: [] } }),
    );

    // Going to look again would spend a second call to learn what this one
    // already returned.
    expect(detail?.available.fields).toEqual(["Title", "Owner"]);
  });

  it("leaves the draft alone when there is no planner", async () => {
    // A server with no AI key. A record view with the fields somebody already
    // chose is a worse widget than one with children and a much better one
    // than an error.
    const { draft: settled, detail } = await settleDetail(draft, undefined);
    expect(settled).toBe(draft);
    expect(detail).toBeNull();
  });

  it("leaves the draft alone when the planner proposes nothing", async () => {
    const { draft: settled } = await settleDetail(draft, plan({ fields: [] }));
    expect(settled).toBe(draft);
  });

  it("does nothing for a widget that opens no record", async () => {
    const noClick = { ...draft, drilldown: undefined } as typeof draft;
    const { draft: settled, detail } = await settleDetail(noClick, plan({ fields: ["Title"] }));
    expect(settled).toBe(noClick);
    expect(detail).toBeNull();
  });
});
