import { describe, expect, it } from "vitest";
import { pageSlice } from "./Pagination.jsx";
import { skeletonShapeFor } from "./Skeleton.jsx";

const rows = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

describe("pageSlice", () => {
  it("cuts the requested page and reports the range in human numbers", () => {
    const slice = pageSlice(rows(100), 3, 25);
    expect(slice.rows).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75]);
    expect(slice.rangeStart).toBe(51);
    expect(slice.rangeEnd).toBe(75);
    expect(slice.pageCount).toBe(4);
    expect(slice.total).toBe(100);
  });

  it("reports a short last page honestly", () => {
    const slice = pageSlice(rows(102), 5, 25);
    expect(slice.rows).toEqual([101, 102]);
    expect(slice.rangeStart).toBe(101);
    expect(slice.rangeEnd).toBe(102);
  });

  /*
   * A filter that shrinks the result set leaves the page number pointing past
   * the end. Trusting it renders an empty table over a non-empty list, which
   * gets reported as "the search is broken".
   */
  it("clamps a page past the end rather than showing nothing", () => {
    const slice = pageSlice(rows(10), 99, 25);
    expect(slice.page).toBe(1);
    expect(slice.rows).toHaveLength(10);
  });

  it("clamps a page below the first", () => {
    expect(pageSlice(rows(10), 0, 5).page).toBe(1);
    expect(pageSlice(rows(10), -4, 5).page).toBe(1);
  });

  it("says nothing rather than 1-0 of 0 when there are no rows", () => {
    const slice = pageSlice([], 1, 25);
    expect(slice.total).toBe(0);
    expect(slice.rangeStart).toBe(0);
    expect(slice.rangeEnd).toBe(0);
    // Still one page, so the control has something coherent to render.
    expect(slice.pageCount).toBe(1);
  });

  it("survives a zero page size instead of dividing by it", () => {
    const slice = pageSlice(rows(3), 1, 0);
    expect(Number.isFinite(slice.pageCount)).toBe(true);
    expect(slice.pageCount).toBe(3);
  });
});

describe("skeletonShapeFor", () => {
  it("matches the shape each component is about to draw", () => {
    expect(skeletonShapeFor("bar")).toBe("bars");
    expect(skeletonShapeFor("timeseries")).toBe("chart");
    expect(skeletonShapeFor("stat")).toBe("sparkline");
    expect(skeletonShapeFor("statusGrid")).toBe("grid");
  });

  it("falls back to lines for a component it has never heard of", () => {
    // Component ids are open names, so this is reachable in normal use rather
    // than only by mistake.
    expect(skeletonShapeFor("somebodysCustomThing")).toBe("list");
  });
});
