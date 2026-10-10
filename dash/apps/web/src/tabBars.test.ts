import { describe, expect, it } from "vitest";
import { barFor, barsOf, stepBar } from "./tabBars.js";

describe("tab bars", () => {
  it("are every bar holding a tab, then one empty bar to start a new one", () => {
    expect(barsOf([])).toEqual([0]);
    expect(barsOf([{ id: "a" }, { id: "b" }])).toEqual([0, 1]);
    expect(barsOf([{ id: "a" }, { id: "r", bar: 1 }])).toEqual([0, 1, 2]);
    /* A bar emptied by deleting its tabs is skipped; there is only ever one empty bar. */
    expect(barsOf([{ id: "a" }, { id: "r", bar: 3 }])).toEqual([0, 3, 4]);
  });

  it("step up toward the empty bar and down toward the first, stopping at the ends", () => {
    const bars = [0, 1, 2];
    expect(stepBar(bars, 0, 1)).toBe(1);
    expect(stepBar(bars, 2, 1)).toBe(2);
    expect(stepBar(bars, 1, -1)).toBe(0);
    expect(stepBar(bars, 0, -1)).toBe(0);
  });

  it("show the open tab's bar", () => {
    const tabs = [{ id: "a" }, { id: "r", bar: 1 }];
    expect(barFor(tabs, "r")).toBe(1);
    expect(barFor(tabs, null)).toBe(0);
  });
});
