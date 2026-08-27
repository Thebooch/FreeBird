import type { Row } from "@freebirdai/dash-runtime";
import { SERIES_SLOTS } from "./palette.js";

export interface SeriesPoint {
  readonly x: number;
  readonly y: number | null;
}

export interface BuiltSeries {
  readonly key: string;
  readonly label: string;
  /** Palette slot, 0-based. */
  readonly slot: number;
  readonly points: readonly SeriesPoint[];
  /** True for the folded "Other" bucket, which is drawn in muted ink. */
  readonly isOther: boolean;
}

export interface BuildSeriesInput {
  readonly rows: readonly Row[];
  readonly x: string;
  readonly y: string;
  readonly series?: string | undefined;
  /**
   * Every key ever seen for this widget. Slots are assigned from this list so
   * that filtering a series out never repaints the survivors.
   */
  readonly seriesOrder?: readonly string[] | undefined;
}

export const OTHER_KEY = "__other__";

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

interface SlotAssignment {
  readonly kept: ReadonlyArray<{ readonly key: string; readonly slot: number }>;
  readonly folded: readonly string[];
}

/**
 * Decide which keys get a hue and which one.
 *
 * When the caller supplies a stable `seriesOrder`, that list is the authority:
 * a key's slot is its position in it, counted whether or not its neighbours
 * are currently on screen. That is what makes colour follow the entity rather
 * than its rank — filtering one series out must never repaint the survivors.
 *
 * Without that list there is nothing to be stable against, so the largest
 * eight keep a hue and the rest fold.
 */
const assignSlots = (
  present: readonly string[],
  seriesOrder: readonly string[] | undefined,
  totals: ReadonlyMap<string, number>,
): SlotAssignment => {
  const alphabetical = [...present].sort((a, b) => a.localeCompare(b));

  if (seriesOrder && seriesOrder.length > 0) {
    const authority = [...seriesOrder];
    for (const key of alphabetical) if (!authority.includes(key)) authority.push(key);

    const kept: Array<{ key: string; slot: number }> = [];
    const folded: string[] = [];
    authority.forEach((key, slot) => {
      if (!present.includes(key)) return;
      if (slot < SERIES_SLOTS) kept.push({ key, slot });
      else folded.push(key);
    });
    return { kept, folded };
  }

  const keep = new Set(
    [...present]
      .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
      .slice(0, SERIES_SLOTS),
  );
  return {
    kept: alphabetical.filter((key) => keep.has(key)).map((key, slot) => ({ key, slot })),
    folded: alphabetical.filter((key) => !keep.has(key)),
  };
};

/**
 * Turn flat rows into drawable series.
 *
 * Two rules from the palette are enforced here rather than left to the chart:
 * hues are never cycled past slot 8 (a ninth series folds into "Other"), and
 * a series keeps its hue regardless of how many neighbours are on screen.
 */
export const buildSeries = (input: BuildSeriesInput): BuiltSeries[] => {
  const { rows, x, y, series, seriesOrder } = input;

  if (!series) {
    const points = rows
      .map((row) => ({ x: num(row[x]), y: num(row[y]) }))
      .filter((point): point is { x: number; y: number | null } => point.x !== null)
      .sort((a, b) => a.x - b.x);
    return points.length === 0
      ? []
      : [{ key: y, label: y, slot: 0, points, isOther: false }];
  }

  const buckets = new Map<string, SeriesPoint[]>();
  const totals = new Map<string, number>();

  for (const row of rows) {
    const xv = num(row[x]);
    if (xv === null) continue;
    const raw = row[series];
    const key = raw === null || raw === undefined ? "—" : String(raw);
    const yv = num(row[y]);

    const points = buckets.get(key);
    if (points) points.push({ x: xv, y: yv });
    else buckets.set(key, [{ x: xv, y: yv }]);

    totals.set(key, (totals.get(key) ?? 0) + Math.abs(yv ?? 0));
  }

  const present = [...buckets.keys()];
  const { kept, folded } = assignSlots(present, seriesOrder, totals);

  const result: BuiltSeries[] = kept.map(({ key, slot }) => ({
    key,
    label: key,
    slot,
    points: [...(buckets.get(key) ?? [])].sort((a, b) => a.x - b.x),
    isOther: false,
  }));

  if (folded.length > 0) {
    const summed = new Map<number, number | null>();
    for (const key of folded) {
      for (const point of buckets.get(key) ?? []) {
        const current = summed.get(point.x);
        summed.set(point.x, (current ?? 0) + (point.y ?? 0));
      }
    }
    result.push({
      key: OTHER_KEY,
      label: `Other (${folded.length})`,
      slot: -1,
      points: [...summed.entries()]
        .map(([px, py]) => ({ x: px, y: py }))
        .sort((a, b) => a.x - b.x),
      isOther: true,
    });
  }

  return result;
};

export interface CategoryDatum {
  readonly label: string;
  readonly value: number;
  /** Stacked segments, present only when a series role is bound. */
  readonly segments: ReadonlyArray<{ key: string; label: string; slot: number; value: number; isOther: boolean }>;
}

/** Categorical rollup for the bar chart, with the same folding rule. */
export const buildCategories = (input: {
  readonly rows: readonly Row[];
  readonly category: string;
  readonly value: string;
  readonly series?: string | undefined;
  readonly seriesOrder?: readonly string[] | undefined;
  readonly limit?: number;
}): { data: CategoryDatum[]; keys: BuiltSeries[] } => {
  const { rows, category, value, series, seriesOrder, limit = 40 } = input;

  const byCategory = new Map<string, Map<string, number>>();
  const seriesTotals = new Map<string, number>();

  for (const row of rows) {
    const rawCategory = row[category];
    const label = rawCategory === null || rawCategory === undefined ? "—" : String(rawCategory);
    const amount = num(row[value]) ?? 0;
    const key = series
      ? row[series] === null || row[series] === undefined
        ? "—"
        : String(row[series])
      : value;

    let bucket = byCategory.get(label);
    if (!bucket) {
      bucket = new Map();
      byCategory.set(label, bucket);
    }
    bucket.set(key, (bucket.get(key) ?? 0) + amount);
    seriesTotals.set(key, (seriesTotals.get(key) ?? 0) + Math.abs(amount));
  }

  const presentKeys = [...seriesTotals.keys()];
  const { kept, folded: foldedKeys } = assignSlots(presentKeys, seriesOrder, seriesTotals);

  const keys: BuiltSeries[] = kept.map(({ key, slot }) => ({
    key,
    label: key,
    slot,
    points: [],
    isOther: false,
  }));

  if (foldedKeys.length > 0) {
    keys.push({
      key: OTHER_KEY,
      label: `Other (${foldedKeys.length})`,
      slot: -1,
      points: [],
      isOther: true,
    });
  }

  const data: CategoryDatum[] = [...byCategory.entries()]
    .map(([label, bucket]) => {
      const segments = keys
        .map((key) => {
          const amount =
            key.isOther
              ? foldedKeys.reduce((total, folded) => total + (bucket.get(folded) ?? 0), 0)
              : (bucket.get(key.key) ?? 0);
          return { key: key.key, label: key.label, slot: key.slot, value: amount, isOther: key.isOther };
        })
        .filter((segment) => segment.value !== 0);
      return {
        label,
        value: segments.reduce((total, segment) => total + segment.value, 0),
        segments,
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);

  return { data, keys };
};
