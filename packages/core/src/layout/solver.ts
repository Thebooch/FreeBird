import type { ComponentRegistry } from "../components/registry.js";
import { newId } from "../id.js";
import type {
  GridCell,
  GridHints,
  LayoutIntent,
  LayoutPlan,
  OrientationHint,
  SizeVariant,
} from "../types.js";

export interface SolveLayoutOptions {
  gridCols?: number;
  /**
   * Existing cells that are locked. These are placed first as immovable
   * obstacles. Must carry valid x/y/w/h.
   */
  locked?: GridCell[];
  /** Max rows to pack into. Defaults to 48 — plenty for any real layout. */
  maxRows?: number;
}

export interface SolveLayoutResult {
  plan: LayoutPlan;
  /** Items the LLM referenced that we had to drop (unknown id, collision, etc.). */
  dropped: Array<{ componentId: string; reason: string }>;
}

/**
 * Turn the LLM's intent into a concrete, deterministic layout plan.
 *
 * Two sizing paths, chosen per component:
 *
 * **Explicit sizes path** (when `grid.sizes` is defined):
 *   The solver picks among the registered variants based on context:
 *   1. If this component is the only one being placed (solo), start from the
 *      largest variant so empty space is filled.
 *   2. Otherwise start from `preferredSize` (default: largest).
 *   3. Step down through smaller variants until one fits.
 *   4. Never drop below `minSize`. If even that won't fit, drop the component.
 *   The chosen variant name is stored on `GridCell.sizeVariant`.
 *
 * **Range path** (legacy, when only `minW`/`minH` are set):
 *   Computes a single w×h from the orientation hint and min/max bounds —
 *   identical to the original algorithm so existing registrations are unchanged.
 *
 * General algorithm:
 *  1. Place every locked cell first (treated as immovable).
 *  2. Sort intent items by importance desc, then by wide>tall>square hint.
 *  3. For each item, attempt to place it in the first empty region that fits.
 *  4. Anything that can't be placed within maxRows is dropped with a reason.
 *
 * The algorithm is pure — given the same inputs it always produces the same
 * outputs.
 */
export const solveLayout = (
  registry: ComponentRegistry<any, any>,
  intent: LayoutIntent,
  opts: SolveLayoutOptions = {},
): SolveLayoutResult => {
  const gridCols = opts.gridCols ?? 12;
  const maxRows = opts.maxRows ?? 48;
  const locked = opts.locked ?? [];
  const dropped: Array<{ componentId: string; reason: string }> = [];

  const occupancy: boolean[][] = Array.from({ length: maxRows }, () =>
    Array.from({ length: gridCols }, () => false),
  );

  const cells: GridCell[] = [];

  // 1. Place locked cells first.
  for (const cell of locked) {
    if (
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x + cell.w > gridCols ||
      cell.y + cell.h > maxRows
    ) {
      dropped.push({ componentId: cell.componentId, reason: "locked cell out of bounds" });
      continue;
    }
    if (!regionFree(occupancy, cell.x, cell.y, cell.w, cell.h)) {
      dropped.push({ componentId: cell.componentId, reason: "locked cell collision" });
      continue;
    }
    markOccupied(occupancy, cell.x, cell.y, cell.w, cell.h);
    cells.push({ ...cell, locked: true });
  }

  // 2. Sort intent by importance desc.
  const ranked = [...intent.items].sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3));

  // "Solo" means this run places exactly one new component with no locked cells —
  // in that case we expand to the largest variant to fill dead space.
  const isSolo = ranked.length === 1 && locked.length === 0;

  // 3. Place each item.
  for (const item of ranked) {
    const def = registry.get(item.componentId);
    if (!def) {
      dropped.push({ componentId: item.componentId, reason: "unknown component id" });
      continue;
    }

    if (def.grid.sizes && def.grid.sizes.length > 0) {
      // ── Explicit sizes path ────────────────────────────────────────────────
      const result = placeWithVariants({
        sizes: def.grid.sizes,
        preferredSize: def.grid.preferredSize,
        minSize: def.grid.minSize,
        isSolo,
        occupancy,
        gridCols,
        maxRows,
      });

      if (!result) {
        dropped.push({ componentId: item.componentId, reason: "no room in grid (all variants tried)" });
        continue;
      }

      markOccupied(occupancy, result.placement.x, result.placement.y, result.variant.w, result.variant.h);
      cells.push({
        instanceId: newId("gc"),
        componentId: item.componentId,
        props: item.props ?? {},
        x: result.placement.x,
        y: result.placement.y,
        w: result.variant.w,
        h: result.variant.h,
        locked: false,
        importance: clamp(item.importance ?? 3, 1, 5),
        orientation: result.variant.aspect ?? "auto",
        sizeVariant: result.variant.name,
      });
    } else {
      // ── Legacy range path ──────────────────────────────────────────────────
      const hint = item.orientationHint ?? def.grid.defaultAspect ?? "auto";
      const size = pickSize(def.grid, hint, gridCols);

      const placement = findFirstFit(occupancy, size.w, size.h, gridCols, maxRows);
      if (!placement) {
        dropped.push({ componentId: item.componentId, reason: "no room in grid" });
        continue;
      }
      markOccupied(occupancy, placement.x, placement.y, size.w, size.h);
      cells.push({
        instanceId: newId("gc"),
        componentId: item.componentId,
        props: item.props ?? {},
        x: placement.x,
        y: placement.y,
        w: size.w,
        h: size.h,
        locked: false,
        importance: clamp(item.importance ?? 3, 1, 5),
        orientation: hint,
      });
    }
  }

  return { plan: { gridCols, cells }, dropped };
};

// ---------------------------------------------------------------------------
// Explicit-sizes picker
// ---------------------------------------------------------------------------

interface PlaceWithVariantsInput {
  sizes: SizeVariant[];
  preferredSize?: string;
  minSize?: string;
  isSolo: boolean;
  occupancy: boolean[][];
  gridCols: number;
  maxRows: number;
}

interface PlaceWithVariantsResult {
  variant: SizeVariant;
  placement: { x: number; y: number };
}

/**
 * Context-aware variant selector.
 *
 * Candidates are sorted largest→smallest by area (w×h).
 * - Solo layout: start from the largest (fill dead space).
 * - Multi layout: start from `preferredSize` (default: largest), step down.
 * - Never use a variant smaller than `minSize`.
 *
 * Returns the first variant+placement that fits, or null if none do.
 */
const placeWithVariants = (input: PlaceWithVariantsInput): PlaceWithVariantsResult | null => {
  const { sizes, preferredSize, minSize, isSolo, occupancy, gridCols, maxRows } = input;

  // Sort a working copy largest→smallest by area.
  const byArea = [...sizes].sort((a, b) => b.w * b.h - a.w * a.h);

  // Determine the smallest we're allowed to use.
  const minIdx = minSize
    ? byArea.findIndex((v) => v.name === minSize)
    : byArea.length - 1; // last = smallest
  const floorIdx = minIdx === -1 ? byArea.length - 1 : minIdx;

  // Determine the starting variant index.
  let startIdx: number;
  if (isSolo) {
    // Solo → always start from the largest.
    startIdx = 0;
  } else {
    // Multi → start from preferredSize (default: largest = index 0).
    const prefIdx = preferredSize ? byArea.findIndex((v) => v.name === preferredSize) : -1;
    startIdx = prefIdx === -1 ? 0 : prefIdx;
  }

  // Try each candidate from startIdx down to floorIdx.
  for (let i = startIdx; i <= floorIdx; i++) {
    const variant = byArea[i]!;
    // Guard: variant must fit within the grid's column count.
    if (variant.w > gridCols) continue;
    const placement = findFirstFit(occupancy, variant.w, variant.h, gridCols, maxRows);
    if (placement) return { variant, placement };
  }

  return null;
};

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Legacy single-size picker for components using the min/max range API.
 * @public exported for tests.
 */
export const pickSize = (
  grid: GridHints,
  hint: OrientationHint,
  gridCols: number,
): { w: number; h: number } => {
  const minW = grid.minW ?? 3;
  const minH = grid.minH ?? 3;
  const maxW = Math.min(grid.maxW ?? gridCols, gridCols);
  const maxH = grid.maxH ?? Math.max(minH * 2, 6);
  const clampedMinW = Math.min(minW, maxW);
  const clampedMinH = Math.min(minH, maxH);

  switch (hint) {
    case "wide": {
      const w = Math.min(Math.max(clampedMinW, Math.round(gridCols * 0.66)), maxW);
      const h = clampedMinH;
      return { w, h };
    }
    case "tall": {
      const w = clampedMinW;
      const h = Math.min(Math.max(clampedMinH + 1, Math.round(clampedMinH * 1.6)), maxH);
      return { w, h };
    }
    case "square": {
      const side = Math.min(Math.max(clampedMinW, clampedMinH, 4), maxW, maxH);
      return { w: side, h: side };
    }
    case "auto":
    default: {
      const w = Math.min(Math.max(clampedMinW, Math.round(gridCols / 2)), maxW);
      const h = Math.min(Math.max(clampedMinH, Math.round(w * 0.6)), maxH);
      return { w, h };
    }
  }
};

const regionFree = (
  occ: boolean[][],
  x: number,
  y: number,
  w: number,
  h: number,
): boolean => {
  for (let r = y; r < y + h; r++) {
    const row = occ[r];
    if (!row) return false;
    for (let c = x; c < x + w; c++) {
      if (row[c]) return false;
    }
  }
  return true;
};

const markOccupied = (occ: boolean[][], x: number, y: number, w: number, h: number): void => {
  for (let r = y; r < y + h; r++) {
    const row = occ[r];
    if (!row) continue;
    for (let c = x; c < x + w; c++) row[c] = true;
  }
};

const findFirstFit = (
  occ: boolean[][],
  w: number,
  h: number,
  gridCols: number,
  maxRows: number,
): { x: number; y: number } | null => {
  for (let y = 0; y <= maxRows - h; y++) {
    for (let x = 0; x <= gridCols - w; x++) {
      if (regionFree(occ, x, y, w, h)) return { x, y };
    }
  }
  return null;
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
