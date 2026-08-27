import type { ColumnMeta } from "@freebirdai/dash-spec";
import type { Row } from "@freebirdai/dash-runtime";

/**
 * What a table does to rows before drawing them.
 *
 * Pure and separate from the component, because sorting, searching and paging
 * are where the wrong answers hide — a comparator that puts 10 before 9, a
 * search that matches the raw value while the reader sees a formatted one —
 * and none of that needs a DOM to check.
 *
 * Everything here runs on the rows the pipeline already produced. The table
 * never re-queries: what it sorts is what is on screen, and the component says
 * so rather than implying it sorted the endpoint.
 */

export type SortDirection = "asc" | "desc";

export interface SortState {
  readonly column: string;
  readonly direction: SortDirection;
}

/**
 * The sort to apply, given what the user asked for and what exists now.
 *
 * A pipeline change can remove the column somebody sorted by. Holding the sort
 * in state and trusting it is the `useState(propDerivedValue)` trap this
 * codebase has already hit three times, so the check happens at read time.
 */
export const effectiveSort = (
  sort: SortState | null,
  columns: readonly string[],
): SortState | null => (sort && columns.includes(sort.column) ? sort : null);

const isEmpty = (value: unknown): boolean =>
  value === null || value === undefined || value === "";

/**
 * Compare two present values.
 *
 * Numbers compare as numbers, dates as instants, everything else by locale.
 * Emptiness is deliberately NOT handled here: the direction sign is applied to
 * whatever this returns, so putting the null rule inside it would flip the
 * empties to the top on a descending sort.
 */
const compareValues = (a: unknown, b: unknown): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);

  const aNum = typeof a === "number" ? a : Number(a);
  const bNum = typeof b === "number" ? b : Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && typeof a !== "string") {
    return aNum - bNum;
  }

  // `numeric: true` so "item 10" follows "item 9" rather than "item 1".
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};

export const sortRows = (rows: readonly Row[], sort: SortState | null): readonly Row[] => {
  if (!sort) return rows;
  const sign = sort.direction === "asc" ? 1 : -1;

  // A copy: the caller's array is the pipeline's output and may be shared with
  // the cache, where an in-place sort would silently reorder another widget.
  return [...rows].sort((a, b) => {
    const left = a[sort.column];
    const right = b[sort.column];

    /*
     * Empties sink in both directions, so they are settled before the sign is
     * applied. "No value" is not the smallest value — a descending sort that
     * opens with a screen of blanks has buried the answer.
     */
    const leftEmpty = isEmpty(left);
    const rightEmpty = isEmpty(right);
    if (leftEmpty && rightEmpty) return 0;
    if (leftEmpty) return 1;
    if (rightEmpty) return -1;

    return sign * compareValues(left, right);
  });
};

export const nextSort = (current: SortState | null, column: string): SortState | null => {
  if (!current || current.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  // Third click clears it, so there is a way back to the pipeline's own order
  // without reloading the page.
  return null;
};

/**
 * Filter by what the reader can see.
 *
 * Matching the formatted text rather than the raw value is the whole point: a
 * date shown as "12 Aug 2026" should be findable by typing "Aug", and a
 * currency shown as "$1,200" should not require knowing it is stored in cents.
 */
export const filterRows = (
  rows: readonly Row[],
  columns: readonly string[],
  query: string,
  display: (row: Row, column: string) => string,
): readonly Row[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter((row) =>
    columns.some((column) => display(row, column).toLowerCase().includes(needle)),
  );
};

export interface ColumnTotal {
  readonly column: string;
  readonly sum: number;
  /** How many rows actually held a number. */
  readonly counted: number;
}

/**
 * A column of identifiers, which must never be summed.
 *
 * The semantic is the real answer where one was inferred. The name convention
 * is the fallback, and it is the same one `pickIdField` uses on the server —
 * an API that calls a column `PropertyId` is telling you what it is.
 *
 * Case matters: matching `id$` case-insensitively would also catch "Paid",
 * "Bid" and "Valid", so the camelCase boundary is checked against the original
 * spelling rather than a lowercased copy.
 */
export const isIdentifierColumn = (column: ColumnMeta): boolean =>
  column.semantic === "identifier" ||
  /^id$/i.test(column.name) ||
  /^(uuid|guid)$/i.test(column.name) ||
  /[a-z0-9]Id$/.test(column.name) ||
  /(^|_)id$/i.test(column.name);

/**
 * Sum the numeric columns worth summing.
 *
 * Identifiers are excluded: the sum of a column of primary keys is a large
 * number that means nothing, and printing it in bold under a column of real
 * figures invites someone to read it as one.
 *
 * `counted` rides along so the component can say a total covers 48 of 50 rows
 * rather than presenting a sum over partial data as if it were complete.
 */
export const columnTotals = (
  rows: readonly Row[],
  columns: readonly string[],
  meta: readonly ColumnMeta[],
): readonly ColumnTotal[] => {
  const numeric = new Set(
    meta
      .filter((column) => column.valueType === "numeric" && !isIdentifierColumn(column))
      .map((column) => column.name),
  );

  const totals: ColumnTotal[] = [];
  for (const column of columns) {
    if (!numeric.has(column)) continue;
    let sum = 0;
    let counted = 0;
    for (const row of rows) {
      const value = row[column];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      sum += value;
      counted++;
    }
    totals.push({ column, sum, counted });
  }
  return totals;
};

/**
 * The columns to draw, honouring what the reader hid.
 *
 * Hidden names that no longer exist are ignored rather than removed from the
 * set: a pipeline edit that drops a column temporarily should not silently
 * forget that the reader had hidden it.
 */
export const visibleColumns = (
  columns: readonly string[],
  hidden: ReadonlySet<string>,
): readonly string[] => {
  const shown = columns.filter((column) => !hidden.has(column));
  // Never render a table with no columns because everything was hidden — that
  // is an empty box with no way back. The first column stays.
  return shown.length > 0 ? shown : columns.slice(0, 1);
};
