import type { ColumnMeta } from "@freebirdai/dash-spec";
import { facetSchema } from "@freebirdai/dash-spec";
import type { Row } from "@freebirdai/dash-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildFacets, EMPTY_SELECTION, type FacetSelection } from "../widgets/facetModel.js";
import { FacetBar } from "./FacetBar.jsx";

const columns: readonly ColumnMeta[] = [{ name: "Status", valueType: "categorical" }];

const rows: readonly Row[] = [
  { Status: "Open" },
  { Status: "Open" },
  { Status: "Overdue" },
];

const markup = (selection: FacetSelection = EMPTY_SELECTION, variant?: string): string =>
  renderToStaticMarkup(
    createElement(FacetBar, {
      views: buildFacets({
        facets: [facetSchema.parse({ field: "Status" })],
        rows,
        columns,
        selection,
      }),
      onToggle: () => {},
      onClear: () => {},
      ...(variant ? { variant } : {}),
    }),
  );

describe("FacetBar", () => {
  it("draws a tile per category with its count", () => {
    const html = markup();
    expect(html).toContain("Open");
    expect(html).toContain("Overdue");
    expect(html).toContain(">2<");
    expect(html).toContain(">1<");
  });

  it("says the state with aria-pressed rather than aria-selected", () => {
    /*
     * The distinction this component exists to get right. A tab strip has
     * exactly one `aria-selected` member and a roving tabindex; a facet can
     * have several tiles lit, or none at all meaning "everything". Reusing
     * `Tabs` here would announce a set that does not exist.
     */
    const html = markup({ Status: ["Open"] });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("aria-selected");
    expect(html).not.toContain('role="tab"');
  });

  it("offers a way back to everything only once something is filtering", () => {
    expect(markup()).not.toContain("facet-clear");
    expect(markup({ Status: ["Open"] })).toContain("facet-clear");
  });

  it("carries a glyph beside the colour on a toned tile", () => {
    // Colour is never the only channel: the tile has to survive a monochrome
    // print and forced-colours mode with its meaning intact.
    const html = markup();
    expect(html).toContain("dash-facets__icon");
  });

  it("renders nothing at all when there is no facet to draw", () => {
    expect(
      renderToStaticMarkup(createElement(FacetBar, { views: [], onToggle: () => {} })),
    ).toBe("");
  });

  it("falls back to tiles for an unknown variant", () => {
    expect(markup(EMPTY_SELECTION, "chips")).toContain('data-variant="chips"');
    expect(markup(EMPTY_SELECTION, "nonsense")).toContain('data-variant="tiles"');
  });
});
