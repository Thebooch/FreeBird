import { describe, expect, it } from "vitest";
import { distinctValues, looksChoosable } from "./narrow.js";

/**
 * Rows shaped like the real thing that prompted this — a task whose kind is
 * carried on a nested `Category.Name` chosen by whoever set the account up.
 */
const tasks = [
  { Id: 1, TaskType: "Todo", Category: { Id: 1687, Name: "General Inquiry" }, Priority: "High" },
  { Id: 2, TaskType: "Todo", Category: { Id: 1688, Name: "Maintenance" }, Priority: "Low" },
  { Id: 3, TaskType: "Request", Category: { Id: 1688, Name: "Maintenance" }, Priority: "High" },
  { Id: 4, TaskType: "Request", Category: { Id: 1689, Name: "Plumbing" }, Priority: "High" },
  { Id: 5, TaskType: "Todo", Category: null, Priority: "Low" },
];

describe("distinctValues", () => {
  it("reads one level of nesting, which is where the answer usually is", () => {
    const result = distinctValues(tasks, "Category.Name");
    expect(result.values.map((v) => v.value)).toEqual([
      "Maintenance",
      "General Inquiry",
      "Plumbing",
    ]);
  });

  it("orders by how many records carry each, commonest first", () => {
    // What somebody means is far more often the value most of their records
    // have than the one that appeared once.
    const result = distinctValues(tasks, "Category.Name");
    expect(result.values[0]).toEqual({ value: "Maintenance", label: "Maintenance", count: 2 });
  });

  it("counts what it could not read rather than dropping it", () => {
    const result = distinctValues(tasks, "Category.Name");
    // One task has no category at all, and that is often the real answer to
    // "why is this record missing from my widget".
    expect(result.missing).toBe(1);
    expect(result.rowsScanned).toBe(5);
  });

  it("handles a plain top-level field", () => {
    const result = distinctValues(tasks, "TaskType");
    expect(result.values.map((v) => v.value)).toEqual(["Todo", "Request"]);
  });

  it("refuses a field holding objects — you cannot pick from those", () => {
    const result = distinctValues(tasks, "Category");
    expect(result.values).toEqual([]);
    expect(result.missing).toBe(5);
  });

  it("says when the list was cut short", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ kind: `k${index}` }));
    const capped = distinctValues(many, "kind", { max: 10 });
    // A list of ten that stopped at ten is not the same as one that stopped
    // because there are ten, and a filter built on the first excludes records.
    expect(capped.truncated).toBe(true);
    expect(capped.values).toHaveLength(10);
    expect(distinctValues(many, "kind").truncated).toBe(false);
  });

  it("reads rows out of a wrapped body", () => {
    const result = distinctValues({ data: tasks }, "TaskType", { rowsPath: "$.data" });
    expect(result.rowsScanned).toBe(5);
  });

  it("treats an empty string as absent, not as a value", () => {
    const rows = [{ status: "open" }, { status: "" }, { status: "open" }];
    const result = distinctValues(rows, "status");
    expect(result.values).toEqual([{ value: "open", label: "open", count: 2 }]);
    expect(result.missing).toBe(1);
  });

  it("keeps numbers as numbers, so a filter compares them correctly", () => {
    const rows = [{ code: 3 }, { code: 3 }, { code: 7 }];
    expect(distinctValues(rows, "code").values[0]).toEqual({ value: 3, label: "3", count: 2 });
  });
});

describe("looksChoosable", () => {
  it("accepts a field that repeats across records", () => {
    expect(looksChoosable(distinctValues(tasks, "Category.Name"))).toBe(true);
    expect(looksChoosable(distinctValues(tasks, "TaskType"))).toBe(true);
  });

  it("rejects an identifier, where every row has its own value", () => {
    // The obvious failure: offering to narrow by Id produces a list as long
    // as the data and helps nobody.
    expect(looksChoosable(distinctValues(tasks, "Id"))).toBe(false);
  });

  it("rejects an identifier on a realistically sized sample", () => {
    // Where the cap does the work: 400 ids run past it, and a list that had
    // to stop is a list nobody was going to choose from.
    const many = Array.from({ length: 400 }, (_, index) => ({ Id: index, kind: "task" }));
    expect(looksChoosable(distinctValues(many, "Id"))).toBe(false);
    expect(looksChoosable(distinctValues(many, "kind"))).toBe(false);
  });

  it("accepts a handful of categories across many records", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      Category: { Name: ["Maintenance", "Plumbing", "Turnover"][index % 3] },
    }));
    expect(looksChoosable(distinctValues(many, "Category.Name"))).toBe(true);
  });

  it("rejects a field with only one value — there is nothing to choose", () => {
    const rows = [{ kind: "a" }, { kind: "a" }, { kind: "a" }];
    expect(looksChoosable(distinctValues(rows, "kind"))).toBe(false);
  });

  it("rejects a field nothing carries", () => {
    expect(looksChoosable(distinctValues(tasks, "Nonexistent"))).toBe(false);
  });
});
