import type { ColumnMeta } from "@freebirdai/dash-spec";
import { COMPONENT_IDS, highlightSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { SERIES_DARK, SERIES_LIGHT, SERIES_SLOTS, STATUS_TONES, seriesVar, statusTone } from "./palette.js";
import { COMPONENTS } from "./registry.js";
import {
  dominantTone,
  highlightsFor,
  humanLabel,
  labelOf,
  makeFormatter,
  numericValues,
  recordEntries,
  roleColumn,
  roleColumns,
  titleFor,
} from "./resolve.js";
import { bandScale, barPath, linearScale, niceDomain, niceTicks, timeTicks } from "./scales.js";
import { OTHER_KEY, buildCategories, buildSeries } from "./series.js";

describe("scales", () => {
  it("maps a domain onto a range and back", () => {
    const scale = linearScale([0, 100], [0, 200]);
    expect(scale(50)).toBe(100);
    expect(scale.invert(100)).toBe(50);
  });

  it("centres a degenerate domain instead of dividing by zero", () => {
    expect(linearScale([5, 5], [0, 100])(5)).toBe(50);
  });

  it("produces clean tick numbers, not raw fractions of the span", () => {
    expect(niceTicks(0, 1037, 5)).toEqual([0, 200, 400, 600, 800, 1000]);
    // Steps come from the 1/2/5/10 family, so a 0–1 axis lands on fifths.
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it("does not accumulate float drift across a tick loop", () => {
    for (const tick of niceTicks(0, 3, 10)) {
      expect(String(tick)).not.toMatch(/00000[0-9]|99999[0-9]/);
    }
  });

  it("pulls a line domain to zero only when the data sits low in its range", () => {
    expect(niceDomain([100, 400, 250])).toEqual([0, 400]);
    // A narrow band high above zero keeps its own range — forcing zero here
    // would flatten the variation the chart exists to show.
    expect(niceDomain([940, 1000, 980])).toEqual([940, 1000]);
  });

  it("handles empty and single-value domains", () => {
    expect(niceDomain([])).toEqual([0, 1]);
    expect(niceDomain([0])).toEqual([0, 1]);
    expect(niceDomain([50], { includeZero: false })).toEqual([45, 55]);
  });

  it("places time ticks on clean boundaries", () => {
    const start = Date.UTC(2026, 7, 1);
    const ticks = timeTicks(start, start + 7 * 86_400_000, 4);
    for (const tick of ticks) expect(tick % 86_400_000).toBe(0);
  });

  it("caps mark thickness so a band always keeps some air", () => {
    const wide = bandScale(2, [0, 1000]);
    expect(wide.bandWidth).toBeLessThanOrEqual(24);
    const tight = bandScale(50, [0, 200]);
    expect(tight.bandWidth).toBeLessThan(tight.step);
  });

  it("rounds the data end of a bar and squares the baseline", () => {
    const column = barPath(0, 10, 20, 40, 4, "top");
    // Two arcs at the top, none at the baseline.
    expect(column.match(/A/g)).toHaveLength(2);
    expect(column.endsWith("Z")).toBe(true);
    expect(barPath(0, 0, 20, 40, 0, "top")).not.toMatch(/A/);
  });
});

describe("palette", () => {
  it("ships eight slots in both modes", () => {
    expect(SERIES_LIGHT).toHaveLength(SERIES_SLOTS);
    expect(SERIES_DARK).toHaveLength(SERIES_SLOTS);
  });

  it("addresses colours by CSS variable so the mode swaps in one place", () => {
    expect(seriesVar(0)).toBe("var(--dash-series-1)");
    expect(seriesVar(7)).toBe("var(--dash-series-8)");
    expect(seriesVar(8)).toBe("var(--dash-series-1)");
  });

  it.each([
    ["succeeded", "good"],
    ["active", "good"],
    ["pending", "warning"],
    ["in_progress", "warning"],
    ["overdue", "serious"],
    ["failed", "critical"],
    ["cancelled", "critical"],
  ])("maps %s to the %s tone", (value, tone) => {
    expect(statusTone(value)).toBe(tone);
  });

  it("leaves an unrecognised status neutral rather than guessing a colour", () => {
    expect(statusTone("bloop")).toBe("neutral");
    expect(statusTone(null)).toBe("neutral");
  });

  it("reads a boolean as pass/fail", () => {
    expect(statusTone(true)).toBe("good");
    expect(statusTone(false)).toBe("critical");
  });
});

describe("buildSeries", () => {
  const rows = [
    { t: 3, v: 30, k: "b" },
    { t: 1, v: 10, k: "a" },
    { t: 2, v: 20, k: "a" },
  ];

  it("returns one sorted series when nothing splits it", () => {
    const [series] = buildSeries({ rows, x: "t", y: "v" });
    expect(series?.points.map((point) => point.x)).toEqual([1, 2, 3]);
    expect(series?.slot).toBe(0);
  });

  it("splits on the series column and sorts each line", () => {
    const built = buildSeries({ rows, x: "t", y: "v", series: "k" });
    expect(built.map((series) => series.key)).toEqual(["a", "b"]);
    expect(built[0]?.points).toEqual([
      { x: 1, y: 10 },
      { x: 2, y: 20 },
    ]);
  });

  it("keeps nulls so a gap survives into the chart", () => {
    const [series] = buildSeries({ rows: [{ t: 1, v: 1 }, { t: 2, v: null }], x: "t", y: "v" });
    expect(series?.points).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: null },
    ]);
  });

  it("drops rows with no x rather than plotting them at zero", () => {
    const [series] = buildSeries({ rows: [{ t: null, v: 1 }, { t: 2, v: 2 }], x: "t", y: "v" });
    expect(series?.points).toEqual([{ x: 2, y: 2 }]);
  });

  it("never invents a ninth hue — the tail folds into Other", () => {
    const wide = Array.from({ length: 12 }, (_, i) => ({ t: 1, v: 12 - i, k: `s${i}` }));
    const built = buildSeries({ rows: wide, x: "t", y: "v", series: "k" });

    expect(built).toHaveLength(SERIES_SLOTS + 1);
    const other = built[built.length - 1]!;
    expect(other.key).toBe(OTHER_KEY);
    expect(other.isOther).toBe(true);
    expect(other.label).toBe("Other (4)");
    // The folded bucket carries the sum of what it replaced: 4+3+2+1.
    expect(other.points).toEqual([{ x: 1, y: 10 }]);
    for (const series of built.slice(0, SERIES_SLOTS)) expect(series.slot).toBeLessThan(SERIES_SLOTS);
  });

  it("keeps a series on its own hue when a filter removes its neighbours", () => {
    const order = ["alpha", "beta", "gamma"];
    const all = [
      { t: 1, v: 1, k: "alpha" },
      { t: 1, v: 2, k: "beta" },
      { t: 1, v: 3, k: "gamma" },
    ];
    const before = buildSeries({ rows: all, x: "t", y: "v", series: "k", seriesOrder: order });
    const gammaBefore = before.find((series) => series.key === "gamma")?.slot;

    // Drop the middle series, exactly as an interactive filter would.
    const after = buildSeries({
      rows: all.filter((row) => row.k !== "beta"),
      x: "t",
      y: "v",
      series: "k",
      seriesOrder: order,
    });
    const gammaAfter = after.find((series) => series.key === "gamma")?.slot;

    expect(gammaBefore).toBe(2); // third in the stable order → slot 2
    expect(gammaAfter).toBe(gammaBefore);
  });
});

describe("buildCategories", () => {
  const rows = [
    { region: "emea", amount: 10, plan: "pro" },
    { region: "emea", amount: 5, plan: "free" },
    { region: "amer", amount: 30, plan: "pro" },
  ];

  it("rolls up and orders by size", () => {
    const { data } = buildCategories({ rows, category: "region", value: "amount" });
    expect(data.map((datum) => [datum.label, datum.value])).toEqual([
      ["amer", 30],
      ["emea", 15],
    ]);
  });

  it("stacks by the series column and drops empty segments", () => {
    const { data, keys } = buildCategories({
      rows,
      category: "region",
      value: "amount",
      series: "plan",
    });
    expect(keys.map((key) => key.key)).toEqual(["free", "pro"]);
    expect(data.find((datum) => datum.label === "amer")?.segments).toEqual([
      { key: "pro", label: "pro", slot: 1, value: 30, isOther: false },
    ]);
  });

  it("respects the category limit", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ c: `c${i}`, v: i }));
    const { data } = buildCategories({ rows: many, category: "c", value: "v", limit: 40 });
    expect(data).toHaveLength(40);
  });
});

describe("role and format resolution", () => {
  const columns: ColumnMeta[] = [
    { name: "revenue", valueType: "numeric", semantic: "currency" },
    { name: "created", valueType: "temporal", semantic: "timestamp" },
  ];

  it("reads single and multi role bindings", () => {
    expect(roleColumn({ value: "revenue" }, "value")).toBe("revenue");
    expect(roleColumn({ columns: ["a", "b"] }, "columns")).toBe("a");
    expect(roleColumn({}, "value")).toBeUndefined();
    expect(roleColumns({ columns: ["a", "b"] }, "columns")).toEqual(["a", "b"]);
    expect(roleColumns({ value: "revenue" }, "value")).toEqual(["revenue"]);
  });

  it("falls back to the column's own semantic when the spec sets no format", () => {
    const format = makeFormatter({ format: {}, columns, now: 0 }, "revenue");
    expect(format(42)).toBe("$42.00");
  });

  it("lets an explicit format win over the column semantic", () => {
    const format = makeFormatter(
      { format: { revenue: { semantic: "count" } }, columns, now: 0 },
      "revenue",
    );
    expect(format(42)).toBe("42");
  });

  it("collects only finite numbers for a sparkline", () => {
    expect(
      numericValues([{ v: 1 }, { v: null }, { v: "2" }, { v: Number.NaN }, { v: 3 }], "v"),
    ).toEqual([1, 3]);
  });

  it("turns a field name into something a person would read", () => {
    expect(humanLabel("unitNumber")).toBe("Unit number");
    expect(humanLabel("Address.City")).toBe("Address · City");
    expect(humanLabel("postal_code")).toBe("Postal code");
    expect(humanLabel("Id")).toBe("Id");
  });

  /*
   * Past two levels the middle is a container and the ends carry the meaning.
   * Printing every one gives "Property · Address · City", which is the
   * database-browser look this function exists to avoid — and the root is what
   * tells two otherwise identical leaves apart.
   */
  it("speaks a deep name as its root and its leaf", () => {
    expect(humanLabel("Property.Address.City")).toBe("Property city");
    expect(humanLabel("Unit.Address.City")).toBe("Unit city");
    expect(humanLabel("Property.Address.PostalCode")).toBe("Property postal code");
    // Whose it is survives, which is the one thing the middle was carrying.
    expect(humanLabel("Property.Address.City")).not.toBe(humanLabel("Unit.Address.City"));
  });

  describe("labelOf", () => {
    const columns: ColumnMeta[] = [
      { name: "CurrentNumberOfOccupants", valueType: "numeric", label: "Occupants" },
      { name: "unitNumber", valueType: "text" },
      { name: "blank", valueType: "text", label: "   " },
    ];

    it("prefers the label the API's lexicon supplied", () => {
      expect(labelOf(columns, "CurrentNumberOfOccupants")).toBe("Occupants");
    });

    it("falls back to the mechanical label with no lexicon entry", () => {
      expect(labelOf(columns, "unitNumber")).toBe("Unit number");
      // A blank label is a missing one; it must not render an empty header.
      expect(labelOf(columns, "blank")).toBe("Blank");
    });

    it("falls back again for a name that produced no column at all", () => {
      expect(labelOf(columns, "someOtherField")).toBe("Some other field");
    });
  });

  describe("recordEntries", () => {
    const columns: ColumnMeta[] = [
      { name: "Id", valueType: "numeric" },
      { name: "Address", valueType: "unknown" },
      { name: "Address.City", valueType: "categorical" },
      { name: "Address.State", valueType: "categorical" },
    ];
    const row = {
      Id: 274_701,
      Address: { City: "Fresno", State: "CA" },
      "Address.City": "Fresno",
      "Address.State": "CA",
    };
    const props = { rows: [row], columns, format: {}, now: 0 };

    it("drops the object parent when its own children are shown", () => {
      /*
       * `inferShape` emits `Address` and `Address.City` together. Showing both
       * means showing the same data twice, once as an unreadable blob — which
       * is exactly what a real drill-down did before this existed.
       */
      const names = columns.map((column) => column.name);
      expect(recordEntries(props, names).map((entry) => entry.name)).toEqual([
        "Id",
        "Address.City",
        "Address.State",
      ]);
    });

    it("keeps the object when nothing expanded it", () => {
      const entries = recordEntries(props, ["Id", "Address"]);
      expect(entries.map((entry) => entry.name)).toEqual(["Id", "Address"]);
      // Summarised, not dumped as JSON.
      expect(entries[1]?.formatted).toBe("{City, State}");
    });

    it("reads a nested value from an unflattened row", () => {
      const nested = { rows: [{ Address: { City: "Fresno" } }], columns, format: {}, now: 0 };
      expect(recordEntries(nested, ["Address.City"])[0]?.value).toBe("Fresno");
    });

    it("shows one record, not the first of many", () => {
      const many = { ...props, rows: [row, { ...row, Id: 2 }] };
      expect(recordEntries(many, ["Id"])).toHaveLength(1);
    });

    it("has nothing to show when there is no record", () => {
      expect(recordEntries({ ...props, rows: [] }, ["Id"])).toEqual([]);
    });
  });

  /*
   * The tooltip is the complement of the cell: the cell summarises, the
   * tooltip still has everything. `String(object)` gives "[object Object]",
   * which is the least useful string available.
   */
  it("puts the whole value in the tooltip, including containers", () => {
    expect(titleFor({ City: "Fresno" })).toContain("Fresno");
    expect(titleFor([1, 2])).toContain("2");
    expect(titleFor("plain")).toBe("plain");
    expect(titleFor(42)).toBe("42");
    // An absent value gets an empty tooltip, not the word "null".
    expect(titleFor(null)).toBe("");
    expect(titleFor(undefined)).toBe("");
  });

  it("survives a value that cannot be stringified", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    // One ragged row must not take the widget down.
    expect(() => titleFor(cyclic)).not.toThrow();
  });
});

describe("registry", () => {
  it("ships a renderer for every component the spec declares", () => {
    expect(Object.keys(COMPONENTS).sort()).toEqual([...COMPONENT_IDS].sort());
    for (const [id, entry] of Object.entries(COMPONENTS)) {
      expect(entry.contract.id, id).toBe(id);
      expect(typeof entry.render, id).toBe("function");
    }
  });
});

describe("highlight rendering", () => {
  const hit = (id: string, tone: string) => ({ id, tone, label: id }) as never;

  it("keeps the tone list identical to the schema's", () => {
    /*
     * The schema cannot import the components package — spec is React-free by
     * design — so the two enums are written twice. This is the pin that stops
     * them drifting: adding a tone in one place fails here until it is added
     * in the other.
     */
    expect(Object.keys(STATUS_TONES).sort()).toEqual(
      [...highlightSchema.innerType().shape.tone.options].sort(),
    );
  });

  it("shows the most severe mark when several land on one row", () => {
    expect(dominantTone([hit("a", "good"), hit("b", "critical"), hit("c", "warning")])).toBe(
      "critical",
    );
    expect(dominantTone([hit("a", "good"), hit("b", "neutral")])).toBe("good");
    expect(dominantTone([])).toBeUndefined();
  });

  it("reads highlights by row index, and copes with a widget that has none", () => {
    const props = { highlights: [[hit("a", "good")], []] };
    expect(highlightsFor(props, 0)).toHaveLength(1);
    expect(highlightsFor(props, 1)).toEqual([]);
    // Out of range and absent both give nothing rather than throwing.
    expect(highlightsFor(props, 9)).toEqual([]);
    expect(highlightsFor({}, 0)).toEqual([]);
  });
});
