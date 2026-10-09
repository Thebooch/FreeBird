import type { CalendarEntryInput, CalendarEvent } from "@freebirdai/dash-spec";
import { dayKey, entryEnd, entryStart, isAllDay, startOfDay } from "./model.js";

/**
 * The entry form's fields, and the conversion to and from what the server
 * takes. A person thinks in a date and two times on a clock; the server keeps
 * instants (or a plain date for a whole day). The conversion is here, apart
 * from the form, so it can be tested.
 */
export interface EntryForm {
  readonly title: string;
  readonly kind: "event" | "deadline";
  readonly allDay: boolean;
  /** `YYYY-MM-DD`, local. */
  readonly date: string;
  /** For a whole-day entry over several days: the last day, `YYYY-MM-DD`. */
  readonly endDate: string;
  /** `HH:MM`, local. */
  readonly start: string;
  readonly end: string;
  /** `member:<id>` or `agent:<id>`. */
  readonly owner: string;
  readonly notes: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const clock = (ms: number): string => {
  const at = new Date(ms);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

/** A new entry at a moment: from the next half hour, an hour long; at nine when it was a whole day that was picked. */
export const blankForm = (at: number, owner: string, whole = false): EntryForm => {
  const day = startOfDay(at);
  /* Now is rarely a time anybody books: the next half hour is. */
  const half = 30 * 60_000;
  const date = new Date(day);
  const timed = whole ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9).getTime() : Math.ceil(at / half) * half;
  const start = new Date(timed);
  return {
    title: "",
    kind: "event",
    allDay: false,
    date: dayKey(day),
    endDate: "",
    start: clock(start.getTime()),
    end: clock(new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours() + 1, start.getMinutes()).getTime()),
    owner,
    notes: "",
  };
};

/** An entry's fields, for editing it. */
export const formOf = (entry: CalendarEvent, fallbackOwner: string): EntryForm => {
  const start = entryStart(entry);
  const end = entryEnd(entry);
  const whole = isAllDay(entry);
  return {
    title: entry.title,
    kind: entry.kind === "deadline" ? "deadline" : "event",
    allDay: whole,
    date: dayKey(start),
    endDate: whole && entry.end && dayKey(end) !== dayKey(start) ? dayKey(end) : "",
    start: whole ? "09:00" : clock(start),
    end: whole ? "10:00" : end > start ? clock(end) : clock(start + 3_600_000),
    owner: entry.owner ? `${entry.owner.kind}:${entry.owner.id}` : fallbackOwner,
    notes: entry.notes ?? "",
  };
};

const localAt = (date: string, time: string): number => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return new Date(year, month - 1, day, hours, minutes).getTime();
};

const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TIME = /^\d{2}:\d{2}$/;

/** What the server is sent, or what is wrong, in words the form shows. */
export const inputOf = (form: EntryForm): { readonly ok: true; readonly input: CalendarEntryInput } | { readonly ok: false; readonly error: string } => {
  const title = form.title.trim();
  if (!title) return { ok: false, error: "Give the entry a title." };
  if (!VALID_DATE.test(form.date)) return { ok: false, error: "Pick a date." };
  const [kind, id] = form.owner.split(":") as [string, string | undefined];
  const owner = id && (kind === "agent" || kind === "member") ? { kind: kind as "agent" | "member", id } : undefined;
  const base = { title, kind: form.kind, ...(owner ? { owner } : {}), notes: form.notes.trim() };

  if (form.allDay) {
    if (form.endDate && !VALID_DATE.test(form.endDate)) return { ok: false, error: "Pick the last day, or leave it empty." };
    if (form.endDate && form.endDate < form.date) return { ok: false, error: "The last day comes before the first." };
    const end = form.endDate && form.endDate !== form.date ? form.endDate : "";
    return { ok: true, input: { ...base, at: form.date, end, allDay: true } };
  }

  if (!VALID_TIME.test(form.start)) return { ok: false, error: "Pick a start time." };
  const start = localAt(form.date, form.start);
  /* A deadline is a moment: it has no end. */
  if (form.kind === "deadline") return { ok: true, input: { ...base, at: new Date(start).toISOString(), end: "", allDay: false } };
  if (!VALID_TIME.test(form.end)) return { ok: false, error: "Pick an end time." };
  const end = localAt(form.date, form.end);
  if (end <= start) return { ok: false, error: "It ends before it starts. For something that runs past midnight, make it a whole-day entry." };
  return { ok: true, input: { ...base, at: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay: false } };
};
