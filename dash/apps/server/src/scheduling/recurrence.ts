import type { Occurrence, Placement } from "@freebirdai/dash-spec";
import { addDays, dateKey, daysBetween, daysInMonth, instantOn, parseDate, weekdayOfDate } from "./zoned.js";

/**
 * The times a placement comes round.
 *
 * Expanded in the placement's own zone, in wall time, so "8:00 every
 * Tuesday" is 8:00 on both sides of a daylight-saving change. A placement
 * that runs past midnight keeps its length in days and its end on the clock.
 * `count` counts skipped dates too (like RFC 5545's EXDATE), so skipping one
 * Tuesday does not push the series a week longer.
 */

/** No series is walked further than this, however it is written. */
const MAX_STEPS = 20_000;

/** The candidate dates a placement's rule names, in order, from its first. */
function* datesOf(placement: Placement, from: string): Generator<string> {
  const first = placement.start.slice(0, 10);
  const repeat = placement.repeat;
  if (!repeat) {
    yield first;
    return;
  }
  const interval = repeat.interval;
  /* With no count to keep, the walk may start near `from` instead of at the first date. */
  const skipTo = repeat.count === undefined && from > first;

  if (repeat.every === "day") {
    let k = skipTo ? Math.max(0, Math.floor(daysBetween(first, from) / interval) - 1) : 0;
    for (let steps = 0; steps < MAX_STEPS; steps++, k++) yield addDays(first, k * interval);
    return;
  }

  if (repeat.every === "week") {
    const weekdays = [...new Set(repeat.weekdays && repeat.weekdays.length > 0 ? repeat.weekdays : [weekdayOfDate(first)])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const monday = addDays(first, -((weekdayOfDate(first) + 6) % 7));
    let week = skipTo ? Math.max(0, Math.floor(daysBetween(monday, from) / 7 / interval) - 1) * interval : 0;
    for (let steps = 0; steps < MAX_STEPS; steps++, week += interval) {
      for (const day of weekdays) {
        const date = addDays(monday, week * 7 + ((day + 6) % 7));
        if (date >= first) yield date;
      }
    }
    return;
  }

  /* Monthly: the same date, or the nth weekday, `interval` months apart. */
  const start = parseDate(first);
  const weekday = weekdayOfDate(first);
  const monthsTo = (date: string) => {
    const at = parseDate(date);
    return (at.year - start.year) * 12 + (at.month - start.month);
  };
  let k = skipTo ? Math.max(0, Math.floor(monthsTo(from) / interval) - 1) : 0;
  for (let steps = 0; steps < MAX_STEPS; steps++, k++) {
    const index = start.month - 1 + k * interval;
    const year = start.year + Math.floor(index / 12);
    const month = (index % 12) + 1;
    const last = daysInMonth(year, month);
    if (repeat.monthly?.by === "weekday") {
      const nth = repeat.monthly.nth;
      let day: number;
      if (nth === -1) {
        day = last;
        while (weekdayOfDate(dateKey(year, month, day)) !== weekday) day -= 1;
      } else {
        day = 1;
        while (weekdayOfDate(dateKey(year, month, day)) !== weekday) day += 1;
        day += (nth - 1) * 7;
        if (day > last) continue;
      }
      const date = dateKey(year, month, day);
      if (date >= first) yield date;
    } else if (start.day <= last) {
      /* A month without the date (the 31st) is skipped, not moved. */
      yield dateKey(year, month, start.day);
    }
  }
}

/** Every occurrence starting on a local date in [from, to], in the placement's zone. */
export const expand = (placement: Placement, from: string, to: string): Occurrence[] => {
  const span = daysBetween(placement.start.slice(0, 10), placement.end.slice(0, 10));
  const startTime = placement.start.slice(11);
  const endTime = placement.end.slice(11);
  const skipped = new Set(placement.except);
  const repeat = placement.repeat;
  const tier = repeat ? "repeat" : "once";
  /* An occurrence that started before `from` may still run into it. */
  const earliest = addDays(from, -span);
  const out: Occurrence[] = [];
  let counted = 0;
  for (const date of datesOf(placement, earliest)) {
    if (date > to) break;
    if (repeat?.until && date > repeat.until) break;
    if (repeat?.count !== undefined && counted >= repeat.count) break;
    counted += 1;
    if (date < earliest || skipped.has(date)) continue;
    const start = instantOn(date, startTime, placement.timezone);
    const end = instantOn(addDays(date, span), endTime, placement.timezone);
    if (end > start) out.push({ placement: placement.id, block: placement.block, date, start, end, tier });
  }
  return out;
};

/** The rule as RFC 5545 `RRULE`, for an `.ics` feed. Absent for a placement that happens once. */
export const toRRule = (placement: Placement): string | undefined => {
  const repeat = placement.repeat;
  if (!repeat) return undefined;
  const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const parts = [`FREQ=${repeat.every === "day" ? "DAILY" : repeat.every === "week" ? "WEEKLY" : "MONTHLY"}`];
  if (repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`);
  if (repeat.every === "week" && repeat.weekdays && repeat.weekdays.length > 0) parts.push(`BYDAY=${repeat.weekdays.map((day) => days[day]).join(",")}`);
  if (repeat.every === "month" && repeat.monthly?.by === "weekday") parts.push(`BYDAY=${repeat.monthly.nth}${days[weekdayOfDate(placement.start.slice(0, 10))]}`);
  if (repeat.until) parts.push(`UNTIL=${repeat.until.replace(/-/g, "")}T235959`);
  if (repeat.count !== undefined) parts.push(`COUNT=${repeat.count}`);
  return parts.join(";");
};
