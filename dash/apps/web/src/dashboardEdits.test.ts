import type { DashboardSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";

/**
 * Taking a widget off a board.
 *
 * The rule as a pure function, matching `removeWidget` in `main.tsx`. What is
 * worth pinning is not the filter over `widgets` — that part is obvious — but
 * that the layout cell goes with it. A cell left behind reserves grid space
 * for an id nothing renders, and the packer lays the survivors out around a
 * hole that has no widget in it.
 */
const withoutWidget = (dashboard: DashboardSpec, widgetId: string): DashboardSpec => ({
  ...dashboard,
  widgets: dashboard.widgets.filter((widget) => widget.id !== widgetId),
  layout: {
    ...dashboard.layout,
    cells: dashboard.layout.cells.filter((cell) => cell.widgetId !== widgetId),
  },
});

const board = {
  id: "board",
  title: "Board",
  widgets: [{ id: "keep" }, { id: "drop" }],
  layout: {
    cells: [
      { widgetId: "keep", x: 0, y: 0, w: 6, h: 4, locked: false },
      { widgetId: "drop", x: 6, y: 0, w: 6, h: 4, locked: false },
    ],
  },
} as unknown as DashboardSpec;

describe("removing a widget", () => {
  it("takes its layout cell with it", () => {
    const next = withoutWidget(board, "drop");
    expect(next.widgets.map((widget) => widget.id)).toEqual(["keep"]);
    expect(next.layout.cells.map((cell) => cell.widgetId)).toEqual(["keep"]);
  });

  it("leaves the survivors exactly where they were", () => {
    // Removing one widget must not reshuffle the board around it.
    expect(withoutWidget(board, "drop").layout.cells[0]).toEqual(board.layout.cells[0]);
  });

  it("is a no-op for an id that is not on the board", () => {
    expect(withoutWidget(board, "never-existed")).toEqual(board);
  });
});
