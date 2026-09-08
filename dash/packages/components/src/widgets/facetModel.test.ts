import type { ColumnMeta, FacetSpec } from "@freebirdai/dash-spec";
import { facetSchema } from "@freebirdai/dash-spec";
import type { Row, RowHighlight } from "@freebirdai/dash-runtime";
import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  FACET_OTHER_KEY,
  applyFacets,
  buildFacets,
  clearFacet,
  defaultSelection,
  describeFacets,
  renderableFacets,
  toggleFacet,
  type FacetSelection,
} from "./facetModel.js";

const facet = (input: Record<string, unknown>): FacetSpec =>
  facetSchema.parse({ field: "Status", ...input });

const columns: readonly ColumnMeta[] = [
  { name: "Status", valueType: "categorical" },
  { name: "Owner", valueType: "categorical" },
  { name: "Amount", valueType: "numeric" },
];

const rows: readonly Row[] = [
  { Status: "Open", Owner: "Ada", Amount: 1 },
  { Status: "Open", Owner: "Bob", Amount: 2 },
  { Status: "Closed", Owner: "Ada", Amount: 3 },
  { Status: "Overdue", Owner: "Ada", Amount: 4 },
];

const counts = (
  facets: readonly FacetSpec[],
  selection: FacetSelection,
  field: string,
): Record<string, number> => {
  const view = buildFacets({ facets, rows, columns, selection }).find(
    (candidate) => candidate.field === field,
  );
  return Object.fromEntries((view?.tiles ?? []).map((tile) => [tile.label, tile.count]));
};

describe("buildFacets counts", () => {
  const both = [facet({}), facet({ field: "Owner" })];

  it("ignores a facet's own selection when counting it", () => {
    /*
     * The rule the whole feature rests on. Counting the rows the widget is
     * about to show would make Closed and Overdue read 0 the moment Open is
     * picked, and the strip would stop being able to tell anyone what else is
     * there — which is the only reason to draw counts at all.
     */
    expect(counts(both, { Status: ["Open"] }, "Status")).toEqual({
      Open: 2,
      Closed: 1,
      Overdue: 1,
    });
  });

  it("honours every other facet's selection when counting", () => {
    // Owner is counted over the Open rows only, because Status is a different
    // strip and its filter really has been applied to what is on screen.
    expect(counts(both, { Status: ["Open"] }, "Owner")).toEqual({ Ada: 1, Bob: 1 });
  });

  it("counts everything when nothing is picked", () => {
    expect(counts(both, EMPTY_SELECTION, "Owner")).toEqual({ Ada: 3, Bob: 1 });
  });
});

describe("buildFacets tiles", () => {
  it("keeps derived tiles in first-seen order whatever is selected", () => {
    /*
     * A strip whose tiles reorder or vanish as they are used is unusable: the
     * tile that would undo the filter is the one that disappears. Order and
     * membership come from the unfiltered rows for exactly that reason.
     */
    const order = (selection: FacetSelection): string[] =>
      buildFacets({ facets: [facet({})], rows, columns, selection })[0]!.tiles.map(
        (tile) => tile.label,
      );

    expect(order(EMPTY_SELECTION)).toEqual(["Open", "Closed", "Overdue"]);
    expect(order({ Status: ["Overdue"] })).toEqual(["Open", "Closed", "Overdue"]);
  });

  it("keeps declared tiles in declaration order, including one at zero", () => {
    // "Rejected 0" is a fact worth being able to see, and only a declared
    // strip can show it — nothing in the rows says the category exists.
    const view = buildFacets({
      facets: [
        facet({
          values: [{ value: "Open" }, { value: "Rejected" }, { value: "Closed" }],
          other: "hide",
        }),
      ],
      rows,
      columns,
      selection: EMPTY_SELECTION,
    })[0]!;

    expect(view.tiles.map((tile) => [tile.label, tile.count])).toEqual([
      ["Open", 2],
      ["Rejected", 0],
      ["Closed", 1],
    ]);
  });

  it("adds an Other tile only when something falls outside", () => {
    const withRemainder = buildFacets({
      facets: [facet({ values: [{ value: "Open" }] })],
      rows,
      columns,
      selection: EMPTY_SELECTION,
    })[0]!;
    expect(withRemainder.tiles.at(-1)).toMatchObject({ key: FACET_OTHER_KEY, count: 2 });

    const complete = buildFacets({
      facets: [facet({ values: [{ value: "Open" }, { value: "Closed" }, { value: "Overdue" }] })],
      rows,
      columns,
      selection: EMPTY_SELECTION,
    })[0]!;
    // An "Other 0" tile is furniture, so it is not drawn.
    expect(complete.tiles.some((tile) => tile.other)).toBe(false);
  });

  it("uses the declared label and tone over what the value suggests", () => {
    const view = buildFacets({
      facets: [facet({ values: [{ value: "Open", label: "In flight", tone: "warning" }], other: "hide" })],
      rows,
      columns,
      selection: EMPTY_SELECTION,
    })[0]!;
    expect(view.tiles[0]).toMatchObject({ label: "In flight", tone: "warning" });
  });

  it("reads the tone from the real value, not its bucket key", () => {
    // `statusTone(true)` is good; `statusTone("true")` is neutral, and the key
    // is a string — so the sample value has to travel with the tile.
    const view = buildFacets({
      facets: [facet({ field: "Paid" })],
      rows: [{ Paid: true }, { Paid: false }],
      columns: [{ name: "Paid", valueType: "boolean" }],
      selection: EMPTY_SELECTION,
    })[0]!;
    expect(view.tiles.map((tile) => tile.tone)).toEqual(["good", "critical"]);
  });
});

describe("buildFacets selection", () => {
  it("drops a selection whose derived tile is gone", () => {
    // Nothing on screen could clear it, so holding it would leave the widget
    // filtered to nothing with no lit tile saying why.
    const view = buildFacets({
      facets: [facet({})],
      rows,
      columns,
      selection: { Status: ["Cancelled"] },
    })[0]!;
    expect(view.selected).toEqual([]);
  });

  it("keeps a selection on a declared tile sitting at zero", () => {
    // Here the empty result is the right answer, and the lit tile reading 0
    // is what explains it.
    const view = buildFacets({
      facets: [facet({ values: [{ value: "Open" }, { value: "Rejected" }], other: "hide" })],
      rows,
      columns,
      selection: { Status: ["Rejected"] },
    })[0]!;
    expect(view.selected).toEqual(["Rejected"]);
    expect(view.tiles.find((tile) => tile.selected)).toMatchObject({ label: "Rejected", count: 0 });
  });

  it("takes at most one selection in single mode", () => {
    const view = buildFacets({
      facets: [facet({ mode: "single" })],
      rows,
      columns,
      selection: { Status: ["Open", "Closed"] },
    })[0]!;
    expect(view.selected).toEqual(["Open"]);
  });
});

describe("applyFacets", () => {
  const views = (selection: FacetSelection) =>
    buildFacets({ facets: [facet({}), facet({ field: "Owner" })], rows, columns, selection });

  it("returns every row when nothing is picked", () => {
    expect(applyFacets(views(EMPTY_SELECTION), rows).rows).toHaveLength(4);
  });

  it("narrows to the picked buckets", () => {
    expect(applyFacets(views({ Status: ["Open"] }), rows).rows).toEqual([rows[0], rows[1]]);
  });

  it("unions within a strip and intersects across strips", () => {
    // The convention every faceted search follows: two states OR together,
    // then the owner narrows what survives.
    const picked = views({ Status: ["Open", "Overdue"], Owner: ["Ada"] });
    expect(applyFacets(picked, rows).rows).toEqual([rows[0], rows[3]]);
  });

  it("keeps highlights on the rows they belong to", () => {
    /*
     * The failure this guards: highlights are index-parallel to rows, so
     * filtering rows without filtering highlights by the same index moves
     * every status pill onto a different record — and the pills still look
     * entirely plausible afterwards.
     */
    const mark = (label: string): readonly RowHighlight[] => [
      { id: label, tone: "warning", label },
    ];
    const highlights = [mark("one"), mark("two"), mark("three"), mark("four")];

    const result = applyFacets(views({ Owner: ["Ada"] }), rows, highlights);
    expect(result.rows).toEqual([rows[0], rows[2], rows[3]]);
    expect(result.highlights).toEqual([mark("one"), mark("three"), mark("four")]);
  });

  it("shows rows outside a hidden remainder rather than dropping them", () => {
    // `other: "hide"` removes a tile, not records. Dropping them would be a
    // pipeline filter, which the author can already write.
    const hidden = buildFacets({
      facets: [facet({ values: [{ value: "Open" }], other: "hide" })],
      rows,
      columns,
      selection: EMPTY_SELECTION,
    });
    expect(applyFacets(hidden, rows).rows).toHaveLength(4);
  });
});

describe("toggleFacet", () => {
  const [status] = buildFacets({
    facets: [facet({})],
    rows,
    columns,
    selection: EMPTY_SELECTION,
  });
  const [single] = buildFacets({
    facets: [facet({ mode: "single" })],
    rows,
    columns,
    selection: EMPTY_SELECTION,
  });

  it("adds and removes in multi mode", () => {
    const one = toggleFacet(EMPTY_SELECTION, status!, "Open");
    expect(one["Status"]).toEqual(["Open"]);
    const two = toggleFacet(one, status!, "Closed");
    expect(two["Status"]).toEqual(["Open", "Closed"]);
    expect(toggleFacet(two, status!, "Open")["Status"]).toEqual(["Closed"]);
  });

  it("replaces in single mode", () => {
    const one = toggleFacet(EMPTY_SELECTION, single!, "Open");
    expect(toggleFacet(one, single!, "Closed")["Status"]).toEqual(["Closed"]);
  });

  it("clears when the lit tile is clicked again, in both modes", () => {
    // There has to be a way back to the unfiltered view without a reload.
    for (const view of [status!, single!]) {
      const one = toggleFacet(EMPTY_SELECTION, view, "Open");
      expect(toggleFacet(one, view, "Open")["Status"]).toEqual([]);
    }
  });
});

describe("renderableFacets", () => {
  it("drops what validateFacets would warn about, and keeps the rest", () => {
    // One source of truth: a strip that renders is a strip the inspector has
    // nothing to say about.
    const usable = renderableFacets(
      [facet({}), facet({ field: "Amount" }), facet({ field: "Missing" })],
      columns,
    );
    expect(usable.map((entry) => entry.field)).toEqual(["Status"]);
  });
});

describe("defaultSelection, clearFacet and describeFacets", () => {
  it("turns declared defaults into bucket keys", () => {
    expect(defaultSelection([facet({ default: ["Open"] })])).toEqual({ Status: ["Open"] });
    expect(defaultSelection([facet({})])).toEqual({});
  });

  it("clears one strip and leaves the others", () => {
    expect(clearFacet({ Status: ["Open"], Owner: ["Ada"] }, "Status")).toEqual({ Owner: ["Ada"] });
  });

  it("says what is being filtered, in the tiles' own words", () => {
    const views = buildFacets({
      facets: [facet({}), facet({ field: "Owner" })],
      rows,
      columns,
      selection: { Status: ["Open", "Overdue"], Owner: [] },
    });
    expect(describeFacets(views)).toEqual(["Status: Open, Overdue"]);
  });
});
