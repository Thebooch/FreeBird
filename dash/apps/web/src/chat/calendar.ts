/**
 * Calendar arithmetic for the Timeline tab, on `YYYY-MM-DD` days in the
 * reader's own calendar. Built on local dates via `new Date(y, m, d)`, which
 * normalises overflow (day 32, month -1) itself.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

export const toDay = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const fromDay = (day: string): Date => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

export const addDays = (day: string, n: number): string => {
  const date = fromDay(day);
  return toDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + n));
};

/** The `count` calendar days ending on `today`, oldest first. */
export const recentDays = (today: string, count = 7): string[] =>
  Array.from({ length: count }, (_, index) => addDays(today, index - count + 1));

/** A month as `{ year, month }`, month 0-11. */
export interface Month {
  readonly year: number;
  readonly month: number;
}

export const monthOf = (day: string): Month => {
  const date = fromDay(day);
  return { year: date.getFullYear(), month: date.getMonth() };
};

export const addMonths = (at: Month, n: number): Month => {
  const date = new Date(at.year, at.month + n, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
};

export const firstOfMonth = (at: Month): string => toDay(new Date(at.year, at.month, 1));

/** The day `day` would move to in `at`, kept inside that month (Jan 31 → Feb 28). */
export const sameDayIn = (day: string, at: Month): string => {
  const last = new Date(at.year, at.month + 1, 0).getDate();
  return toDay(new Date(at.year, at.month, Math.min(fromDay(day).getDate(), last)));
};

/**
 * A month laid out in weeks, Sunday first. Cells outside the month are null,
 * so the grid is always whole rows.
 */
export const monthGrid = (at: Month): (string | null)[][] => {
  const lead = new Date(at.year, at.month, 1).getDay();
  const length = new Date(at.year, at.month + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length }, (_, index) => toDay(new Date(at.year, at.month, index + 1))),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
};

/** Short weekday names, Sunday first, in the reader's locale. */
export const weekdayNames = (style: "short" | "narrow" = "short"): string[] =>
  Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + index).toLocaleDateString(undefined, { weekday: style }));
