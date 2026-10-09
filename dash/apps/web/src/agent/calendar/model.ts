import { isDateOnly, ownerKey, type AgentSpec, type CalendarEvent, type CalendarKind } from "@freebirdai/dash-spec";

/**
 * The calendar's arithmetic, in the reader's own time zone.
 *
 * Everything here works in local wall time through `Date`'s local fields, so
 * "the next day" is the next calendar day even across a daylight-saving
 * change, when it is 23 or 25 hours away. Kept free of React so it can be
 * tested on its own.
 */

export const CALENDAR_VIEWS = ["month", "week", "agenda"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const VIEW_LABELS: Readonly<Record<CalendarView, string>> = { month: "Month", week: "Week", agenda: "Agenda" };

/** How far ahead the agenda reads. */
export const AGENDA_DAYS = 30;

/** At most this many entries in a month cell before "+N more". */
export const MONTH_CELL_ENTRIES = 3;

/** Local midnight of the day `ms` falls on. */
export const startOfDay = (ms: number): number => {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};

/** `n` calendar days later (or earlier), at the same wall time. */
export const addDays = (ms: number, n: number): number => {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + n, day.getHours(), day.getMinutes(), day.getSeconds()).getTime();
};

/** The same day `n` months later, kept inside the month: 31 January plus a month is 28 or 29 February. */
export const addMonths = (ms: number, n: number): number => {
  const day = new Date(ms);
  const target = new Date(day.getFullYear(), day.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(day.getDate(), last)).getTime();
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of the local day. */
export const dayKey = (ms: number): string => {
  const day = new Date(ms);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
};

/** Local midnight of a `YYYY-MM-DD`. */
export const dayOf = (key: string): number => {
  const [year, month, date] = key.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date).getTime();
};

/** Monday of the week `ms` is in: the working week is what most of these entries are about. */
export const startOfWeek = (ms: number): number => {
  const day = startOfDay(ms);
  return addDays(day, -((new Date(day).getDay() + 6) % 7));
};

export const startOfMonth = (ms: number): number => {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), 1).getTime();
};

/** The local midnights a view shows. A month is always six weeks, so the grid never changes height. */
export const viewDays = (view: CalendarView, anchor: number): number[] => {
  const first = view === "month" ? startOfWeek(startOfMonth(anchor)) : view === "week" ? startOfWeek(anchor) : startOfDay(anchor);
  const count = view === "month" ? 42 : view === "week" ? 7 : AGENDA_DAYS;
  return Array.from({ length: count }, (_, index) => addDays(first, index));
};

/** The instants a view reads entries for: [its first day's midnight, the midnight after its last). */
export const viewRange = (view: CalendarView, anchor: number): { from: string; to: string } => {
  const days = viewDays(view, anchor);
  return { from: new Date(days[0]!).toISOString(), to: new Date(addDays(days[days.length - 1]!, 1)).toISOString() };
};

/** The anchor one period on or back. */
export const stepAnchor = (view: CalendarView, anchor: number, direction: -1 | 1): number =>
  view === "month" ? addMonths(anchor, direction) : addDays(anchor, direction * (view === "week" ? 7 : AGENDA_DAYS));

/** What the toolbar calls the period, the way the reader's locale writes a range: "October 2026", "Oct 12 – 18, 2026". */
export const periodLabel = (view: CalendarView, anchor: number, locale?: string): string => {
  if (view === "month") return new Date(anchor).toLocaleDateString(locale, { month: "long", year: "numeric" });
  const days = viewDays(view, anchor);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).formatRange(new Date(days[0]!), new Date(days[days.length - 1]!));
};

/* ── entries ───────────────────────────────────────────────────────────── */

const localDate = (value: string): number => dayOf(value.trim());

/** Whether an entry is a whole day (or days) rather than a time. */
export const isAllDay = (event: Pick<CalendarEvent, "at" | "allDay">): boolean => event.allDay || isDateOnly(event.at);

/** An entry's start, local. A plain date is that day's local midnight. */
export const entryStart = (event: Pick<CalendarEvent, "at">): number => (isDateOnly(event.at) ? localDate(event.at) : Date.parse(event.at));

/**
 * An entry's end, local. A plain end date is the last day it covers, so a
 * three-day entry reads "14 – 16 October" the way a person would write it.
 */
export const entryEnd = (event: Pick<CalendarEvent, "at" | "end">): number => {
  const end = event.end?.trim();
  if (!end) return entryStart(event);
  return isDateOnly(end) ? localDate(end) : Date.parse(end);
};

/** The local days an entry covers, capped so one with a broken end date cannot fill a month. */
export const entryDayKeys = (event: Pick<CalendarEvent, "at" | "end" | "allDay">, cap = 42): string[] => {
  const start = entryStart(event);
  if (Number.isNaN(start)) return [];
  const end = Math.max(entryEnd(event), start);
  /* A timed entry that ends at midnight does not reach into the next day. */
  const last = isAllDay(event) ? startOfDay(end) : startOfDay(end > start ? end - 1 : end);
  const keys: string[] = [];
  for (let day = startOfDay(start); day <= last && keys.length < cap; day = addDays(day, 1)) keys.push(dayKey(day));
  return keys;
};

/** All-day entries first, then by start, then by title. */
export const compareEntries = (a: CalendarEvent, b: CalendarEvent): number =>
  Number(isAllDay(b)) - Number(isAllDay(a)) || entryStart(a) - entryStart(b) || a.title.localeCompare(b.title);

/** Entries by the local day they fall on, for the days given. */
export const byDay = (entries: readonly CalendarEvent[], days: readonly number[]): Map<string, CalendarEvent[]> => {
  const out = new Map<string, CalendarEvent[]>(days.map((day) => [dayKey(day), []]));
  for (const entry of entries) {
    for (const key of entryDayKeys(entry)) out.get(key)?.push(entry);
  }
  for (const list of out.values()) list.sort(compareEntries);
  return out;
};

const time = (ms: number, locale?: string): string => new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

/** "All day", "9:00 AM", or "9:00 AM – 10:30 AM". */
export const timeLabel = (event: Pick<CalendarEvent, "at" | "end" | "allDay">, locale?: string): string => {
  if (isAllDay(event)) return "All day";
  const start = entryStart(event);
  const end = entryEnd(event);
  return end > start ? `${time(start, locale)} – ${time(end, locale)}` : time(start, locale);
};

/**
 * The short time a chip leads with, in the reader's own clock: "9am" and
 * "10:30pm" where the clock has a day period, "09:00" and "14:30" where it
 * runs to 24.
 */
export const shortTime = (event: Pick<CalendarEvent, "at">, locale?: string): string => {
  const parts = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).formatToParts(new Date(entryStart(event)));
  const period = parts.find((part) => part.type === "dayPeriod");
  if (!period) return parts.map((part) => part.value).join("");
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}${minute === "00" ? "" : `:${minute}`}${period.value.replace(/[\s.]/g, "").toLowerCase()}`;
};

/** "9am – 10:30am": a timed entry's span in the short clock, for the week grid. */
export const shortSpan = (event: Pick<CalendarEvent, "at" | "end">, locale?: string): string => {
  const start = entryStart(event);
  const end = entryEnd(event);
  const first = shortTime({ at: new Date(start).toISOString() }, locale);
  return end > start ? `${first} – ${shortTime({ at: new Date(end).toISOString() }, locale)}` : first;
};

/* ── owners ────────────────────────────────────────────────────────────── */

export interface Person {
  readonly name: string;
  /** 1–8, a series slot. */
  readonly color: number;
}

/** A member's colour until they choose one: a stable slot from their id. */
export const memberColor = (id: string): number => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % 8) + 1;
};

export interface OwnerInfo {
  readonly key: string;
  readonly kind: "agent" | "member" | "none";
  readonly name: string;
  /** 1–8, or 0 for an entry nobody owns. */
  readonly color: number;
}

export const NO_OWNER = "none";

/** Who an entry belongs to, named and coloured. */
export const ownerOf = (
  event: Pick<CalendarEvent, "owner">,
  agents: ReadonlyMap<string, Pick<AgentSpec, "name" | "color">>,
  people: ReadonlyMap<string, Person>,
  me?: string,
): OwnerInfo => {
  const owner = event.owner;
  if (!owner) return { key: NO_OWNER, kind: "none", name: "Unassigned", color: 0 };
  const key = ownerKey(owner)!;
  if (owner.kind === "agent") {
    const agent = agents.get(owner.id);
    return { key, kind: "agent", name: agent?.name ?? "Removed agent", color: agent?.color ?? 0 };
  }
  const person = people.get(owner.id);
  return { key, kind: "member", name: owner.id === me ? `${person?.name ?? "You"}${person ? " (you)" : ""}` : (person?.name ?? owner.id), color: person?.color ?? memberColor(owner.id) };
};

/** The CSS colour for a series slot, or the neutral axis colour for none. */
export const colorVar = (color: number): string => (color >= 1 && color <= 8 ? `var(--dash-series-${Math.round(color)})` : "var(--dash-axis)");

/* ── filters ───────────────────────────────────────────────────────────── */

export interface CalendarFilter {
  /** Owner keys switched off in the legend. */
  readonly hidden: ReadonlySet<string>;
  readonly kinds: ReadonlySet<CalendarKind>;
  readonly showDone: boolean;
  readonly showCancelled: boolean;
}

export const DEFAULT_FILTER: CalendarFilter = {
  hidden: new Set(),
  kinds: new Set<CalendarKind>(["event", "deadline", "appointment"]),
  showDone: true,
  showCancelled: false,
};

export const keepEntry = (event: CalendarEvent, filter: CalendarFilter): boolean =>
  !filter.hidden.has(ownerKey(event.owner) ?? NO_OWNER) &&
  filter.kinds.has(event.kind) &&
  (event.status !== "done" || filter.showDone) &&
  (event.status !== "cancelled" || filter.showCancelled);

/** The owners with entries in what was read, agents first, each with how many entries they have. */
export const legendOf = (
  entries: readonly CalendarEvent[],
  owners: (event: CalendarEvent) => OwnerInfo,
): Array<OwnerInfo & { readonly count: number }> => {
  const counts = new Map<string, OwnerInfo & { count: number }>();
  for (const entry of entries) {
    const owner = owners(entry);
    const held = counts.get(owner.key);
    if (held) held.count += 1;
    else counts.set(owner.key, { ...owner, count: 1 });
  }
  const rank = { agent: 0, member: 1, none: 2 } as const;
  return [...counts.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
};

/** Words for a status, where one is worth showing. */
export const STATUS_LABELS: Readonly<Record<CalendarEvent["status"], string>> = {
  open: "Scheduled",
  tentative: "Pending",
  done: "Done",
  cancelled: "Cancelled",
};

export const KIND_LABELS: Readonly<Record<CalendarKind, string>> = {
  event: "Event",
  deadline: "Deadline",
  appointment: "Appointment",
};
