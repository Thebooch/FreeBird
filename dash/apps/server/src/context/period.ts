import { defaultGrainFor, type ResolvedParams } from "@freebirdai/dash-spec";
import { addDays, daysBetween, instantOn, localDate } from "../scheduling/zoned.js";

/**
 * The period a question is about, when it is not the one the board shows.
 *
 * "How many leases started last month?" is answered in the conversation and
 * moves nothing, but it has to read last month, not whatever window the open
 * tab happens to show. `answer_from_data` takes the days (`from`, `to`, in the
 * reader's own calendar) and the read uses them in place of the board's
 * range. The model works the days out from today's date, which `turnNote`
 * gives it each turn with the window the tab shows.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Ten years: past that it is a typo, not a question. */
const LONGEST_DAYS = 3660;

/** The read's parameters for those days, in that zone: or null when they are not a period. */
export const periodParams = (from: unknown, to: unknown, zone: string): ResolvedParams | null => {
  if (typeof from !== "string" || typeof to !== "string" || !DAY.test(from) || !DAY.test(to)) return null;
  const days = daysBetween(from, to);
  if (!Number.isFinite(days) || days < 0 || days > LONGEST_DAYS) return null;
  const start = instantOn(from, "00:00", zone);
  const end = instantOn(addDays(to, 1), "00:00", zone) - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { range: { start, end, grain: defaultGrainFor(start, end), preset: "custom" }, filters: {} };
};

const longDay = (ms: number, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: zone }).format(ms);
const shortDay = (ms: number, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: zone }).format(ms);

/**
 * This turn's date and the tab's window, for `turnNote`. It changes every
 * turn, which is why it is a note after the cache point and not part of what
 * the registry knows.
 */
export const describeTurn = (input: { readonly now: number; readonly zone: string; readonly window?: { readonly start: number; readonly end: number } | null }): string => {
  const today = `TODAY — ${longDay(input.now, input.zone)} (${localDate(input.now, input.zone)}, ${input.zone}).`;
  const shows = input.window
    ? ` THE OPEN TAB SHOWS — ${shortDay(input.window.start, input.zone)} to ${shortDay(input.window.end, input.zone)}.`
    : "";
  return (
    today +
    shows +
    " A question about another period (last month, in March, since June) passes that period's first and last days to " +
    "`answer_from_data` as `from` and `to`; it is answered here and the tab does not change."
  );
};
