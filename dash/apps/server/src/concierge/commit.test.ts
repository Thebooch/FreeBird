import type { BuildAllResult } from "@freebirdai/dash-agent";
import { type DashboardSpec, dashboardSchema, widgetSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { commitSetup, placeSetup, withoutPlaced } from "./commit.js";

/**
 * Writing a finished setup onto a board.
 *
 * One function because there are two doors into it — the REST wizard and the
 * chat's `confirm_setup` — and a board that differed by which door somebody
 * came through would be a second definition of what a setup produces.
 */

const widget = (id: string, title: string) =>
  widgetSchema.parse({
    id,
    title,
    component: "table",
    source: { connection: "api", op: "list" },
    roles: { columns: ["name"] },
  });

const board = (over: Record<string, unknown> = {}): DashboardSpec =>
  dashboardSchema.parse({ id: "ops", title: "Ops", widgets: [], layout: { cells: [] }, ...over });

const built = (over: Partial<BuildAllResult> = {}): BuildAllResult => ({
  widgets: [widget("properties", "Properties"), widget("listings", "Listings")],
  authored: [],
  errors: [],
  warnings: [],
  requiresFilters: [],
  ...over,
});

describe("commitSetup", () => {
  it("refuses a build that produced nothing, with its reason", () => {
    const result = commitSetup({
      board: board(),
      built: built({ widgets: [], errors: ["widget 2: no view chosen yet"] }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no view chosen yet");
  });

  it("writes every widget, not just the first", () => {
    const result = commitSetup({ board: board(), built: built() });
    expect(result.ok).toBe(true);
    expect(result.next?.widgets.map((entry) => entry.id)).toEqual(["properties", "listings"]);
  });

  it("writes no group when the setup did not ask for one", () => {
    const result = commitSetup({ board: board(), built: built() });
    expect(result.next?.groups).toEqual([]);
    // And no cells either: the packer places a new widget better than a fixed
    // guess, and always has.
    expect(result.next?.layout.cells).toEqual([]);
  });

  describe("with a frame", () => {
    const framed = () =>
      commitSetup({
        board: board(),
        built: built({ group: { title: "Portfolio", display: "row" } }),
        groupId: "g1",
      });

    it("declares it and puts every widget in it", () => {
      const result = framed();
      expect(result.next?.groups).toEqual([{ id: "g1", title: "Portfolio", display: "row" }]);
      expect(result.next?.layout.cells.every((cell) => cell.group === "g1")).toBe(true);
      expect(result.groupId).toBe("g1");
    });

    /*
     * Membership lives on the cell, so every member needs one — which is the
     * only reason cells are written here at all.
     */
    it("gives every member a cell", () => {
      const result = framed();
      expect(result.next?.layout.cells.map((cell) => cell.widgetId)).toEqual([
        "properties",
        "listings",
      ]);
    });

    it("keeps every cell inside the grid", () => {
      const result = framed();
      for (const cell of result.next?.layout.cells ?? []) {
        expect(cell.x + cell.w).toBeLessThanOrEqual(12);
      }
    });

    it("lands below whatever is already on the board", () => {
      const existing = board({
        widgets: [widget("old", "Old")],
        layout: { cells: [{ widgetId: "old", x: 0, y: 0, w: 6, h: 5 }] },
      });
      const result = commitSetup({
        board: existing,
        built: built({ group: { title: "Portfolio", display: "tabs" } }),
        groupId: "g1",
      });
      const anchor = result.next?.layout.cells.find((cell) => cell.widgetId === "properties");
      expect(anchor?.y).toBeGreaterThanOrEqual(5);
    });

    /*
     * A group of one is a shape the dashboard schema refuses, so a setup that
     * asked for a frame and lost a part must arrive as ordinary tiles rather
     * than as something nothing will store.
     */
    it("does not frame a single widget", () => {
      const result = commitSetup({
        board: board(),
        built: built({
          widgets: [widget("properties", "Properties")],
          group: { title: "Portfolio", display: "tabs" },
        }),
      });
      expect(result.ok).toBe(true);
      expect(result.next?.groups).toEqual([]);
    });

    it("produces a board the schema accepts", () => {
      // `commitSetup` parses before returning, so reaching here at all is the
      // assertion — but say so, because that is the guarantee callers rely on.
      expect(framed().next).toBeDefined();
    });
  });
});

describe("placeSetup", () => {
  const placedBoard = () =>
    board({
      widgets: [widget("old", "Old"), widget("other", "Other")],
      layout: { cells: [{ widgetId: "old", x: 4, y: 2, w: 6, h: 4 }] },
    });

  it("is a plain write when nothing has been placed yet", () => {
    const result = placeSetup({ board: board(), built: built() });
    expect(result.ok).toBe(true);
    expect(result.replaced).toBe(false);
    expect(result.next?.widgets).toHaveLength(2);
  });

  it("rewrites the placed widget where it stands, keeping its id and its cell", () => {
    const result = placeSetup({
      board: placedBoard(),
      built: built({ widgets: [widget("fresh-id", "Renamed")] }),
      placed: { widgetIds: ["old"] },
    });
    expect(result.ok).toBe(true);
    expect(result.replaced).toBe(true);
    expect(result.next?.widgets.map((entry) => [entry.id, entry.title])).toEqual([
      ["old", "Renamed"],
      ["other", "Other"],
    ]);
    expect(result.next?.layout.cells).toEqual([
      expect.objectContaining({ widgetId: "old", x: 4, y: 2, w: 6, h: 4 }),
    ]);
  });

  it("swaps the tiles when the setup changed shape", () => {
    const result = placeSetup({
      board: placedBoard(),
      built: built(),
      placed: { widgetIds: ["old"] },
    });
    expect(result.ok).toBe(true);
    expect(result.replaced).toBe(true);
    expect(result.next?.widgets.map((entry) => entry.id)).toEqual([
      "other",
      "properties",
      "listings",
    ]);
  });

  it("adds afresh when the placed widget was removed from the board", () => {
    const result = placeSetup({
      board: board({ widgets: [widget("other", "Other")] }),
      built: built({ widgets: [widget("fresh-id", "Back again")] }),
      placed: { widgetIds: ["old"] },
    });
    expect(result.replaced).toBe(false);
    expect(result.next?.widgets.map((entry) => entry.id)).toEqual(["other", "fresh-id"]);
  });

  it("takes placed widgets back off the board", () => {
    expect(withoutPlaced(placedBoard(), { widgetIds: ["old"] }).widgets.map((w) => w.id)).toEqual([
      "other",
    ]);
  });
});
