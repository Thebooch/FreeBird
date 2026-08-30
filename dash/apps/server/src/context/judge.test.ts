import { describe, expect, it } from "vitest";
import { fitRows } from "./judge.js";

/**
 * The rule this file exists to hold: a dropped row turns "no match" into a
 * confident lie, so detail is sacrificed before breadth, and whatever is
 * sacrificed is reported.
 *
 * And which detail goes: **the biggest**, never "whatever the tile does not
 * draw". Twice the second rule produced a confident wrong answer. Asked
 * whether any task mentioned a dishwasher, the reply said it had read all
 * fifty and found none — the row was there, and the field holding it was not
 * one the tile drew. Asked for a property's identifier, the reply said it was
 * "omitted from the displayed data", while the same row sat whole in memory
 * and the widget's own drill-down was `{{row.Id}}`.
 *
 * So the model always gets the fullest record that fits. Being unable to
 * answer is a bigger failure than quoting a field nobody can see.
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

/** What the tile happens to draw. Deliberately NOT what fitRows keeps. */
const DISPLAYED = ["Title", "TaskType", "TaskStatus", "Priority", "DueDate", "CreatedDateTime"];

const rows = Array.from({ length: 50 }, (_, i) =>
  task(i, i === 38 ? "Dishwasher" : "Rent Increase Evaluation"),
);

const hasNeedle = (json: string) => json.includes("Dishwasher");

describe("fitRows", () => {
  it("keeps whole rows and every field when the budget allows", () => {
    const fitted = fitRows(rows, 500_000);
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
    const fitted = fitRows(rows, 12_000);
    expect(fitted.shown).toHaveLength(50);
    expect(fitted.droppedRows).toBe(0);
    expect(hasNeedle(fitted.json)).toBe(true);
    expect(fitted.droppedFields).toContain("Category");
  });

  it("says which fields it gave up", () => {
    const fitted = fitRows(rows, 12_000);
    expect(fitted.droppedFields.length).toBeGreaterThan(0);
    for (const field of fitted.droppedFields) {
      expect(Object.keys(fitted.shown[0]!)).not.toContain(field);
    }
  });

  /*
   * The identifier is what every follow-up lookup needs, and the old rule
   * dropped it whenever a tile did not draw it — which is most tiles, and is
   * how "its ID is omitted from the displayed data" came to be said about a
   * row that had one.
   *
   * Sorting by size keeps it at any budget that fits more than a field or two,
   * which is every budget this is called with (20,000 and 24,000). It is worth
   * being exact about the limit though: size is a proxy for importance, not a
   * guarantee. Squeezed to one field per row, this keeps `UnitId` over `Id`
   * purely because the unit number is a shorter number — so at that extreme
   * the identifier is not protected, and making it so would mean carrying the
   * identity field down to here rather than inferring it from a name.
   */
  it("keeps the identifier at every budget, when told which field it is", () => {
    for (const budget of [800, 2_000, 12_000, 20_000, 24_000]) {
      const fitted = fitRows(rows, budget, ["Id"]);
      expect(Object.keys(fitted.shown[0]!), `budget ${budget}`).toContain("Id");
    }
  });

  /*
   * And why it has to be told. Sorting by size nearly protects the identity
   * for free — but only nearly, and the gap is exactly where it hurts: pushed
   * hard enough this keeps `UnitId` over `Id` purely because the unit number
   * is a shorter number, dropping the one field every follow-up lookup needs.
   */
  it("would otherwise lose the identity to a shorter number", () => {
    expect(Object.keys(fitRows(rows, 2_000).shown[0]!)).not.toContain("Id");
    expect(Object.keys(fitRows(rows, 2_000, ["Id"]).shown[0]!)).toContain("Id");
  });

  it("ignores a protected field the rows do not have", () => {
    const fitted = fitRows(rows, 12_000, ["NotAField"]);
    expect(fitted.shown).toHaveLength(50);
    expect(() => JSON.parse(fitted.json)).not.toThrow();
  });

  it("prefers a narrow field the question is about over a wide one nobody asked for", () => {
    const fitted = fitRows(rows, 12_000);
    const kept = Object.keys(fitted.shown[0]!);
    expect(kept).toContain("Title");
    expect(kept).not.toContain("Category");
  });

  /*
   * The rule that was reversed, asserted directly: what the tile draws has no
   * bearing on what survives. `Id` is on no tile and survives; `Description`
   * and `Category` are large and go, displayed or not.
   */
  it("ignores what the tile displays entirely", () => {
    const fitted = fitRows(rows, 6_000);
    const kept = new Set(Object.keys(fitted.shown[0]!));
    expect(kept.has("Id")).toBe(true);
    expect(DISPLAYED.some((field) => !kept.has(field))).toBe(true);
  });

  it("emits valid JSON whatever it had to give up", () => {
    for (const budget of [200, 2_000, 12_000, 500_000]) {
      const fitted = fitRows(rows, budget);
      expect(() => JSON.parse(fitted.json)).not.toThrow();
      expect(JSON.parse(fitted.json)).toHaveLength(fitted.shown.length);
    }
  });

  it("stays inside the budget", () => {
    for (const budget of [200, 2_000, 12_000]) {
      expect(fitRows(rows, budget).json.length).toBeLessThanOrEqual(budget);
    }
  });

  /*
   * Rows are the last thing to go, and when they do the count is reported so
   * the prompt can forbid a definitive "not present".
   */
  it("counts the rows it could not fit even narrowed", () => {
    const fitted = fitRows(rows, 600);
    expect(fitted.droppedRows).toBeGreaterThan(0);
    expect(fitted.shown.length + fitted.droppedRows).toBe(50);
  });

  it("never cuts a row in half", () => {
    const fitted = fitRows(rows, 600);
    const parsed = JSON.parse(fitted.json) as Record<string, unknown>[];
    const shape = Object.keys(parsed[0] ?? {});
    for (const row of parsed) expect(Object.keys(row)).toEqual(shape);
  });

  it("drops rows only when even one field per row will not fit", () => {
    const fitted = fitRows(rows, 400);
    expect(fitted.droppedRows).toBeGreaterThan(0);
    expect(() => JSON.parse(fitted.json)).not.toThrow();
  });

  it("emits an empty array rather than half a row when nothing fits", () => {
    const fitted = fitRows(rows, 5);
    expect(fitted.shown).toEqual([]);
    expect(JSON.parse(fitted.json)).toEqual([]);
    expect(fitted.droppedRows).toBe(50);
  });
});
