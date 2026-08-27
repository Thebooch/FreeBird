import type { Row } from "@freebirdai/dash-runtime";

/**
 * The arithmetic behind the collection components.
 *
 * Grouping, day boundaries, funnel drop-off and a month grid are all places a
 * plausible-looking answer can be quietly wrong — an event on the last day of
 * the month landing in the wrong week, a drop-off computed against the wrong
 * stage — so they live here where they can be checked without a DOM.
 */

export interface Bucket {
  readonly key: string;
  readonly rows: readonly Row[];
}

/**
 * Split rows into buckets by one column, keeping first-seen order.
 *
 * First-seen rather than alphabetical: the pipeline decided the order, and a
 * board whose columns are sorted by name puts "Approved" before "Applied",
 * which is backwards for every workflow anybody has.
 */
export const bucketBy = (rows: readonly Row[], column: string): readonly Bucket[] => {
  const order: string[] = [];
  const groups = new Map<string, Row[]>();

  for (const row of rows) {
    const value = row[column];
    const key = value === null || value === undefined || value === "" ? "—" : String(value);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else {
      groups.set(key, [row]);
      order.push(key);
    }
  }

  return order.map((key) => ({ key, rows: groups.get(key) ?? [] }));
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A timestamp from whatever the API called a date.
 *
 * Returns null rather than `NaN` or the epoch: a row whose date could not be
 * read must be reported as undated, not silently placed in January 1970.
 */
export const instantOf = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds and milliseconds are both common and a thousand-fold error is
    // not subtle. Anything below this threshold is far too small to be a
    // millisecond timestamp in any year anybody is looking at.
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    /*
     * A bare "YYYY-MM-DD" is a calendar date, not an instant.
     *
     * `Date.parse` reads it as UTC midnight, and every reader west of UTC then
     * sees it fall on the previous day — an event dated the 19th shows up on
     * the 18th. Building it as local midnight keeps the day the API wrote.
     * A string that carries a time is left alone: it really is an instant, and
     * JavaScript already reads an unzoned one as local.
     */
    const dateOnly = DATE_ONLY.exec(value);
    if (dateOnly) {
      const [, year, month, day] = dateOnly;
      return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  return null;
};

export interface DatedRow {
  readonly row: Row;
  readonly at: number;
}

/**
 * Rows that carry a readable date, newest first, plus the ones that do not.
 *
 * Undated rows are handed back rather than dropped: they exist, and a feed
 * that silently omits them is under-reporting without saying so.
 */
export const byRecency = (
  rows: readonly Row[],
  column: string,
): { dated: readonly DatedRow[]; undated: readonly Row[] } => {
  const dated: DatedRow[] = [];
  const undated: Row[] = [];

  for (const row of rows) {
    const at = instantOf(row[column]);
    if (at === null) undated.push(row);
    else dated.push({ row, at });
  }

  return { dated: [...dated].sort((a, b) => b.at - a.at), undated };
};

/**
 * The local midnight an instant belongs to, as a stable key.
 *
 * Local rather than UTC on purpose: a feed says what happened "today", and
 * today is a thing that happens where the reader is. Grouping by UTC would
 * split an evening in one timezone across two headings.
 */
export const dayKey = (at: number): string => {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

export interface DayGroup {
  readonly key: string;
  /** Midnight of that day, for formatting the heading. */
  readonly at: number;
  readonly rows: readonly DatedRow[];
}

export const groupByDay = (dated: readonly DatedRow[]): readonly DayGroup[] => {
  const order: string[] = [];
  const groups = new Map<string, DatedRow[]>();

  for (const entry of dated) {
    const key = dayKey(entry.at);
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else {
      groups.set(key, [entry]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const rows = groups.get(key) ?? [];
    const first = rows[0];
    const midnight = first ? new Date(first.at) : new Date();
    midnight.setHours(0, 0, 0, 0);
    return { key, at: midnight.getTime(), rows };
  });
};

export interface FunnelStage {
  readonly label: string;
  readonly value: number;
  /** Share of the first stage, 0–1. Drives the bar width. */
  readonly ofFirst: number;
  /** Share of the stage immediately before, 0–1. Null on the first. */
  readonly ofPrevious: number | null;
  /** How many were lost since the previous stage. Null on the first. */
  readonly dropped: number | null;
}

/**
 * Stage widths and the drop between them.
 *
 * Measured against the *first* stage for the bar and against the *previous*
 * one for the percentage, because those answer different questions: how much
 * of the intake reached here, and how much of the last step survived. Showing
 * one and labelling it the other is the usual way a funnel misleads.
 *
 * A stage larger than the one before it is left as it is rather than clamped —
 * that happens in real data (a record entering late) and hiding it would make
 * the chart lie to protect its own shape.
 */
export const funnelStages = (
  rows: readonly Row[],
  labelColumn: string,
  valueColumn: string,
): readonly FunnelStage[] => {
  const raw = rows.map((row) => ({
    label: String(row[labelColumn] ?? "—"),
    value: typeof row[valueColumn] === "number" ? (row[valueColumn] as number) : 0,
  }));

  const first = raw[0]?.value ?? 0;
  return raw.map((stage, index) => {
    const previous = index === 0 ? null : (raw[index - 1]?.value ?? 0);
    return {
      label: stage.label,
      value: stage.value,
      ofFirst: first > 0 ? stage.value / first : 0,
      ofPrevious: previous === null ? null : previous > 0 ? stage.value / previous : 0,
      dropped: previous === null ? null : previous - stage.value,
    };
  });
};

export interface CalendarDay {
  readonly key: string;
  readonly date: number;
  /** Midnight, for placing entries. */
  readonly at: number;
  readonly inMonth: boolean;
  readonly isToday: boolean;
}

/**
 * A month as six weeks of seven days.
 *
 * Always six rows, so the grid does not change height between months and the
 * widget below it stops moving. Leading and trailing days belong to the
 * neighbouring months and are marked, not hidden — an event on the 1st that
 * falls on a Sunday has to be somewhere.
 */
export const monthGrid = (monthAt: number, now: number): readonly CalendarDay[] => {
  const anchor = new Date(monthAt);
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  // Monday-first: the working week is the thing most of these records are about.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);

  const todayKey = dayKey(now);
  const days: CalendarDay[] = [];

  for (let index = 0; index < 42; index++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const at = day.getTime();
    days.push({
      key: dayKey(at),
      date: day.getDate(),
      at,
      inMonth: day.getMonth() === anchor.getMonth(),
      isToday: dayKey(at) === todayKey,
    });
  }
  return days;
};

/**
 * Which days each row covers.
 *
 * A row with an end date appears on every day it spans, so a five-day booking
 * is visible on all five rather than only on the day it began. Capped so one
 * row with a broken end date cannot fill the month.
 */
export const daysCovered = (
  row: Row,
  startColumn: string,
  endColumn: string | undefined,
  limit = 42,
): readonly string[] => {
  const start = instantOf(row[startColumn]);
  if (start === null) return [];

  const end = endColumn ? instantOf(row[endColumn]) : null;
  if (end === null || end <= start) return [dayKey(start)];

  const keys: string[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setHours(0, 0, 0, 0);

  while (cursor.getTime() <= last.getTime() && keys.length < limit) {
    keys.push(dayKey(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
};
