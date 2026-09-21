import { dashboardSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  autoArrange,
  groupOf,
  groupWidgets,
  isTypingTarget,
  nextRow,
  setGroupDisplay,
  ungroupWidget,
} from "./editing.js";

const board = (components: readonly string[]) =>
  dashboardSchema.parse({
    id: "board",
    title: "Board",
    widgets: components.map((component, index) => ({
      id: `w${index}`,
      title: `Widget ${index}`,
      component,
      source: { connection: "c", op: "o" },
    })),
  });

describe("autoArrange", () => {
  it("keeps every widget in the frame it was in", () => {
    /*
     * The packer is told an id and a component, so the cells it returns have
     * forgotten their group — and a group with no members is one the dashboard
     * schema refuses, which made the *whole board* unsavable on a button whose
     * only promise is that it moves things.
     */
    const grouped = dashboardSchema.parse({
      id: "board",
      title: "Board",
      widgets: ["table", "table", "stat"].map((component, index) => ({
        id: `w${index}`,
        title: `Widget ${index}`,
        component,
        source: { connection: "c", op: "o" },
      })),
      groups: [{ id: "g1", title: "Together", display: "row" }],
      layout: {
        gridCols: 12,
        cells: [
          { widgetId: "w0", x: 0, y: 0, w: 6, h: 6, group: "g1" },
          { widgetId: "w1", x: 6, y: 0, w: 6, h: 6, group: "g1" },
          { widgetId: "w2", x: 0, y: 6, w: 3, h: 3 },
        ],
      },
    });

    const { cells } = autoArrange(grouped);
    expect(cells.filter((cell) => cell.group === "g1").map((cell) => cell.widgetId)).toEqual([
      "w0",
      "w1",
    ]);
    // And the repacked board is still one the server will accept.
    expect(
      dashboardSchema.safeParse({ ...grouped, layout: { ...grouped.layout, cells } }).success,
    ).toBe(true);
  });

  it("packs from the top-left, ignoring whatever was saved", () => {
    const { cells, dropped } = autoArrange(board(["table", "table"]));
    expect(dropped).toEqual([]);
    expect(cells.every((cell) => cell.x === 0)).toBe(true);
    expect(cells.map((cell) => cell.y)).toEqual([0, 7]);
  });

  /*
   * The packer reads each component's contract, so a strip lands wide and a
   * table lands at its own preferred size. Squaring everything off to one
   * shape is what makes an auto-arrange feel like it lost information.
   */
  it("gives each component the size its contract asks for", () => {
    const { cells } = autoArrange(board(["metricRow", "table"]));
    const byWidget = new Map(cells.map((cell) => [cell.widgetId, cell]));
    expect(byWidget.get("w0")?.w).toBe(12);
    expect(byWidget.get("w1")?.w).toBe(8);
  });

  it("says which widgets it could not place rather than dropping them quietly", () => {
    const { dropped } = autoArrange(board(["table", "definitelyNotAComponent"]));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toMatch(/unknown component/);
  });
});

describe("nextRow", () => {
  it("is the bottom of the lowest widget", () => {
    expect(
      nextRow([
        { widgetId: "a", x: 0, y: 0, w: 6, h: 4, locked: true },
        { widgetId: "b", x: 6, y: 2, w: 6, h: 5, locked: true },
      ]),
    ).toBe(7);
  });

  it("is zero on an empty board", () => {
    expect(nextRow([])).toBe(0);
  });
});

/**
 * A stand-in for an element. These tests run without a DOM, which is also the
 * reason the function under test reads properties rather than using
 * `instanceof`.
 */
const element = (tagName: string, attributes: Record<string, string> = {}) =>
  ({
    tagName: tagName.toUpperCase(),
    isContentEditable: false,
    getAttribute: (name: string) => attributes[name] ?? null,
  }) as unknown as EventTarget;

describe("isTypingTarget", () => {
  /*
   * A single-letter shortcut is a good idea right up until someone types "e"
   * in a search box and the board starts wobbling.
   */
  it("recognises the places a person types", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isTypingTarget(element(tag)), tag).toBe(true);
    }
  });

  it("recognises a widget that has claimed a text-entry role", () => {
    expect(isTypingTarget(element("div", { role: "searchbox" }))).toBe(true);
    expect(isTypingTarget(element("div", { role: "combobox" }))).toBe(true);
  });

  it("recognises a contenteditable region", () => {
    const editable = {
      ...(element("div") as unknown as object),
      isContentEditable: true,
    } as unknown as EventTarget;
    expect(isTypingTarget(editable)).toBe(true);
  });

  it("lets a shortcut through everywhere else", () => {
    expect(isTypingTarget(element("div"))).toBe(false);
    expect(isTypingTarget(element("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    // The window itself is an EventTarget with no tag name.
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });
});

/**
 * Frames, changed by hand.
 *
 * Grouping was something only a setup could decide: two widgets built in one
 * breath arrived in a frame and stayed there forever. The schema supported
 * taking one out, adding a third and changing how they sat; nothing offered
 * any of it.
 *
 * The rule under every test here is the schema's own: a frame holds two or
 * more, or it is not a frame. Leaving one holding a single tile makes the
 * whole board unstorable, which is the failure mode that matters — it is not
 * the group that breaks, it is saving anything at all.
 */
describe("frames on a board", () => {
  const board = () =>
    dashboardSchema.parse({
      id: "board",
      title: "Board",
      widgets: ["table", "table", "stat"].map((component, index) => ({
        id: `w${index}`,
        title: `Widget ${index}`,
        component,
        source: { connection: "c", op: "o" },
      })),
      layout: {
        gridCols: 12,
        cells: [
          { widgetId: "w0", x: 0, y: 0, w: 6, h: 6 },
          { widgetId: "w1", x: 6, y: 0, w: 6, h: 6 },
          { widgetId: "w2", x: 0, y: 6, w: 3, h: 3 },
        ],
      },
    });

  const grouped = () => groupWidgets(board(), ["w0", "w1"], { title: "Together" });

  it("puts two widgets in one frame", () => {
    const next = grouped();
    expect(next.groups).toHaveLength(1);
    expect(next.groups[0]).toMatchObject({ title: "Together", display: "tabs" });
    const id = next.groups[0]!.id;
    expect(next.layout.cells.filter((cell) => cell.group === id).map((c) => c.widgetId)).toEqual([
      "w0",
      "w1",
    ]);
    expect(dashboardSchema.safeParse(next).success).toBe(true);
  });

  it("refuses to make a frame of one, which nothing could store", () => {
    expect(groupWidgets(board(), ["w0"], { title: "Alone" }).groups).toEqual([]);
    expect(groupWidgets(board(), [], { title: "Nobody" }).groups).toEqual([]);
  });

  it("moves a widget rather than letting it be in two frames at once", () => {
    // A widget is drawn once, so joining a frame is leaving the last one.
    const first = grouped();
    const moved = groupWidgets(first, ["w1", "w2"], { title: "The other one" });
    expect(moved.groups).toHaveLength(1);
    expect(moved.groups[0]?.title).toBe("The other one");
    // The one left behind is an ordinary tile again, not a frame of one.
    expect(moved.layout.cells.find((cell) => cell.widgetId === "w0")?.group).toBeUndefined();
    expect(dashboardSchema.safeParse(moved).success).toBe(true);
  });

  it("dissolves a frame when taking one out would leave it holding one", () => {
    const next = ungroupWidget(grouped(), "w0");
    expect(next.groups).toEqual([]);
    expect(next.layout.cells.every((cell) => cell.group === undefined)).toBe(true);
    expect(dashboardSchema.safeParse(next).success).toBe(true);
  });

  it("keeps the frame when enough members remain", () => {
    const three = groupWidgets(board(), ["w0", "w1", "w2"], { title: "All three" });
    const next = ungroupWidget(three, "w2");
    expect(next.groups).toHaveLength(1);
    expect(next.layout.cells.filter((cell) => cell.group).map((c) => c.widgetId)).toEqual([
      "w0",
      "w1",
    ]);
  });

  it("changes how a frame arranges its members", () => {
    const next = grouped();
    const id = next.groups[0]!.id;
    expect(setGroupDisplay(next, id, "row").groups[0]?.display).toBe("row");
    expect(setGroupDisplay(next, id, "stack").groups[0]?.display).toBe("stack");
  });

  it("says which frame a widget is in, and when it is in none", () => {
    const next = grouped();
    expect(groupOf(next, "w0")?.title).toBe("Together");
    expect(groupOf(next, "w2")).toBeNull();
  });

  it("survives a repack, which is what made the whole board unsavable", () => {
    const next = grouped();
    const { cells } = autoArrange(next);
    expect(
      dashboardSchema.safeParse({ ...next, layout: { ...next.layout, cells } }).success,
    ).toBe(true);
  });
});
