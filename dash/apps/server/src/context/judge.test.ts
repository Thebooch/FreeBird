import { describe, expect, it } from "vitest";
import { fitRows } from "./judge.js";

/**
 * The rule this file exists to hold: a dropped row turns "no match" into a
 * confident lie, so detail is sacrificed before breadth, and whatever is
 * sacrificed is reported.
 *
 * The failure it was written from: asked whether any task mentioned a
 * dishwasher, the assistant said it had read all fifty and found none. One was
 * titled "Dishwasher", at index 38, past a 12,000-character cut through a
 * 35,654-character set.
 */

/** Shaped like a real Buildium task: six useful fields, a lot of freight. */
const task = (i: number, title: string) => ({
  Id: 5259251 + i,
  TaskType: "Todo",
  Category: {
    Id: 28053,
    Name: "Inspections",
    Href: "https://api.buildium.com/v1/tasks/categories/28053",
    SubCategory: null,
  },
  Title: title,
  Description: "Re Key\nFinal Inspection, and a good deal of further detail besides.",
  Property: { Id: 213910, Type: "Rental", Href: "https://api.buildium.com/v1/rentals/213910" },
  UnitId: 1234 + i,
  TaskStatus: "New",
  Priority: "High",
  DueDate: "2026-08-06",
  CreatedDateTime: "2026-08-01T07:18:00Z",
});

const DISPLAYED = ["Title", "TaskType", "TaskStatus", "Priority", "DueDate", "CreatedDateTime"];

const rows = Array.from({ length: 50 }, (_, i) =>
  task(i, i === 38 ? "Dishwasher" : "Rent Increase Evaluation"),
);

const hasNeedle = (json: string) => json.includes("Dishwasher");

describe("fitRows", () => {
  it("keeps whole rows and every field when the budget allows", () => {
    const fitted = fitRows(rows, 500_000, DISPLAYED);
    expect(fitted.shown).toHaveLength(50);
    expect(fitted.droppedFields).toEqual([]);
    expect(fitted.droppedRows).toBe(0);
    expect(Object.keys(fitted.shown[0]!)).toContain("Category");
  });

  /*
   * The regression. A budget that cannot hold fifty fat rows must still hold
   * fifty thin ones, because the row at index 38 is the whole answer.
   */
  it("drops width, not rows, and so keeps a record 38 deep", () => {
    const fitted = fitRows(rows, 12_000, DISPLAYED);
    expect(fitted.shown).toHaveLength(50);
    expect(fitted.droppedRows).toBe(0);
    expect(hasNeedle(fitted.json)).toBe(true);
    expect(fitted.droppedFields).toContain("Category");
    expect(fitted.droppedFields).toContain("Description");
  });

  it("says which fields it gave up", () => {
    const fitted = fitRows(rows, 12_000, DISPLAYED);
    expect(fitted.droppedFields.length).toBeGreaterThan(0);
    for (const field of DISPLAYED) expect(fitted.droppedFields).not.toContain(field);
  });

  it("emits valid JSON whatever it had to give up", () => {
    for (const budget of [200, 2_000, 12_000, 500_000]) {
      const fitted = fitRows(rows, budget, DISPLAYED);
      expect(() => JSON.parse(fitted.json)).not.toThrow();
      expect(JSON.parse(fitted.json)).toHaveLength(fitted.shown.length);
    }
  });

  it("stays inside the budget", () => {
    for (const budget of [200, 2_000, 12_000]) {
      expect(fitRows(rows, budget, DISPLAYED).json.length).toBeLessThanOrEqual(budget);
    }
  });

  /*
   * Rows are the last thing to go, and when they do the count is reported so
   * the prompt can forbid a definitive "not present".
   */
  it("counts the rows it could not fit even narrowed", () => {
    const fitted = fitRows(rows, 600, DISPLAYED);
    expect(fitted.droppedRows).toBeGreaterThan(0);
    expect(fitted.shown.length + fitted.droppedRows).toBe(50);
  });

  it("never cuts a row in half", () => {
    const fitted = fitRows(rows, 600, DISPLAYED);
    for (const row of JSON.parse(fitted.json) as Record<string, unknown>[]) {
      expect(Object.keys(row)).toEqual(DISPLAYED);
    }
  });

  /*
   * The regression this caught: only a widget knows which columns are on
   * screen, so an endpoint read directly has no preference — and with none,
   * the first version dropped rows and reported "no dishwasher among them"
   * from 20 of 50 records.
   */
  it("still keeps every row when nothing says what to keep", () => {
    const fitted = fitRows(rows, 12_000);
    expect(fitted.shown).toHaveLength(50);
    expect(fitted.droppedRows).toBe(0);
    expect(hasNeedle(fitted.json)).toBe(true);
  });

  it("drops the widest field first when it has to guess", () => {
    const fitted = fitRows(rows, 12_000);
    // Description and Category are far bigger than Title, so they go first
    // and the field the question is about survives.
    expect(fitted.droppedFields).toContain("Description");
    expect(Object.keys(fitted.shown[0]!)).toContain("Title");
  });

  it("drops rows only when even one field per row will not fit", () => {
    const fitted = fitRows(rows, 400);
    expect(fitted.droppedRows).toBeGreaterThan(0);
    expect(() => JSON.parse(fitted.json)).not.toThrow();
  });

  it("emits an empty array rather than half a row when nothing fits", () => {
    const fitted = fitRows(rows, 5, DISPLAYED);
    expect(fitted.shown).toEqual([]);
    expect(JSON.parse(fitted.json)).toEqual([]);
    expect(fitted.droppedRows).toBe(50);
  });
});
