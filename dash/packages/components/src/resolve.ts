import type { ColumnMeta, ColumnReference, FormatSpec, SemanticType } from "@freebirdai/dash-spec";
import type { Row, RowHighlight } from "@freebirdai/dash-runtime";
import {
  SEMANTICS,
  formatValue,
  humanLabel,
  parentsFrom,
  referenceIds,
  targetOfRow,
} from "@freebirdai/dash-spec";
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

export interface ReferenceCell {
  /** What to draw. Never empty while the cell holds anything at all. */
  readonly text: string;
  /** Whether following it would reach a record. */
  readonly canOpen: boolean;
  /** What to open, when it can be opened. */
  readonly target?: {
    readonly entity: string;
    readonly id: string | number;
    readonly parents?: Readonly<Record<string, string>> | undefined;
  };
}

/**
 * One cell of a reference column: what it says, and whether it opens.
 *
 * The single place the three-way precedence lives — the name already on the
 * row, then one that was fetched, then the honest fallback that at least names
 * the *kind* of record. A component reimplementing any part of this would
 * drift on the case that shows least: the unresolved one, which is what most
 * readers see on a wide table.
 *
 * Pure, so every branch is checkable without rendering anything.
 */
export const referenceText = (input: {
  readonly row: Row;
  readonly column: string;
  readonly reference: ColumnReference;
  /** column → id → name, resolved above the component. */
  readonly names?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
  /** How the raw value would otherwise have been printed. */
  readonly formatted?: string | undefined;
}): ReferenceCell => {
  const { row, column, reference } = input;
  const raw = row[column];
  const plain = input.formatted ?? (raw === null || raw === undefined ? "" : String(raw));

  /*
   * A row naming a different kind of record than this link's default. Nothing
   * here knows what that kind is called, and borrowing the default's name
   * would mislabel the record — so it stays the plain value.
   */
  if (targetOfRow(row, reference) !== reference.target) return { text: plain, canOpen: false };

  const ids = referenceIds(raw, reference.holds);
  const first = ids[0];

  const embedded = reference.embedded
    .map((name) => row[name])
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value));

  const resolved = first === undefined ? undefined : input.names?.[column]?.[String(first)];

  const text =
    embedded.length > 0
      ? embedded.join(" ")
      : (resolved ??
        (ids.length > 1
          ? `${ids.length} ${reference.targetName.toLowerCase()}s`
          : first !== undefined
            ? `${reference.targetName} ${first}`
            : plain));

  /*
   * A list of ids has no single record to open, and an empty cell has none
   * either. Both render as text rather than as a control that goes nowhere.
   */
  const single = ids.length === 1 && first !== undefined;
  /*
   * A far record that lives under a parent opens with the parent's id off this
   * same row. A row that does not carry it names the record but cannot reach
   * it, so it is drawn as text.
   */
  const parents = reference.lookup?.parents?.length
    ? parentsFrom(reference.lookup.parents, row)
    : undefined;
  return {
    text,
    canOpen: Boolean(reference.lookup) && single && parents !== null,
    ...(single
      ? { target: { entity: reference.target, id: first, ...(parents ? { parents } : {}) } }
      : {}),
  };
};

export interface RecordEntry {
  readonly name: string;
  readonly label: string;
  readonly value: unknown;
  readonly formatted: string;
  /** True for a flattened child like `Address.City`, for indenting. */
  readonly nested: boolean;
  /**
   * What this field means, where the record type's dictionary says.
   *
   * A record is the one surface with room for it: a table header has none, and
   * this is where somebody is reading one thing carefully rather than scanning
   * forty.
   */
  readonly description?: string;
  /**
   * Set when this field holds another record's identity.
   *
   * Carried through so a record view renders a reference the same way a table
   * cell does — through `referenceText`, rather than a second implementation
   * of the same precedence that would drift on the unresolved case.
   */
  readonly reference?: ColumnReference;
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
  props: Pick<
    WidgetRenderProps,
    "rows" | "columns" | "format" | "now" | "locale" | "timeZone"
  >,
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
    const meta = props.columns.find((column) => column.name === name);
    entries.push({
      name,
      label: labelOf(props.columns, name),
      value,
      formatted: makeFormatter(props, name)(value),
      nested: name.includes("."),
      ...(meta?.description ? { description: meta.description } : {}),
      ...(meta?.reference ? { reference: meta.reference } : {}),
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
