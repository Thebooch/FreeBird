import { describe, expect, it } from "vitest";
import type { CategorySpec, EntitySpec, ResourceSpec } from "@freebirdai/dash-spec";
import { categorySchema, entitySchema, resourceSchema } from "@freebirdai/dash-spec";
import type { BriefCandidate } from "./brief.js";
import { fakeLlm } from "./llm.js";
import {
  buildStarterPrompt,
  composeStarters,
  starterBatchKey,
  startersFromProposal,
  type StarterCheck,
  type StarterProposal,
} from "./starters.js";

const TASK: EntitySpec = entitySchema.parse({
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
    { path: "DueDate", label: "Due date", semantic: "timestamp", visibility: "detail" },
    { path: "Cost", label: "Cost", semantic: "currency", visibility: "detail" },
  ],
});

const RESOURCE: ResourceSpec = resourceSchema.parse({
  id: "task",
  title: "Tasks",
  listOp: "tasks_list",
});

const CHECK: StarterCheck = {
  entities: [TASK],
  resources: [RESOURCE],
  ops: [{ id: "tasks_list", path: "/v1/tasks", params: [] }],
  connection: "acme",
  pathOf: (op) => (op === "tasks_list" ? "/v1/tasks" : undefined),
};

const candidate: BriefCandidate = {
  entity: "task",
  connection: "acme",
  recordType: "task",
  source: "Acme",
  many: "Tasks",
  kind: "work",
  description: "Something to be done on the account.",
  starting: true,
  fields: [
    { path: "Status", label: "Status", role: "narrow", values: ["Open", "Closed"] },
    { path: "Cost", label: "Cost", role: "total" },
  ],
};

const category = (input: Record<string, unknown> = {}): CategorySpec =>
  categorySchema.parse({
    id: "maintenance",
    title: "Maintenance",
    description: "Work on the properties and who does it.",
    entities: ["task"],
    ...input,
  });

const PROPOSAL: StarterProposal = {
  widgets: [
    { entity: "task", intent: "measure", title: "Open work", importance: 5, size: "sm" },
    { entity: "task", intent: "compare", groupBy: "Status", importance: 4, size: "md" },
    {
      entity: "task",
      intent: "records",
      filters: [{ field: "Status", values: ["Open"] }],
      importance: 3,
      size: "lg",
    },
  ],
};

describe("buildStarterPrompt", () => {
  it("names the part, and only the record types in it", () => {
    const prompt = buildStarterPrompt({
      apiTitle: "Acme",
      category: category(),
      candidates: [candidate],
    });
    expect(prompt).toContain("PART OF IT: Maintenance");
    expect(prompt).toContain("WHICH COVERS: Work on the properties and who does it.");
    expect(prompt).toContain("task  Tasks  — Something to be done on the account.");
  });

  /* A filter strip written in the user's spelling matches nothing. The values
   * the API declares are the only ones a narrowed strip can start on. */
  it("shows the real values a field holds", () => {
    const prompt = buildStarterPrompt({
      apiTitle: "Acme",
      category: category(),
      candidates: [candidate],
    });
    expect(prompt).toContain("Status (Status) one of: Open / Closed");
    expect(prompt).toContain("worth totalling: Cost (Cost)");
  });
});

describe("record types that only exist under a parent", () => {
  const CHILD: EntitySpec = entitySchema.parse({
    id: "note",
    resource: "note",
    name: { one: "Note", many: "Notes" },
    kind: "note",
    scope: { parent: "task", param: "taskId" },
    fields: [{ path: "Body", label: "Body", visibility: "primary" }],
  });

  const childCandidate: BriefCandidate = {
    ...candidate,
    entity: "note",
    recordType: "note",
    many: "Notes",
    fields: [],
  };

  /* A pick spent on one of these is refused by the compiler, correctly — but
   * the pick is already gone. Measured on a real API, three of one part's five
   * widgets went this way and it opened with two. */
  it("does not offer them", () => {
    const prompt = buildStarterPrompt({
      apiTitle: "Acme",
      category: category({ entities: ["task", "note"] }),
      candidates: [candidate, childCandidate],
      scoped: ["note"],
    });
    expect(prompt).toContain("task  Tasks");
    expect(prompt).not.toContain("note  Notes");
  });

  /* Named rather than silently dropped: a model shown a list it cannot account
   * for reaches for the nearest thing it can. */
  it("says they exist and why they are not available", () => {
    const prompt = buildStarterPrompt({
      apiTitle: "Acme",
      category: category({ entities: ["task", "note"] }),
      candidates: [candidate, childCandidate],
      scoped: ["note"],
    });
    expect(prompt).toContain("NOT AVAILABLE");
    expect(prompt).toContain("  Notes");
  });

  it("rules them out of the call, reading scope off the record types", async () => {
    const llm = fakeLlm([{ args: PROPOSAL }]);
    await composeStarters(llm, {
      apiTitle: "Acme",
      categories: [category({ entities: ["task", "note"] })],
      candidates: [candidate, childCandidate],
      check: { ...CHECK, entities: [TASK, CHILD] },
    });
    const sent = llm.calls[0]?.messages.map((one) => one.content).join(" ") ?? "";
    expect(sent).toContain("NOT AVAILABLE");
    expect(sent).not.toContain("note  Notes");
  });

  it("composes no dashboard for a part that is nothing but children", async () => {
    const llm = fakeLlm([{ args: PROPOSAL }]);
    const result = await composeStarters(llm, {
      apiTitle: "Acme",
      categories: [category({ entities: ["note"] })],
      candidates: [childCandidate],
      check: { ...CHECK, entities: [TASK, CHILD] },
    });
    expect(llm.calls).toEqual([]);
    expect(result.skipped.join(" ")).toMatch(/only exists underneath another/);
  });
});

describe("startersFromProposal", () => {
  it("keeps widgets that compile, with their importance and size", () => {
    const built = startersFromProposal({
      proposal: PROPOSAL,
      candidates: [candidate],
      category: category(),
      check: CHECK,
    });
    expect(built.skipped).toEqual([]);
    expect(built.starters).toHaveLength(3);
    expect(built.starters[0]).toMatchObject({
      brief: { entity: "task", intent: "measure", title: "Open work" },
      importance: 5,
      size: "sm",
    });
    expect(built.starters[2]?.brief.filters).toEqual([{ field: "Status", values: ["Open"] }]);
  });

  it("defaults an importance nobody gave", () => {
    const built = startersFromProposal({
      proposal: { widgets: [{ entity: "task", intent: "records" }] },
      candidates: [candidate],
      category: category(),
    });
    expect(built.starters[0]?.importance).toBe(3);
  });

  it("clamps an importance outside the scale rather than losing the widget", () => {
    const built = startersFromProposal({
      proposal: { widgets: [{ entity: "task", intent: "records", importance: 11 }] },
      candidates: [candidate],
      category: category(),
    });
    expect(built.starters[0]?.importance).toBe(5);
  });

  it("refuses a record type that is not in this part", () => {
    const built = startersFromProposal({
      proposal: { widgets: [{ entity: "invoice", intent: "records" }] },
      candidates: [candidate],
      category: category(),
    });
    expect(built.starters).toEqual([]);
    expect(built.skipped.join(" ")).toMatch(/not a record type in this part/);
  });

  /* The boundary that matters: not "is this a real record type" but "does this
   * actually build". The compiler's own sentence is the only one that knows
   * which field the widget needed and did not find. */
  it("drops a widget the compiler refuses, with the compiler's reason", () => {
    const built = startersFromProposal({
      proposal: { widgets: [{ entity: "task", intent: "compare", groupBy: "Nonexistent" }] },
      candidates: [candidate],
      category: category(),
      check: CHECK,
    });
    expect(built.starters).toEqual([]);
    expect(built.skipped.join(" ")).toMatch(/Nonexistent/);
  });

  it("drops a sum of something that is not a number", () => {
    const built = startersFromProposal({
      proposal: {
        widgets: [
          { entity: "task", intent: "measure", measureAgg: "sum", measureField: "Title" },
        ],
      },
      candidates: [candidate],
      category: category(),
      check: CHECK,
    });
    expect(built.starters).toEqual([]);
    expect(built.skipped.length).toBe(1);
  });

  it("refuses the same widget twice", () => {
    const built = startersFromProposal({
      proposal: {
        widgets: [
          { entity: "task", intent: "records" },
          { entity: "task", intent: "records" },
        ],
      },
      candidates: [candidate],
      category: category(),
      check: CHECK,
    });
    expect(built.starters).toHaveLength(1);
    expect(built.skipped.join(" ")).toMatch(/same thing as an earlier one/);
  });

  it("stops at as many widgets as one board opens with", () => {
    const built = startersFromProposal({
      proposal: {
        widgets: Array.from({ length: 12 }, (_, index) => ({
          entity: "task",
          intent: "compare" as const,
          groupBy: index % 2 === 0 ? "Status" : "DueDate",
          title: `Widget ${index}`,
        })),
      },
      candidates: [candidate],
      category: category(),
    });
    expect(built.starters.length).toBeLessThanOrEqual(8);
    expect(built.proposed).toBe(12);
  });
});

describe("composeStarters", () => {
  const input = {
    apiTitle: "Acme",
    categories: [category()],
    candidates: [candidate],
    check: CHECK,
  };

  it("writes a set onto the category", async () => {
    const llm = fakeLlm([{ args: PROPOSAL }]);
    const result = await composeStarters(llm, input);
    expect(result.errors).toEqual([]);
    expect(result.categories[0]?.starters).toHaveLength(3);
    expect(result.kept).toBe(3);
    expect(llm.calls[0]?.toolChoice).toEqual({ name: "compose_dashboard" });
  });

  it("asks once per category", async () => {
    const llm = fakeLlm([{ args: PROPOSAL }]);
    await composeStarters(llm, {
      ...input,
      categories: [category(), category({ id: "leasing", title: "Leasing" })],
    });
    expect(llm.calls).toHaveLength(2);
  });

  it("skips a category whose set is already written", async () => {
    const done = category({ starters: [{ brief: { entity: "task", intent: "records" } }] });
    const llm = fakeLlm([{ args: PROPOSAL }]);
    const result = await composeStarters(llm, { ...input, categories: [done] }, {
      completedBatches: [starterBatchKey("Acme", done)],
    });
    expect(llm.calls).toEqual([]);
    expect(result.categories[0]?.starters).toHaveLength(1);
  });

  /* A completed batch with nothing behind it is a run interrupted between the
   * call and the write. Trusting the marker there loses the category for good. */
  it("re-runs a category marked done that has no starters", async () => {
    const empty = category();
    const llm = fakeLlm([{ args: PROPOSAL }]);
    await composeStarters(llm, { ...input, categories: [empty] }, {
      completedBatches: [starterBatchKey("Acme", empty)],
    });
    expect(llm.calls).toHaveLength(1);
  });

  it("re-runs a category whose record types changed", () => {
    const before = starterBatchKey("Acme", category());
    const after = starterBatchKey("Acme", category({ entities: ["task", "vendor"] }));
    expect(before).not.toBe(after);
  });

  it("keeps the categories it finished when one call fails", async () => {
    const llm = fakeLlm([{ args: PROPOSAL }, { text: "no tool for me" }]);
    const result = await composeStarters(llm, {
      ...input,
      categories: [category(), category({ id: "leasing", title: "Leasing" })],
    });
    expect(result.categories[0]?.starters).toHaveLength(3);
    expect(result.categories[1]?.starters).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/without calling the tool/);
    expect(result.completedBatches).toHaveLength(1);
  });

  it("checkpoints after each category", async () => {
    const seen: number[] = [];
    const llm = fakeLlm([{ args: PROPOSAL }]);
    await composeStarters(
      llm,
      { ...input, categories: [category(), category({ id: "leasing", title: "Leasing" })] },
      { onCheckpoint: (result) => seen.push(result.completedBatches.length) },
    );
    expect(seen).toEqual([1, 2]);
  });

  it("says so when a category has no described record types", async () => {
    const llm = fakeLlm([{ args: PROPOSAL }]);
    const result = await composeStarters(llm, {
      ...input,
      categories: [category({ entities: ["ghost"] })],
    });
    expect(llm.calls).toEqual([]);
    expect(result.skipped.join(" ")).toMatch(/none of its record types are described/);
  });

  it("reports a category where nothing it proposed could be built", async () => {
    const llm = fakeLlm([
      { args: { widgets: [{ entity: "task", intent: "compare", groupBy: "Nope" }] } },
    ]);
    const result = await composeStarters(llm, input);
    expect(result.categories[0]?.starters).toEqual([]);
    expect(result.skipped.join(" ")).toMatch(/nothing it proposed could be built/);
  });
});
