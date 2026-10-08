import { z } from "zod";
import { ownerRefSchema } from "./workflow.js";

/**
 * The calendar: entries agents, workflows, bookings and people put on it.
 *
 * One entry is one thing at one time: an event, a deadline, or an
 * appointment a booking holds. Workflow entries carry where they came from
 * (`workflow`, `case`, `task`) and a `dedupeKey`, so the same record matching
 * again moves its entry rather than making another. A person's edit to a
 * workflow's entry sets `pinned`, and later runs leave it where they put it.
 *
 * Stored entries written before this shape (`deadline: true`, no `kind` or
 * `status`) still read: `upgradeCalendarEvent` fills them in.
 */

export const CALENDAR_KINDS = ["event", "deadline", "appointment"] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

/**
 * - `open`: on the calendar, still to happen or happening.
 * - `tentative`: held but not settled: a pending or suggested appointment.
 * - `done`: happened, or no longer needed (the record it was about moved on).
 * - `cancelled`: will not happen. Kept, so the history stays.
 */
export const CALENDAR_STATUSES = ["open", "tentative", "done", "cancelled"] as const;
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

/** The record an entry is about, opened through the `entity` route. */
export const calendarSourceSchema = z.object({
  connection: z.string().min(1),
  entity: z.string().min(1),
  recordId: z.string().min(1),
  parents: z.record(z.string()).optional(),
});
export type CalendarSource = z.infer<typeof calendarSourceSchema>;

/** Fills in what older stored entries lack: `deadline: true` becomes `kind: "deadline"`. */
export const upgradeCalendarEvent = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const one = value as Record<string, unknown>;
  if (one["kind"] !== undefined) return value;
  const { deadline, ...rest } = one;
  return { ...rest, kind: deadline === true ? "deadline" : "event" };
};

const calendarEventShape = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().max(4000).optional(),
  /** ISO date (all day) or date-time. */
  at: z.string().min(1),
  end: z.string().optional(),
  allDay: z.boolean().default(false),
  kind: z.enum(CALENDAR_KINDS).default("event"),
  status: z.enum(CALENDAR_STATUSES).default("open"),
  /** Whose it is: an agent's entries wear its colour, a member's are theirs. */
  owner: ownerRefSchema.optional(),
  source: calendarSourceSchema.optional(),
  /** The workflow, run, case and step task that made it. */
  workflow: z.string().optional(),
  run: z.string().optional(),
  case: z.string().optional(),
  task: z.string().optional(),
  /** For a workflow's entry: the workflow's record key, so a record that stops matching can close its entries. */
  rowKey: z.string().optional(),
  /** `<workflow>:<row key>:<step id>`: the same record matching again moves this entry. */
  dedupeKey: z.string().max(600).optional(),
  /** A person changed it by hand: later runs leave it alone. */
  pinned: z.boolean().default(false),
  /** For an appointment: the booking it draws. */
  booking: z.string().optional(),
  /** The member who added it by hand. */
  createdBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

export const calendarEventSchema = z.preprocess(upgradeCalendarEvent, calendarEventShape);
export type CalendarEvent = z.infer<typeof calendarEventShape>;

/** What a person sends to add or change an entry by hand. The server owns the id, the dates and who added it. */
export const calendarEntryInputSchema = z.object({
  title: z.string().trim().min(1, "Give the entry a title.").max(200),
  notes: z.string().max(4000).optional(),
  at: z.string().min(1, "Say when it is."),
  end: z.string().optional(),
  allDay: z.boolean().optional(),
  kind: z.enum(["event", "deadline"]).optional(),
  owner: ownerRefSchema.optional(),
  source: calendarSourceSchema.optional(),
});
export type CalendarEntryInput = z.infer<typeof calendarEntryInputSchema>;

/* ── time ─────────────────────────────────────────────────────────────── */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a value is a plain date, with no time. */
export const isDateOnly = (value: string): boolean => DATE_ONLY.test(value.trim());

/**
 * An entry's start as milliseconds. A plain date is read as midnight UTC of
 * that date: it is a day, not an instant, and the reader places it on that
 * day in their own zone (`calendarDayKey`).
 */
export const calendarStart = (event: Pick<CalendarEvent, "at">): number => {
  const at = event.at.trim();
  return isDateOnly(at) ? Date.parse(`${at}T00:00:00.000Z`) : Date.parse(at);
};

/** An entry's end as milliseconds: its `end`, or its start (a deadline or a point in time). */
export const calendarEnd = (event: Pick<CalendarEvent, "at" | "end">): number => {
  const end = event.end?.trim();
  if (!end) return calendarStart(event);
  return isDateOnly(end) ? Date.parse(`${end}T00:00:00.000Z`) : Date.parse(end);
};

/** The sortable form a store keeps an entry's start under: an ISO instant in UTC. */
export const calendarSortKey = (value: string): string => {
  const at = value.trim();
  if (isDateOnly(at)) return `${at}T00:00:00.000Z`;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? at : new Date(ms).toISOString();
};

/**
 * Whether an entry falls in [from, to). Timed entries by their instants; an
 * all-day entry by its dates, padded a day either side because the reader's
 * day may begin up to a day away from UTC's. The reader trims to its own days.
 */
export const calendarOverlaps = (event: Pick<CalendarEvent, "at" | "end" | "allDay">, from?: string, to?: string): boolean => {
  const day = 86_400_000;
  const allDay = event.allDay || isDateOnly(event.at);
  const start = calendarStart(event);
  const end = Math.max(calendarEnd(event), start);
  const lo = from ? Date.parse(from) - (allDay ? day : 0) : -Infinity;
  const hi = to ? Date.parse(to) + (allDay ? day : 0) : Infinity;
  if (Number.isNaN(start)) return false;
  /* A point in time is in the range when it is at or after `from` and before `to`. */
  if (end === start) return start >= lo && start < hi;
  return start < hi && end > lo;
};

/** The owner as one string, for filters: `agent:<id>` or `member:<id>`. */
export const ownerKey = (owner: { readonly kind: string; readonly id: string } | undefined): string | undefined =>
  owner ? `${owner.kind}:${owner.id}` : undefined;
