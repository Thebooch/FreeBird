/**
 * Wall time in a named time zone, without a date library.
 *
 * Availability is written in wall time ("8:00 every Tuesday in Chicago") and
 * kept as instants. Converting between the two is where daylight saving
 * bites: once a year a wall time does not exist (the clocks jump forward) and
 * once a year it exists twice (they fall back). Both are settled the way
 * `Temporal`'s default ("compatible") does: a time in the gap moves forward
 * by the size of the jump, and a time that happens twice is the earlier one.
 *
 * Only `Intl`, which every runtime here has, with formatters cached per zone.
 */

export interface WallTime {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (zone: string): Intl.DateTimeFormat => {
  let held = formatters.get(zone);
  if (!held) {
    held = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, held);
  }
  return held;
};

/** The wall time an instant shows in a zone. */
export const wallTime = (ms: number, zone: string): WallTime & { readonly second: number } => {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts["year"]!, month: parts["month"]!, day: parts["day"]!, hour: parts["hour"] === 24 ? 0 : parts["hour"]!, minute: parts["minute"]!, second: parts["second"]! };
};

/** How far a zone's clock is ahead of UTC at an instant, in milliseconds. */
export const offsetAt = (ms: number, zone: string): number => {
  const wall = wallTime(ms, zone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(ms / 1000) * 1000;
};

const sameWall = (a: WallTime, b: WallTime): boolean => a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

/**
 * The instant a wall time names in a zone. A wall time in a spring-forward
 * gap moves forward by the jump (2:30 becomes 3:30); one that happens twice
 * is the earlier.
 */
export const toInstant = (wall: WallTime, zone: string): number => {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  /* The zone's offset a day either side: the two a transition near this time switches between. */
  const before = offsetAt(naive - 86_400_000, zone);
  const after = offsetAt(naive + 86_400_000, zone);
  const candidates = [...new Set([naive - before, naive - after])].filter((ms) => sameWall(wallTime(ms, zone), wall));
  if (candidates.length > 0) return Math.min(...candidates);
  /* In the gap: read with the offset from before the jump, which lands the jump's length later. */
  return naive - before;
};

/* ── dates as `YYYY-MM-DD` ─────────────────────────────────────────────── */

const pad = (n: number): string => String(n).padStart(2, "0");

export const dateKey = (year: number, month: number, day: number): string => `${year}-${pad(month)}-${pad(day)}`;

/** The local date an instant falls on in a zone. */
export const localDate = (ms: number, zone: string): string => {
  const wall = wallTime(ms, zone);
  return dateKey(wall.year, wall.month, wall.day);
};

export const parseDate = (date: string): { readonly year: number; readonly month: number; readonly day: number } => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { year, month, day };
};

/** A date `n` days on. Plain calendar arithmetic: no zone is involved in counting days. */
export const addDays = (date: string, n: number): string => {
  const { year, month, day } = parseDate(date);
  const next = new Date(Date.UTC(year, month - 1, day + n));
  return dateKey(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
};

/** 0 (Sunday) to 6. */
export const weekdayOfDate = (date: string): number => {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

/** Whole days from `a` to `b`. */
export const daysBetween = (a: string, b: string): number => {
  const x = parseDate(a);
  const y = parseDate(b);
  return Math.round((Date.UTC(y.year, y.month - 1, y.day) - Date.UTC(x.year, x.month - 1, x.day)) / 86_400_000);
};

export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The instant of `HH:MM` on a local date in a zone. `24:00` is the next day's midnight. */
export const instantOn = (date: string, time: string, zone: string): number => {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  if (hour === 24) return instantOn(addDays(date, 1), "00:00", zone);
  return toInstant({ ...parseDate(date), hour, minute }, zone);
};

/** Minutes after local midnight. */
export const minuteOfDay = (ms: number, zone: string): number => {
  const wall = wallTime(ms, zone);
  return wall.hour * 60 + wall.minute;
};
