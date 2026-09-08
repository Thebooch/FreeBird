import type { ColumnMeta, FacetSpec, StatusTone } from "@freebirdai/dash-spec";
import { facetKey, facetTone, validateFacets } from "@freebirdai/dash-spec";
import type { Row, RowHighlight } from "@freebirdai/dash-runtime";
import { labelOf } from "../resolve.js";

/**
 * The arithmetic behind the filter strips.
 *
 * Pure and separate from the renderer, because every wrong answer a facet can
 * give lives here: a count that collapses to zero the moment something is
 * picked, tiles that reorder under the pointer, a selection that survives the
 * tile it belonged to, highlights that come loose from their rows. None of it
 * needs a DOM to check, and all of it is invisible when it is wrong — the
 * numbers still look like numbers.
 *
 * Everything runs over the rows the pipeline already produced. A facet never
 * re-queries, so a tile's count is a fact about the rows on screen and the
 * strip can say so honestly.
 */

/**
 * The bucket for rows outside a declared value list.
 *
 * Follows the `__x__` convention `OTHER_KEY` set in `series.ts`, and is a
 * separate constant because the two fold different things: that one folds
 * small series out of a chart, this one names the remainder of a facet.
 */
export const FACET_OTHER_KEY = "__facet_other__";

export interface FacetTile {
  /** The bucket this tile filters to. Never shown. */
  readonly key: string;
  readonly label: string;
  readonly tone: StatusTone;
  /**
   * How many rows are in this category *right now*.
   *
   * Counted with this facet's own selection ignored and every other facet's
   * applied — see `buildFacets`.
   */
  readonly count: number;
  readonly selected: boolean;
  /** The remainder tile, which stands for no single value. */
  readonly other: boolean;
}

export interface FacetView {
  readonly field: string;
  readonly label: string;
  readonly mode: "single" | "multi";
  /** True when the tiles came from the spec rather than from the rows. */
  readonly declared: boolean;
  readonly tiles: readonly FacetTile[];
  /** Bucket keys narrowing the widget. Never holds a key with no tile. */
  readonly selected: readonly string[];
}

/** field → the bucket keys picked in that strip. */
export type FacetSelection = Readonly<Record<string, readonly string[]>>;

export const EMPTY_SELECTION: FacetSelection = Object.freeze({});

/**
 * The facets that can actually be drawn.
 *
 * One source of truth with the warnings the widget reports: if `validateFacets`
 * has something to say about a facet, that facet does not render. Anything
 * else would let a strip appear that the inspector simultaneously calls broken.
 */
export const renderableFacets = (
  facets: readonly FacetSpec[],
  columns: readonly ColumnMeta[],
): readonly FacetSpec[] => facets.filter((facet) => validateFacets([facet], columns).length === 0);

/** What a facet's `default` means as a selection, before the rows are known. */
export const defaultSelection = (facets: readonly FacetSpec[]): FacetSelection => {
  const selection: Record<string, readonly string[]> = {};
  for (const facet of facets) {
    if (facet.default.length > 0) selection[facet.field] = facet.default.map(facetKey);
  }
  return selection;
};

/** The declared bucket keys, or null when the tiles come from the data. */
const declaredKeysOf = (facet: FacetSpec): ReadonlySet<string> | null =>
  facet.values ? new Set(facet.values.map((option) => facetKey(option.value))) : null;

/** Which tile a row belongs to, folding the undeclared remainder together. */
const tileKeyOf = (field: string, declared: ReadonlySet<string> | null, row: Row): string => {
  const key = facetKey(row[field]);
  if (!declared) return key;
  return declared.has(key) ? key : FACET_OTHER_KEY;
};

const matchesSelection = (
  field: string,
  declared: ReadonlySet<string> | null,
  picked: readonly string[],
  row: Row,
): boolean => picked.length === 0 || picked.includes(tileKeyOf(field, declared, row));

interface DerivedKey {
  readonly key: string;
  /** The first raw value seen in this bucket, so the tone reads the real type. */
  readonly sample: unknown;
}

/**
 * The tiles a facet offers, in a fixed order, from the *unfiltered* rows.
 *
 * Both halves of that matter. Declared values keep their declaration order, so
 * a workflow reads Applied → Approved → Rejected rather than alphabetically.
 * Derived values keep first-seen order — the same rule `bucketBy` follows, and
 * for the same reason.
 *
 * Reading the whole row set rather than the currently-filtered one is what
 * keeps the strip usable: a tile computed from filtered rows would vanish as
 * soon as another facet excluded its last row, taking with it the only control
 * that could have brought it back.
 */
const tilesFor = (facet: FacetSpec, rows: readonly Row[]): readonly DerivedKey[] => {
  const declared = declaredKeysOf(facet);

  if (declared) {
    const keys: DerivedKey[] = (facet.values ?? []).map((option) => ({
      key: facetKey(option.value),
      sample: option.value,
    }));
    // Only when something actually falls outside: an "Other 0" tile is furniture.
    if (
      facet.other === "show" &&
      rows.some((row) => !declared.has(facetKey(row[facet.field])))
    ) {
      keys.push({ key: FACET_OTHER_KEY, sample: null });
    }
    return keys;
  }

  const seen = new Set<string>();
  const keys: DerivedKey[] = [];
  for (const row of rows) {
    const value = row[facet.field];
    const key = facetKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ key, sample: value });
  }
  return keys;
};

export interface BuildFacetsInput {
  readonly facets: readonly FacetSpec[];
  readonly rows: readonly Row[];
  readonly columns: readonly ColumnMeta[];
  readonly selection: FacetSelection;
}

/**
 * Every strip, with its tiles, counts and current selection resolved.
 *
 * Two rules carry this function.
 *
 * **A tile's count ignores its own facet's selection and honours every other
 * one.** This is the standard faceted-search rule and it is not optional: the
 * obvious implementation — count the rows the widget is about to show — makes
 * every unselected tile read zero the instant anything is picked, which
 * removes the one piece of information the strip existed to give. "Open 12"
 * has to keep saying 12 after Overdue is also selected, because it is still
 * true.
 *
 * **A selection is resolved against the tiles that exist**, the way
 * `effectiveSort` resolves a sort column, so a saved or default selection
 * naming a value the data no longer has cannot leave the widget filtered to
 * nothing with no lit tile explaining it. A *declared* value keeps its tile at
 * zero and keeps its selection: an empty result is the correct answer there,
 * and the lit tile reading 0 says so.
 */
export const buildFacets = (input: BuildFacetsInput): readonly FacetView[] => {
  const usable = renderableFacets(input.facets, input.columns);
  if (usable.length === 0) return [];

  const declared = new Map(usable.map((facet) => [facet.field, declaredKeysOf(facet)]));
  const tiles = new Map(usable.map((facet) => [facet.field, tilesFor(facet, input.rows)]));

  /*
   * Settled before any counting, because the counts depend on it: a stale key
   * left in the selection would filter the other facets' base rows by a bucket
   * that no tile can clear.
   */
  const picked = new Map<string, readonly string[]>();
  for (const facet of usable) {
    const available = new Set((tiles.get(facet.field) ?? []).map((tile) => tile.key));
    const chosen = (input.selection[facet.field] ?? []).filter((key) => available.has(key));
    picked.set(facet.field, facet.mode === "single" ? chosen.slice(0, 1) : chosen);
  }

  return usable.map((facet) => {
    const own = tiles.get(facet.field) ?? [];
    const chosen = picked.get(facet.field) ?? [];

    // Every other facet applied, this one ignored.
    const base = input.rows.filter((row) =>
      usable.every(
        (other) =>
          other.field === facet.field ||
          matchesSelection(
            other.field,
            declared.get(other.field) ?? null,
            picked.get(other.field) ?? [],
            row,
          ),
      ),
    );

    const counts = new Map<string, number>();
    const facetDeclared = declared.get(facet.field) ?? null;
    for (const row of base) {
      const key = tileKeyOf(facet.field, facetDeclared, row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const byKey = new Map(
      (facet.values ?? []).map((option) => [facetKey(option.value), option] as const),
    );

    return {
      field: facet.field,
      label: facet.label ?? labelOf(input.columns, facet.field),
      mode: facet.mode,
      declared: facetDeclared !== null,
      selected: chosen,
      tiles: own.map((tile) => {
        const other = tile.key === FACET_OTHER_KEY;
        const option = byKey.get(tile.key);
        return {
          key: tile.key,
          label: other ? "Other" : (option?.label ?? tile.key),
          tone: other ? ("neutral" as StatusTone) : facetTone(option, tile.sample),
          count: counts.get(tile.key) ?? 0,
          selected: chosen.includes(tile.key),
          other,
        };
      }),
    };
  });
};

export interface FacetedRows {
  readonly rows: readonly Row[];
  readonly highlights?: readonly (readonly RowHighlight[])[];
}

/**
 * The rows a widget should draw, given what the reader picked.
 *
 * Takes the built views rather than a raw selection so that the strip and the
 * rows under it cannot disagree — the keys filtered by are literally the keys
 * drawn as selected. One computation, both consumers.
 *
 * Highlights travel with the rows and are filtered by the same index, never
 * separately. They are index-parallel to `rows`, so filtering one and not the
 * other moves every status pill onto the wrong record — the same failure the
 * table documents about sorting, and harder to spot here because the pills
 * still look plausible.
 */
export const applyFacets = (
  views: readonly FacetView[],
  rows: readonly Row[],
  highlights?: readonly (readonly RowHighlight[])[],
): FacetedRows => {
  const active = views.filter((view) => view.selected.length > 0);
  if (active.length === 0) return highlights ? { rows, highlights } : { rows };

  const matchers = active.map((view) => ({
    field: view.field,
    declared: view.declared
      ? new Set(view.tiles.filter((tile) => !tile.other).map((tile) => tile.key))
      : null,
    picked: view.selected,
  }));

  const keptRows: Row[] = [];
  const keptHighlights: (readonly RowHighlight[])[] = [];

  rows.forEach((row, index) => {
    const kept = matchers.every((matcher) =>
      matchesSelection(matcher.field, matcher.declared, matcher.picked, row),
    );
    if (!kept) return;
    keptRows.push(row);
    if (highlights) keptHighlights.push(highlights[index] ?? []);
  });

  return highlights ? { rows: keptRows, highlights: keptHighlights } : { rows: keptRows };
};

/**
 * The selection after clicking one tile.
 *
 * Clicking a lit tile clears it in both modes, so there is always a way back
 * to the unfiltered view without reloading — the same escape the table's
 * third-click-clears-sort gives.
 */
export const toggleFacet = (
  selection: FacetSelection,
  view: FacetView,
  key: string,
): FacetSelection => {
  const current = selection[view.field] ?? [];
  const lit = current.includes(key);
  const next = lit
    ? current.filter((entry) => entry !== key)
    : view.mode === "single"
      ? [key]
      : [...current, key];
  return { ...selection, [view.field]: next };
};

/** Drop one strip's selection, leaving the others alone. */
export const clearFacet = (selection: FacetSelection, field: string): FacetSelection => {
  const next = { ...selection };
  delete next[field];
  return next;
};

/**
 * What is being filtered, in words.
 *
 * For anything that has to say what the reader is looking at rather than draw
 * it — an empty state explaining why there are no rows, and the chat, which
 * would otherwise answer about four hundred records while the person asking
 * can see twelve.
 */
export const describeFacets = (views: readonly FacetView[]): readonly string[] =>
  views
    .filter((view) => view.selected.length > 0)
    .map((view) => {
      const labels = view.tiles
        .filter((tile) => tile.selected)
        .map((tile) => tile.label)
        .join(", ");
      return `${view.label}: ${labels}`;
    });
