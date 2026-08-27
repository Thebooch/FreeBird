import { dashboardSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { autoArrange, isTypingTarget, nextRow } from "./editing.js";

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
