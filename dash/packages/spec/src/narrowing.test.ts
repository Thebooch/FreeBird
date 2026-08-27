import { describe, expect, it } from "vitest";
import { findNarrowing, narrowingSchema, type Narrowing } from "./narrowing.js";

const at = (iso: string) => new Date(iso).toISOString();

const saved = (input: Partial<Narrowing> & { phrase: string }): Narrowing =>
  narrowingSchema.parse({
    op: "list_tasks",
    field: "Category.Name",
    values: ["Maintenance"],
    confirmedAt: at("2026-08-01T00:00:00Z"),
    ...input,
  });

describe("narrowingSchema", () => {
  it("keeps numbers as numbers", () => {
    // `"1688" === 1688` is false, and a widget filtered on the string form
    // shows nothing while looking like an empty category.
    const parsed = saved({ phrase: "maintenance", values: [1688, "Maintenance"] });
    expect(parsed.values).toEqual([1688, "Maintenance"]);
  });

  it("refuses a narrowing that matches nothing", () => {
    // An empty value list is a filter that hides every record.
    expect(() => saved({ phrase: "maintenance", values: [] })).toThrow();
  });
});

describe("findNarrowing", () => {
  const maintenance = saved({ phrase: "maintenance tasks" });

  it("finds it again however the wording moved", () => {
    // The tedium being avoided: nobody types the same phrase twice, and
    // asking again because the words shifted defeats the point of saving.
    for (const phrase of [
      "maintenance tasks",
      "only the maintenance tasks",
      "Maintenance Tasks!",
      "show me tasks for maintenance",
    ]) {
      expect(findNarrowing([maintenance], { op: "list_tasks", phrase })).toBe(maintenance);
    }
  });

  it("answers a broader request from a narrower saved phrase", () => {
    // "maintenance" saved earlier covers "maintenance tasks this month" — the
    // extra words narrow further, they do not change what maintenance means.
    const plain = saved({ phrase: "maintenance" });
    expect(
      findNarrowing([plain], { op: "list_tasks", phrase: "maintenance tasks this month" }),
    ).toBe(plain);
  });

  it("does not answer a broad request from a more specific saved one", () => {
    /*
     * The reverse must not hold. Somebody who once said "urgent maintenance"
     * has not told us what plain "maintenance" means, and reusing it would
     * silently drop every non-urgent record.
     */
    const urgent = saved({ phrase: "urgent maintenance" });
    expect(findNarrowing([urgent], { op: "list_tasks", phrase: "maintenance" })).toBeNull();
  });

  it("never crosses endpoints", () => {
    // The same word means different things on different records.
    expect(findNarrowing([maintenance], { op: "list_work_orders", phrase: "maintenance tasks" }))
      .toBeNull();
  });

  it("prefers the most recently confirmed when several could answer", () => {
    const older = saved({ phrase: "maintenance", confirmedAt: at("2026-07-01T00:00:00Z") });
    const newer = saved({
      phrase: "maintenance",
      values: ["Maintenance", "Plumbing"],
      confirmedAt: at("2026-08-15T00:00:00Z"),
    });
    expect(findNarrowing([older, newer], { op: "list_tasks", phrase: "maintenance work" })).toBe(
      newer,
    );
  });

  it("ignores a phrase with nothing meaningful in it", () => {
    // "show me all of them" says nothing about which records are wanted.
    expect(findNarrowing([maintenance], { op: "list_tasks", phrase: "show me all of them" }))
      .toBeNull();
  });
});
