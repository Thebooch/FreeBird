import { fakeLlm } from "@freebirdai/dash-agent";
import type { CapabilityReport, ConnectionSpec } from "@freebirdai/dash-spec";
import { capabilityReportSchema, connectionSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { buildConciergeContext } from "./context.js";
import { planNarrowing } from "./drilldown.js";

/**
 * The Buildium case that prompted this, reduced to its shape.
 *
 * Tasks whose kind lives on a nested `Category.Name` holding words somebody
 * chose when they set the account up, plus a categories collection the API
 * publishes separately — which is the cheap way to learn the vocabulary and
 * the one a scan should never be preferred over.
 */
const connection: ConnectionSpec = connectionSchema.parse({
  id: "pm",
  title: "Property API",
  kind: "rest",
  baseUrl: "https://api.example.com",
  ops: [
    { id: "list_tasks", title: "Retrieve all tasks", path: "/v1/tasks" },
    { id: "list_categories", title: "Retrieve all task categories", path: "/v1/tasks/categories" },
  ],
  resources: [
    { id: "task", title: "Task", listOp: "list_tasks" },
    { id: "category", title: "Category", listOp: "list_categories" },
  ],
});

const report: CapabilityReport = capabilityReportSchema.parse({
  connection: "pm",
  generatedAt: new Date("2026-08-01T00:00:00Z").toISOString(),
  opsFingerprint: "abc",
  resources: [
    { id: "task", title: "Task", idField: "Id", listOp: "list_tasks", verified: true },
    { id: "category", title: "Category", idField: "Id", listOp: "list_categories", verified: true },
  ],
  shapes: {
    task: {
      rowsPath: "$",
      rowCount: 5,
      schemaHash: "h1",
      fields: [
        { name: "Id", kinds: ["number"], distinct: 400 },
        { name: "Title", kinds: ["string"], distinct: 380 },
        { name: "TaskType", kinds: ["string"], distinct: 3 },
        { name: "Category.Name", kinds: ["string"], distinct: 12 },
      ],
    },
    category: {
      rowsPath: "$",
      rowCount: 3,
      schemaHash: "h2",
      fields: [
        { name: "Id", kinds: ["number"], distinct: 3 },
        { name: "Name", kinds: ["string"], distinct: 3 },
      ],
    },
  },
});

const context = buildConciergeContext({ connections: [connection], reports: [report] });

/** Every category the API publishes — including one no task carries yet. */
const categories = [
  { Id: 1687, Name: "General Inquiry" },
  { Id: 1688, Name: "Maintenance" },
  { Id: 1689, Name: "Plumbing" },
  { Id: 1690, Name: "Landscaping" },
];

/** Tasks as they come back — note no task is Landscaping. */
const tasks = [
  { Id: 1, Category: { Id: 1687, Name: "General Inquiry" } },
  { Id: 2, Category: { Id: 1688, Name: "Maintenance" } },
  { Id: 3, Category: { Id: 1688, Name: "Maintenance" } },
  { Id: 4, Category: { Id: 1689, Name: "Plumbing" } },
];

const answers = (field: string, values: string[]) => [
  { args: { field, reason: "That is where the kind of task is recorded." } },
  { args: { values, reason: "Both are repair work." } },
];

describe("planNarrowing", () => {
  it("reads the vocabulary from the API's own collection, not from records", async () => {
    const fetched: string[] = [];
    const plan = await planNarrowing({
      llm: fakeLlm(answers("Category.Name", ["Maintenance", "Plumbing"])),
      phrase: "maintenance tasks",
      op: "list_tasks",
      context,
      fetchRows: async (opId) => {
        fetched.push(opId);
        return opId === "list_categories" ? categories : tasks;
      },
    });

    /*
     * Two requests, each answering a different question. The records come
     * first because the field list has to come from them — a declared schema
     * flattens nested objects away, and `Category.Name` is exactly what gets
     * lost. The collection comes second because it is the complete
     * vocabulary: Landscaping exists and no task carries it, so a scan of
     * records would never have offered it.
     */
    expect(fetched).toEqual(["list_tasks", "list_categories"]);
    expect(plan.source).toBe("lookup");
    expect(plan.values.map((v) => v.value)).toContain("Landscaping");
    expect(plan.proposed).toEqual(["Maintenance", "Plumbing"]);
  });

  it("falls back to scanning records when the API publishes no vocabulary", async () => {
    const bare = buildConciergeContext({
      connections: [
        connectionSchema.parse({ ...connection, ops: [connection.ops[0]!], resources: [] }),
      ],
      reports: [report],
    });

    const fetched: string[] = [];
    const plan = await planNarrowing({
      llm: fakeLlm(answers("Category.Name", ["Maintenance"])),
      phrase: "maintenance tasks",
      op: "list_tasks",
      context: bare,
      fetchRows: async (opId) => {
        fetched.push(opId);
        return tasks;
      },
    });

    expect(fetched).toEqual(["list_tasks"]);
    expect(plan.source).toBe("scan");
    // Commonest first, and Landscaping is absent because nothing carries it.
    expect(plan.values.map((v) => v.value)).toEqual([
      "Maintenance",
      "General Inquiry",
      "Plumbing",
    ]);
  });

  it("spends nothing when the caller has not offered to", async () => {
    // No `fetchRows` means no reading, which is the right default before the
    // user has been asked to pay for anything.
    const plan = await planNarrowing({
      llm: fakeLlm(answers("Category.Name", ["Maintenance"])),
      phrase: "maintenance tasks",
      op: "list_tasks",
      context,
    });

    expect(plan.values).toEqual([]);
    expect(plan.notes.join(" ")).toContain("Reading some records would");
    // The field is still known, so the caller can say what it would look at.
    expect(plan.field).toBe("Category.Name");
  });

  it("refuses a field that identifies rather than classifies", async () => {
    const idRows = Array.from({ length: 300 }, (_, index) => ({ Id: index }));
    const plan = await planNarrowing({
      llm: fakeLlm([{ args: { field: "Id", reason: "ids" } }]),
      phrase: "maintenance tasks",
      op: "list_tasks",
      context,
      fetchRows: async () => idRows,
    });

    expect(plan.proposed).toEqual([]);
    expect(plan.notes.join(" ")).toContain("identifier");
  });

  it("reports records that carry no value at all", async () => {
    const withGaps = [...tasks, { Id: 9, Category: null }, { Id: 10, Category: null }];
    const bare = buildConciergeContext({
      connections: [
        connectionSchema.parse({ ...connection, ops: [connection.ops[0]!], resources: [] }),
      ],
      reports: [report],
    });

    const plan = await planNarrowing({
      llm: fakeLlm(answers("Category.Name", ["Maintenance"])),
      phrase: "maintenance tasks",
      op: "list_tasks",
      context: bare,
      fetchRows: async () => withGaps,
    });

    // Usually the real answer to "why is that record missing from my widget".
    expect(plan.notes.join(" ")).toContain("2 of 6 record(s) have no Category.Name");
  });

  it("stops before the second call when no field could be chosen", async () => {
    const llm = fakeLlm([{ args: { field: "NotAField", reason: "invented" } }]);
    const plan = await planNarrowing({
      llm,
      phrase: "maintenance",
      op: "list_tasks",
      context,
      fetchRows: async () => tasks,
    });

    expect(plan.field).toBeNull();
    // A bad field costs one call, not two, and no request at all.
    expect(llm.calls).toHaveLength(1);
  });

  it("proposes without applying — nothing is filtered until a person says so", async () => {
    const plan = await planNarrowing({
      llm: fakeLlm(answers("Category.Name", ["Maintenance"])),
      phrase: "maintenance tasks",
      op: "list_tasks",
      context,
      fetchRows: async (opId) => (opId === "list_categories" ? categories : tasks),
    });

    // The proposal and the full list travel together, so the card can show
    // what was chosen *and* what it was chosen from.
    expect(plan.proposed).toEqual(["Maintenance"]);
    expect(plan.values.length).toBeGreaterThan(plan.proposed.length);
    expect(plan.proposedReason).toContain("repair work");
  });
});

describe("nested fields the declared schema never mentioned", () => {
  /**
   * The case that made this necessary.
   *
   * The map read Buildium's OpenAPI and recorded `Category` as an opaque
   * value, so the only fields on offer were flat ones — `TaskType`, `Priority`
   * — none of which say anything about maintenance. The kind of a task lives
   * on `Category.Name`, one level down, and no amount of asking a model to
   * choose from the declared list was going to find it.
   */
  const flatOnly = buildConciergeContext({
    connections: [
      connectionSchema.parse({ ...connection, ops: [connection.ops[0]!], resources: [] }),
    ],
    reports: [
      capabilityReportSchema.parse({
        ...report,
        resources: [{ id: "task", title: "Task", idField: "Id", listOp: "list_tasks", verified: true }],
        shapes: {
          task: {
            rowsPath: "$",
            rowCount: 4,
            schemaHash: "h1",
            fields: [
              { name: "Id", kinds: ["number"], distinct: 400 },
              { name: "TaskType", kinds: ["string"], distinct: 3 },
              // `Category` as the schema described it: opaque, and useless.
              { name: "Category", kinds: ["string"], distinct: 12 },
            ],
          },
        },
      }),
    ],
  });

  it("offers the nested field because the rows have it, whatever the schema said", async () => {
    const llm = fakeLlm([
      { args: { field: "Category.Name", reason: "the kind of task" } },
      { args: { values: ["Maintenance"], reason: "repairs" } },
    ]);

    const plan = await planNarrowing({
      llm,
      phrase: "maintenance tasks",
      op: "list_tasks",
      context: flatOnly,
      fetchRows: async () => tasks,
    });

    // The model was shown a field list built from real rows, not the map's.
    const shown = llm.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(shown).toContain("Category.Name");
    expect(plan.field).toBe("Category.Name");
    expect(plan.proposed).toEqual(["Maintenance"]);
  });

  it("falls back to the declared fields when nothing can be read", async () => {
    const llm = fakeLlm([
      { args: { field: "TaskType", reason: "the type" } },
      { args: { values: [], reason: "none" } },
    ]);

    const plan = await planNarrowing({
      llm,
      phrase: "maintenance tasks",
      op: "list_tasks",
      context: flatOnly,
    });

    // No fetch means the schema is all there is, and it still gets a chance.
    const shown = llm.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(shown).toContain("TaskType");
    expect(plan.values).toEqual([]);
  });

  it("reads the records once, not once per question", async () => {
    const fetched: string[] = [];
    const llm = fakeLlm([
      { args: { field: "Category.Name", reason: "kind" } },
      { args: { values: ["Maintenance"], reason: "repairs" } },
    ]);

    await planNarrowing({
      llm,
      phrase: "maintenance",
      op: "list_tasks",
      context: flatOnly,
      fetchRows: async (opId) => {
        fetched.push(opId);
        return tasks;
      },
    });

    // The same body answers "what fields are there" and "what values do they
    // hold" — two questions, one request.
    expect(fetched).toEqual(["list_tasks"]);
  });
});
