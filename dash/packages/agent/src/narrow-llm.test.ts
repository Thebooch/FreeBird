import { describe, expect, it } from "vitest";
import type { FieldInfo } from "./infer.js";
import { fakeLlm } from "./llm.js";
import { matchValues, pickNarrowingField } from "./narrow-llm.js";
import type { FieldValue } from "./narrow.js";

/**
 * The model's half of a drill-down, and the guards on it.
 *
 * Both calls are guesses about meaning, so both are checked against what
 * really exists before anything is built on them — the same rule every other
 * model boundary here follows. A field or a value the model invents is an
 * error, never an approximation.
 */

const field = (name: string, kinds: string[], distinct: number): FieldInfo =>
  ({ name, kinds, nullable: false, distinct, samples: [] }) as unknown as FieldInfo;

const fields: FieldInfo[] = [
  field("Id", ["number"], 400),
  field("Title", ["string"], 380),
  field("TaskType", ["string"], 3),
  field("Category.Name", ["string"], 12),
  field("Category", ["object"], 12),
];

describe("pickNarrowingField", () => {
  it("returns the field the model chose", async () => {
    const llm = fakeLlm([
      { args: { field: "Category.Name", reason: "That is where the kind of task is recorded." } },
    ]);
    const result = await pickNarrowingField(llm, {
      intent: "only maintenance tasks",
      opTitle: "Retrieve all tasks",
      fields,
    });

    expect(result.field).toBe("Category.Name");
    expect(result.reason).toContain("kind of task");
    expect(result.error).toBeNull();
  });

  it("refuses a field that does not exist", async () => {
    const llm = fakeLlm([{ args: { field: "MaintenanceFlag", reason: "obviously" } }]);
    const result = await pickNarrowingField(llm, {
      intent: "only maintenance tasks",
      opTitle: "Retrieve all tasks",
      fields,
    });

    expect(result.field).toBeNull();
    expect(result.error).toContain("MaintenanceFlag");
  });

  it("never offers a field holding objects — you cannot choose between those", async () => {
    const llm = fakeLlm([{ args: { field: "Category", reason: "the category" } }]);
    const result = await pickNarrowingField(llm, {
      intent: "maintenance",
      opTitle: "Retrieve all tasks",
      fields,
    });

    expect(result.field).toBeNull();
  });

  it("shows the model real values, not just field names", async () => {
    /*
     * The difference between a guess and a reading. Shown only names, a model
     * asked for "maintenance tasks" picks `TaskType` because it has the fewest
     * values — and `TaskType` holds "Todo" and "Request". Shown the values,
     * the field carrying "Maintenance Request" is the obvious one. Verified
     * against real Buildium rows: the choice flipped once samples appeared.
     */
    const withValues = [
      { ...field("TaskType", ["string"], 2), samples: ["Todo", "Request"] },
      {
        ...field("Category.Name", ["string"], 5),
        samples: ["General Inquiry", "Maintenance Request"],
      },
    ] as unknown as FieldInfo[];

    const llm = fakeLlm([{ args: { field: "Category.Name", reason: "x" } }]);
    await pickNarrowingField(llm, { intent: "maintenance", opTitle: "Tasks", fields: withValues });

    const prompt = llm.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain('e.g. "General Inquiry", "Maintenance Request"');
  });

  it("offers nested fields, and never object ones", async () => {
    const llm = fakeLlm([{ args: { field: "TaskType", reason: "x" } }]);
    await pickNarrowingField(llm, { intent: "maintenance", opTitle: "Tasks", fields });

    const prompt = llm.calls[0]!.messages.map((message) => message.content).join("\n");
    // The spread is how an identifier gives itself away, and it is free.
    expect(prompt).toContain("400 distinct value(s)");
    // Nested names are where the answer usually is.
    expect(prompt).toContain("Category.Name");
    // The object itself cannot be chosen between, so it is not offered.
    expect(prompt).not.toMatch(/^ {2}Category: /m);
  });

  it("reports a model failure rather than throwing", async () => {
    const broken: Parameters<typeof pickNarrowingField>[0] = {
      defaultModel: "x",
      generate: async () => {
        throw new Error("upstream is down");
      },
      stream: async function* () {},
    };
    const result = await pickNarrowingField(broken, {
      intent: "maintenance",
      opTitle: "Tasks",
      fields,
    });
    expect(result.error).toBe("upstream is down");
  });
});

const values: FieldValue[] = [
  { value: "General Inquiry", label: "General Inquiry", count: 120 },
  { value: "Maintenance", label: "Maintenance", count: 88 },
  { value: "Plumbing", label: "Plumbing", count: 40 },
  { value: "Turnover", label: "Turnover", count: 12 },
];

describe("matchValues", () => {
  it("returns the values the model picked", async () => {
    const llm = fakeLlm([
      { args: { values: ["Maintenance", "Plumbing"], reason: "Both are repair work." } },
    ]);
    const result = await matchValues(llm, {
      intent: "maintenance tasks",
      field: "Category.Name",
      values,
    });

    expect(result.values).toEqual(["Maintenance", "Plumbing"]);
    expect(result.reason).toContain("repair work");
  });

  it("drops a value the account does not actually have", async () => {
    // An invented value matches no records, and a filter built on it produces
    // an empty widget that looks like a category with nothing in it.
    const llm = fakeLlm([
      { args: { values: ["Maintenance", "Repairs & Upkeep"], reason: "these" } },
    ]);
    const result = await matchValues(llm, { intent: "maintenance", field: "Category.Name", values });

    expect(result.values).toEqual(["Maintenance"]);
  });

  it("keeps a number a number, so the filter compares it correctly", async () => {
    const numeric: FieldValue[] = [
      { value: 1687, label: "1687", count: 10 },
      { value: 1688, label: "1688", count: 4 },
    ];
    const llm = fakeLlm([{ args: { values: ["1688"], reason: "that one" } }]);
    const result = await matchValues(llm, { intent: "maintenance", field: "CategoryId", values: numeric });

    // `"1688" === 1688` is false, and a widget filtered on the string would
    // silently show nothing at all.
    expect(result.values).toEqual([1688]);
  });

  it("shows the model how many records carry each value", async () => {
    const llm = fakeLlm([{ args: { values: ["Maintenance"], reason: "x" } }]);
    await matchValues(llm, { intent: "maintenance", field: "Category.Name", values });

    const prompt = llm.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("Maintenance  (88 record(s))");
  });

  it("accepts a genuine none — that is an answer", async () => {
    const llm = fakeLlm([{ args: { values: [], reason: "None of these are about maintenance." } }]);
    const result = await matchValues(llm, { intent: "shipping delays", field: "Category.Name", values });

    expect(result.values).toEqual([]);
    expect(result.error).toBeNull();
    expect(result.reason).toContain("None of these");
  });

  it("calls no model when there is nothing to choose from", async () => {
    const llm = fakeLlm([{ args: { values: ["x"], reason: "y" } }]);
    const result = await matchValues(llm, { intent: "maintenance", field: "f", values: [] });

    expect(result.values).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("de-duplicates a value named twice", async () => {
    const llm = fakeLlm([
      { args: { values: ["Maintenance", "Maintenance"], reason: "twice" } },
    ]);
    const result = await matchValues(llm, { intent: "maintenance", field: "Category.Name", values });
    expect(result.values).toEqual(["Maintenance"]);
  });
});
