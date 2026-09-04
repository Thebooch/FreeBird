import type { ComponentContract, ComponentId, LayoutCell, SizeVariant } from "@freebirdai/dash-spec";
import { contractFor } from "@freebirdai/dash-spec";

/**
 * Deterministic grid packer, ported from `solveLayout` in `@freebirdai/core`
 * (MIT, same author) and narrowed to the explicit size-variant path that every
 * Dash contract uses.
 *
 * Pure: the same widgets in the same order always produce the same layout, so
 * a dashboard opened twice looks identical and a saved layout round-trips.
 */

export interface PlacementRequest {
  readonly widgetId: string;
  readonly component: ComponentId;
  /** 1–5. Higher lands earlier and larger. */
  readonly importance?: number;
}

export interface SolveLayoutOptions {
  readonly gridCols?: number;
  /** Cells the user has already positioned. Treated as immovable. */
  readonly locked?: readonly LayoutCell[];
  readonly maxRows?: number;
}

export interface SolveLayoutResult {
  readonly cells: LayoutCell[];
  readonly dropped: ReadonlyArray<{ widgetId: string; reason: string }>;
}

const regionFree = (
  occupancy: boolean[][],
  x: number,
  y: number,
  w: number,
  h: number,
): boolean => {
  for (let row = y; row < y + h; row++) {
    const line = occupancy[row];
    if (!line) return false;
    for (let col = x; col < x + w; col++) if (line[col]) return false;
  }
  return true;
};

const markOccupied = (
  occupancy: boolean[][],
  x: number,
  y: number,
  w: number,
  h: number,
): void => {
  for (let row = y; row < y + h; row++) {
    const line = occupancy[row];
    if (!line) continue;
    for (let col = x; col < x + w; col++) line[col] = true;
  }
};

const findFirstFit = (
  occupancy: boolean[][],
  w: number,
  h: number,
  gridCols: number,
  maxRows: number,
): { x: number; y: number } | null => {
  for (let y = 0; y <= maxRows - h; y++) {
    for (let x = 0; x <= gridCols - w; x++) {
      if (regionFree(occupancy, x, y, w, h)) return { x, y };
    }
  }
  return null;
};

/**
 * Largest variant that fits, never smaller than the contract's floor. A solo
 * widget starts from the biggest so it fills the space instead of leaving a
 * lonely tile in a corner.
 */
const placeWithVariants = (input: {
  contract: ComponentContract;
  isSolo: boolean;
  occupancy: boolean[][];
  gridCols: number;
  maxRows: number;
}): { variant: SizeVariant; placement: { x: number; y: number } } | null => {
  const { contract, isSolo, occupancy, gridCols, maxRows } = input;
  const byArea = [...contract.grid.sizes].sort((a, b) => b.w * b.h - a.w * a.h);

  const floorIndex = contract.grid.minSize
    ? byArea.findIndex((variant) => variant.name === contract.grid.minSize)
    : byArea.length - 1;
  const floor = floorIndex === -1 ? byArea.length - 1 : floorIndex;

  let start = 0;
  if (!isSolo && contract.grid.preferredSize) {
    const preferred = byArea.findIndex((variant) => variant.name === contract.grid.preferredSize);
    start = preferred === -1 ? 0 : preferred;
  }

  for (let index = start; index <= floor; index++) {
    const variant = byArea[index]!;
    if (variant.w > gridCols) continue;
    const placement = findFirstFit(occupancy, variant.w, variant.h, gridCols, maxRows);
    if (placement) return { variant, placement };
  }
  return null;
};

export const solveLayout = (
  requests: readonly PlacementRequest[],
  options: SolveLayoutOptions = {},
): SolveLayoutResult => {
  const gridCols = options.gridCols ?? 12;
  const maxRows = options.maxRows ?? 48;
  const locked = options.locked ?? [];

  const occupancy: boolean[][] = Array.from({ length: maxRows }, () =>
    Array.from({ length: gridCols }, () => false),
  );

  const cells: LayoutCell[] = [];
  const dropped: Array<{ widgetId: string; reason: string }> = [];

  for (const cell of locked) {
    if (cell.x < 0 || cell.y < 0 || cell.x + cell.w > gridCols || cell.y + cell.h > maxRows) {
      dropped.push({ widgetId: cell.widgetId, reason: "saved position is outside the grid" });
      continue;
    }
    if (!regionFree(occupancy, cell.x, cell.y, cell.w, cell.h)) {
      dropped.push({ widgetId: cell.widgetId, reason: "saved position collides" });
      continue;
    }
    markOccupied(occupancy, cell.x, cell.y, cell.w, cell.h);
    cells.push({ ...cell, locked: true });
  }

  const ranked = [...requests].sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3));
  const isSolo = ranked.length === 1 && locked.length === 0;

  for (const request of ranked) {
    const contract = contractFor(request.component);
    if (!contract) {
      dropped.push({ widgetId: request.widgetId, reason: "unknown component" });
      continue;
    }

    const placed = placeWithVariants({ contract, isSolo, occupancy, gridCols, maxRows });
    if (!placed) {
      dropped.push({ widgetId: request.widgetId, reason: "no room left in the grid" });
      continue;
    }

    markOccupied(
      occupancy,
      placed.placement.x,
      placed.placement.y,
      placed.variant.w,
      placed.variant.h,
    );
    cells.push({
      widgetId: request.widgetId,
      x: placed.placement.x,
      y: placed.placement.y,
      w: placed.variant.w,
      h: placed.variant.h,
      locked: false,
      sizeVariant: placed.variant.name,
    });
  }

  return { cells, dropped };
};

/**
 * Place any widget the saved layout does not mention, leaving the ones it does
 * exactly where the user put them.
 */
export const completeLayout = (
  widgets: readonly PlacementRequest[],
  saved: readonly LayoutCell[],
  gridCols = 12,
): LayoutCell[] => {
  const known = new Set(saved.map((cell) => cell.widgetId));
  const live = new Set(widgets.map((widget) => widget.widgetId));
  const locked = saved.filter((cell) => live.has(cell.widgetId));
  const missing = widgets.filter((widget) => !known.has(widget.widgetId));

  if (missing.length === 0) return [...locked];
  return solveLayout(missing, { locked, gridCols }).cells;
};

/** Clamp a dragged or resized cell back inside the grid. */
export const clampCell = (cell: LayoutCell, gridCols = 12): LayoutCell => {
  const w = Math.max(1, Math.min(cell.w, gridCols));
  const h = Math.max(1, Math.min(cell.h, 24));
  return {
    ...cell,
    w,
    h,
    x: Math.max(0, Math.min(cell.x, gridCols - w)),
    y: Math.max(0, cell.y),
  };
};

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
 * Extracted from the grid because it is the one piece of that component with
 * a way to lose data, and losing it is silent. Two rules matter:
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
