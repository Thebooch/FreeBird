import type { ColumnMeta, FormatSpec, SemanticType } from "@freebirdai/dash-spec";
import type { Row, RowHighlight } from "@freebirdai/dash-runtime";
import { SEMANTICS, formatValue, humanLabel } from "@freebirdai/dash-spec";
import type { WidgetRenderProps } from "./types.js";

export const roleColumn = (
  roles: WidgetRenderProps["roles"],
  name: string,
): string | undefined => {
  const bound = roles[name];
  if (bound === undefined) return undefined;
  return Array.isArray(bound) ? bound[0] : (bound as string);
};

export const roleColumns = (
  roles: WidgetRenderProps["roles"],
  name: string,
): string[] => {
  const bound = roles[name];
  if (bound === undefined) return [];
  return Array.isArray(bound) ? [...bound] : [bound as string];
};

/**
 * The format for a column: what the spec said, else what the column's semantic
 * implies. A widget never invents a format string — the semantic registry is
 * the single source of how a value is printed.
 */
export const formatFor = (
  props: Pick<WidgetRenderProps, "format" | "columns">,
  name: string | undefined,
): FormatSpec | undefined => {
  if (!name) return undefined;
  const explicit = props.format[name];
  if (explicit) return explicit;
  const column = props.columns.find((candidate) => candidate.name === name);
  return column?.semantic ? { semantic: column.semantic } : undefined;
};

export const semanticFor = (
  props: Pick<WidgetRenderProps, "format" | "columns">,
  name: string | undefined,
): SemanticType => formatFor(props, name)?.semantic ?? "text";

export const isNumericColumn = (columns: readonly ColumnMeta[], name: string | undefined): boolean =>
  columns.find((column) => column.name === name)?.valueType === "numeric";

export interface Formatter {
  (value: unknown): string;
}

export const makeFormatter = (
  props: Pick<WidgetRenderProps, "format" | "columns" | "now" | "locale" | "timeZone">,
  name: string | undefined,
  overrides: Partial<FormatSpec> = {},
): Formatter => {
  const base = formatFor(props, name);
  const spec = base ? { ...base, ...overrides } : undefined;
  return (value: unknown) =>
    formatValue(value, spec, {
      now: props.now,
      ...(props.locale ? { locale: props.locale } : {}),
      ...(props.timeZone ? { timeZone: props.timeZone } : {}),
    });
};

/** Most severe first, so one row with two marks shows the one that matters. */
const TONE_RANK: Readonly<Record<string, number>> = {
  critical: 4,
  serious: 3,
  warning: 2,
  good: 1,
  neutral: 0,
};

/**
 * The highlights on one row.
 *
 * Always go through this rather than indexing the array by hand: the parallel
 * structure is only correct while a component renders rows in the order it was
 * given them, and one accessor is one place to fix that if it ever changes.
 */
export const highlightsFor = (
  props: Pick<WidgetRenderProps, "highlights">,
  index: number,
): readonly RowHighlight[] => props.highlights?.[index] ?? [];

/** The tone a row wears when several rules matched it. */
export const dominantTone = (hits: readonly RowHighlight[]): RowHighlight["tone"] | undefined => {
  let best: RowHighlight | undefined;
  for (const hit of hits) {
    if (!best || (TONE_RANK[hit.tone] ?? 0) > (TONE_RANK[best.tone] ?? 0)) best = hit;
  }
  return best?.tone;
};

/**
 * Re-exported, not defined here.
 *
 * It moved into `@freebirdai/dash-spec` when the concierge needed the same labels on the
 * server: an option card that says "Unit number" and a table header that says
 * `unitNumber` would be the same field wearing two names.
 */
export { humanLabel } from "@freebirdai/dash-spec";

/**
 * What to call a field on screen. **Every component uses this, never the raw
 * name and never `humanLabel` directly.**
 *
 * Three answers in order of how much is known. The column carries a `label`
 * when the host stamped one on from the API's own lexicon — somebody decided
 * that `CurrentNumberOfOccupants` is "Occupants". Failing that, `humanLabel`
 * fixes the casing, which is all that can be done without knowing the domain.
 * Failing even a column — a role bound to a name the pipeline did not produce
 * — the name itself, because showing something is better than showing a gap.
 *
 * The raw name is never *lost*: callers put it on a `title` attribute, and the
 * inspector shows names untouched. A dashboard is read by people who did not
 * write the API and debugged by people who did.
 */
export const labelOf = (columns: readonly ColumnMeta[], name: string): string => {
  const column = columns.find((candidate) => candidate.name === name);
  const given = column?.label;
  return given && given.trim().length > 0 ? given : humanLabel(name);
};

export interface RecordEntry {
  readonly name: string;
  readonly label: string;
  readonly value: unknown;
  readonly formatted: string;
  /** True for a flattened child like `Address.City`, for indenting. */
  readonly nested: boolean;
}

/**
 * A single row as label/value pairs, ready to render.
 *
 * Pure, and separate from the component, because the test environment has no
 * DOM — the interesting behaviour is which fields are chosen and how they are
 * labelled, and that is all decidable without rendering anything.
 *
 * An object-valued field is dropped when its own flattened children are
 * present: `inferShape` already emits `Address.City` alongside `Address`, so
 * showing both means showing the same data twice, once unreadably.
 */
export const recordEntries = (
  props: Pick<WidgetRenderProps, "rows" | "columns" | "format" | "now" | "locale" | "timeZone">,
  names: readonly string[],
): RecordEntry[] => {
  const row = props.rows[0];
  if (!row) return [];

  const expanded = new Set(
    names.filter((name) => name.includes(".")).map((name) => name.slice(0, name.indexOf("."))),
  );

  const entries: RecordEntry[] = [];
  for (const name of names) {
    if (expanded.has(name)) continue;
    const value = row[name] ?? readNested(row, name);
    entries.push({
      name,
      label: labelOf(props.columns, name),
      value,
      formatted: makeFormatter(props, name)(value),
      nested: name.includes("."),
    });
  }
  return entries;
};

/**
 * `Address.City` off a row that has a nested `Address`.
 *
 * The runtime flattens dotted names into real columns before rendering, so
 * this is the fallback for a row that arrived unflattened — a detail response
 * handed straight to the component, for instance.
 */
const readNested = (row: Row, name: string): unknown => {
  if (!name.includes(".")) return undefined;
  let current: unknown = row;
  for (const part of name.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

/**
 * The full value, for a tooltip.
 *
 * The complement of `formatValue`: where a cell shows a readable summary, this
 * is the escape hatch that still has everything in it. Containers are
 * stringified here and only here — one hover away rather than filling a
 * column.
 */
export const titleFor = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 1);
    } catch {
      // A cycle, or a BigInt. Neither should take a widget down.
      return String(value);
    }
  }
  return String(value);
};

export const numericValues = (rows: readonly Row[], column: string | undefined): number[] => {
  if (!column) return [];
  const values: number[] = [];
  for (const row of rows) {
    const value = row[column];
    if (typeof value === "number" && Number.isFinite(value)) values.push(value);
  }
  return values;
};

/** The aggregation the semantic registry says a column wants by default. */
export const defaultAggregationFor = (semantic: SemanticType) =>
  SEMANTICS[semantic].defaultAggregation;
