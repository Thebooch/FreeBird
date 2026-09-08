import { describe, expect, it } from "vitest";
import type { ColumnMeta } from "./contracts.js";
import {
  FACET_EMPTY_KEY,
  FACET_MAX_VALUES,
  facetKey,
  facetSchema,
  facetTone,
  facetsSchema,
  validateFacets,
  type FacetSpec,
} from "./facet.js";

const facet = (input: Record<string, unknown>): FacetSpec =>
  facetSchema.parse({ field: "Status", ...input });

const column = (input: Partial<ColumnMeta> & { name: string }): ColumnMeta => ({
  valueType: "categorical",
  ...input,
});

describe("facetKey", () => {
  it("gives both sides of a comparison the same bucket", () => {
    // The whole safety argument: a declared 1688 and a row's "1688" are one
    // tile, because neither is ever compared to the other directly.
    expect(facetKey(1688)).toBe(facetKey("1688"));
    expect(facetKey(true)).toBe("true");
  });

  it("puts every kind of absence in one bucket", () => {
    // Null, undefined and empty string are all "no value" to a reader, and
    // three tiles saying that would be three ways to read the same thing.
    for (const value of [null, undefined, ""]) {
      expect(facetKey(value)).toBe(FACET_EMPTY_KEY);
    }
  });

  it("does not fold zero or false into the empty bucket", () => {
    // The trap in writing this as a falsy check: 0 and false are values a
    // reader wants to filter to, not absences.
    expect(facetKey(0)).toBe("0");
    expect(facetKey(false)).toBe("false");
  });
});

describe("facetSchema", () => {
  it("defaults to multi-select and shows the remainder", () => {
    const parsed = facet({});
    expect(parsed.mode).toBe("multi");
    expect(parsed.other).toBe("show");
    expect(parsed.default).toEqual([]);
  });

  it("refuses two defaults on a single-select facet", () => {
    expect(() =>
      facet({ mode: "single", values: [{ value: "Open" }, { value: "Shut" }], default: ["Open", "Shut"] }),
    ).toThrow();
  });

  it("refuses two values that would draw one tile", () => {
    // 1688 and "1688" are distinct here and identical on screen, so the
    // second tile could never be clicked.
    expect(() => facet({ values: [{ value: 1688 }, { value: "1688" }] })).toThrow();
  });

  it("refuses a default no tile could show", () => {
    // Otherwise the widget opens filtered to nothing with no lit tile saying
    // why — the least debuggable empty state there is.
    expect(() => facet({ values: [{ value: "Open" }], default: ["Closed"] })).toThrow();
  });

  it("allows a default when the values are derived", () => {
    // Nothing here knows the tiles yet; the model drops it at read time if
    // the data turns out not to have it.
    expect(facet({ default: ["Open"] }).default).toEqual(["Open"]);
  });

  it("refuses more values than a strip can show", () => {
    const many = Array.from({ length: FACET_MAX_VALUES + 1 }, (_, index) => ({ value: `v${index}` }));
    expect(() => facet({ values: many })).toThrow();
  });
});

describe("facetsSchema", () => {
  it("refuses two facets over one field", () => {
    // Each strip would filter the rows the other counted, so the two would
    // disagree about the same field on the same screen.
    expect(() => facetsSchema.parse([{ field: "Status" }, { field: "Status" }])).toThrow();
  });

  it("allows facets over different fields", () => {
    expect(facetsSchema.parse([{ field: "Status" }, { field: "Priority" }])).toHaveLength(2);
  });
});

describe("facetTone", () => {
  it("prefers what the author said over what the value suggests", () => {
    expect(facetTone({ value: "Open", tone: "critical" }, "Open")).toBe("critical");
  });

  it("falls back to the shared status vocabulary", () => {
    expect(facetTone(undefined, "Overdue")).toBe("serious");
    expect(facetTone(undefined, "Whatever")).toBe("neutral");
  });
});

describe("validateFacets", () => {
  it("passes a categorical column with room to spare", () => {
    expect(
      validateFacets([facet({})], [column({ name: "Status", distinctCount: 4 })]),
    ).toEqual([]);
  });

  it("reports a field the pipeline does not produce", () => {
    const issues = validateFacets([facet({})], [column({ name: "Other" })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.role).toBe("facet:Status");
    expect(issues[0]?.message).toContain("does not produce it");
  });

  it("reports a numeric or temporal field rather than tiling it", () => {
    for (const valueType of ["numeric", "temporal"] as const) {
      const issues = validateFacets(
        [facet({ field: "Amount" })],
        [column({ name: "Amount", valueType })],
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain("tiles badly");
    }
  });

  it("reports a derived strip with too many values", () => {
    const issues = validateFacets(
      [facet({})],
      [column({ name: "Status", distinctCount: FACET_MAX_VALUES + 1 })],
    );
    expect(issues[0]?.message).toContain("distinct values");
  });

  it("does not cap a strip whose values were declared", () => {
    // The author naming four values is an answer that holds however many
    // exist in the data — the cap only guards the guess.
    expect(
      validateFacets(
        [facet({ values: [{ value: "Open" }, { value: "Shut" }] })],
        [column({ name: "Status", distinctCount: 400 })],
      ),
    ).toEqual([]);
  });
});
