import type { LayoutCell } from "@freebirdai/dash-spec";

/**
 * The grid packer, which now lives in `@freebirdai/dash-spec`.
 *
 * It moved because the server needs it too: a board built during onboarding is
 * laid out before any browser sees it, and placing widgets was never a
 * rendering concern. Re-exported from here so every existing call site keeps
 * working and there is still one packer rather than two that can disagree.
 */
export {
  clampCell,
  completeLayout,
  solveLayout,
  type PlacementRequest,
  type SolveLayoutOptions,
  type SolveLayoutResult,
} from "@freebirdai/dash-spec";

/** One rectangle the grid library reports back after a drag or resize. */
export interface MovedItem {
  readonly i: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Fold a finished drag back into the board's cells.
 *
 * Stays here rather than moving with the packer: it is about the grid library
 * this package renders with, not about where a widget goes. Two rules matter:
 *
 * The cell is *spread*, never rebuilt. A cell carries more than its rectangle
 * — `group` above all — and constructing a fresh object from the library's
 * item drops every one of those fields, which would dissolve a group the first
 * time anybody dragged it.
 *
 * Parked cells are written back untouched. A group's non-anchor members are
 * never given to the library, so nothing moves them; omitting them here would
 * delete them from the layout and take the group's membership with them.
 */
export const persistCells = (
  placed: ReadonlyArray<{ cell: LayoutCell; key: string }>,
  parked: readonly LayoutCell[],
  moved: readonly MovedItem[],
): LayoutCell[] => {
  const byKey = new Map(moved.map((item) => [item.i, item]));
  return [
    ...placed.map(({ cell, key }) => {
      const item = byKey.get(key);
      return item
        ? { ...cell, x: item.x, y: item.y, w: item.w, h: item.h, locked: true }
        : { ...cell, locked: true };
    }),
    ...parked.map((cell) => ({ ...cell, locked: true })),
  ];
};
