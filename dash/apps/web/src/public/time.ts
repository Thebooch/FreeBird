/**
 * Times on the public pages, always in a named zone: the person's own, which
 * they can change. Days are keyed "2026-10-13" in that zone.
 */

const formatter = (zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
};

/** The day an instant falls on, in a zone. */
export const dayKey = (at: string | number, zone: string): string => {
  const parts = formatter(zone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((one) => one.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

/** A day key as noon UTC, for drawing the day itself (not a time in it). */
const dayDate = (key: string): Date => new Date(`${key}T12:00:00Z`);

/** "9:00 AM". */
export const timeOf = (at: string | number, zone: string): string => formatter(zone, { hour: "numeric", minute: "2-digit" }).format(new Date(at));

/** "Tuesday, October 13". */
export const dayWords = (key: string): string => formatter("UTC", { weekday: "long", month: "long", day: "numeric" }).format(dayDate(key));

/** "Tue, Oct 13". */
export const shortDay = (key: string): string => formatter("UTC", { weekday: "short", month: "short", day: "numeric" }).format(dayDate(key));

/** "CDT". */
export const zoneShort = (zone: string, at: string | number = Date.now()): string =>
  formatter(zone, { timeZoneName: "short" }).formatToParts(new Date(at)).find((one) => one.type === "timeZoneName")?.value ?? zone;

/** "9:00 – 10:00 AM", "11:30 AM – 12:30 PM". */
export const rangeOf = (start: string, end: string, zone: string): string => {
  const from = timeOf(start, zone);
  const to = timeOf(end, zone);
  return `${from.slice(-2) === to.slice(-2) ? from.slice(0, -3) : from} – ${to}`;
};

/** "Tuesday, October 13 · 9:00 – 10:00 AM CDT". */
export const whenWords = (start: string, end: string, zone: string): string => `${dayWords(dayKey(start, zone))} · ${rangeOf(start, end, zone)} ${zoneShort(zone, start)}`;

/** "October 2026". */
export const monthWords = (year: number, month: number): string => formatter("UTC", { month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month, 15)));

export interface GridDay {
  readonly key: string;
  readonly day: number;
  readonly inMonth: boolean;
}

/** Six weeks from the Sunday on or before the first of the month. */
export const monthGrid = (year: number, month: number): GridDay[] => {
  const first = new Date(Date.UTC(year, month, 1));
  const start = Date.UTC(year, month, 1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_unused, index) => {
    const at = new Date(start + index * 86_400_000);
    return { key: at.toISOString().slice(0, 10), day: at.getUTCDate(), inMonth: at.getUTCMonth() === month };
  });
};

/** A range wide enough to hold every time of the month in any zone. */
export const monthRange = (year: number, month: number): { readonly from: string; readonly to: string } => ({
  from: new Date(Date.UTC(year, month, 1) - 14 * 3_600_000).toISOString(),
  to: new Date(Date.UTC(year, month + 1, 1) + 14 * 3_600_000).toISOString(),
});

/** The year and month a day key is in. */
export const monthOf = (key: string): { readonly year: number; readonly month: number } => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) - 1 });

/** The browser's zone, else UTC. */
export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const COMMON_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

/** Zones to pick from: every one the browser knows, else a short list; always with the ones given. */
export const zoneChoices = (...always: readonly string[]): string[] => {
  let all: string[] = COMMON_ZONES;
  try {
    const known = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (known && known.length > 0) all = known;
  } catch {
    /* The short list. */
  }
  return [...new Set([...always.filter(Boolean), ...all])];
};

/** "America/Chicago" → "Chicago (CDT)". */
export const zoneLabel = (zone: string): string => `${(zone.split("/").pop() ?? zone).replace(/_/g, " ")} (${zoneShort(zone)})`;

/** "in 2 days", "in 5 hours", for how long something is held. */
export const untilWords = (at: string, now = Date.now()): string => {
  const minutes = Math.round((Date.parse(at) - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
};

/** The instant a wall-clock time ("2026-10-14T10:00") is in a zone. */
export const instantIn = (local: string, zone: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  /* How far the zone is from UTC at an instant: its wall clock then, read as UTC, minus the instant. */
  const offsetAt = (at: number): number => {
    const parts = formatter(zone, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
    const part = (type: string) => Number(parts.find((one) => one.type === type)?.value ?? 0);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute")) - at;
  };
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
};
