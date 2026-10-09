import { idSchema } from "@freebirdai/connect-spec";
import { z } from "zod";
import { BOOKING_EVENTS } from "./booking-events.js";
import { LOCATION_KINDS, consolidationSchema, schedulingSettingsSchema } from "./scheduling.js";

/**
 * Bookings: an appointment someone asked for, from the request to the end.
 *
 * A booking holds time on a host's calendar while it is **pending** (a
 * request waiting for approval, until `holdUntil`), **suggested** (the team
 * offered other times, each held), or **confirmed** (with any change waiting
 * for approval held too). Every other status holds nothing.
 *
 * `BookingService` on the server is the only code that changes a booking,
 * and every change writes a `BookingEvent` in the same transaction: the
 * outbox workflows and waiting cases hear it from.
 */

export const BOOKING_STATUSES = ["pending", "confirmed", "suggested", "denied", "cancelled", "expired", "completed", "no_show"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Statuses that hold time. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ["pending", "confirmed", "suggested"];

export const BOOKING_STATUS_WORDS: Readonly<Record<BookingStatus, string>> = {
  pending: "Pending",
  confirmed: "Confirmed",
  suggested: "New time suggested",
  denied: "Denied",
  cancelled: "Cancelled",
  expired: "Expired",
  completed: "Completed",
  no_show: "No-show",
};

export { BOOKING_EVENTS, BOOKING_EVENT_WORDS, type BookingEventKind } from "./booking-events.js";

export const BOOKING_ORIGINS = ["link", "public_link", "agent", "workflow", "member"] as const;
export type BookingOrigin = (typeof BOOKING_ORIGINS)[number];

export const bookingActorSchema = z.object({
  kind: z.enum(["contact", "member", "agent", "workflow", "system"]),
  id: z.string().optional(),
});
export type BookingActor = z.infer<typeof bookingActorSchema>;

/** The settings a booking was made under, every layer resolved: what it keeps to even if the setup changes. */
export const resolvedSettingsSchema = schedulingSettingsSchema.extend({
  consolidate: consolidationSchema.optional(),
  maxPerDay: z.number().int().min(1).max(200).optional(),
});

const instant = z.string().refine((value) => Number.isFinite(Date.parse(value)), "An instant, like 2026-10-14T15:00:00.000Z.");

export const bookingSuggestionSchema = z.object({
  id: z.string().min(1).max(40),
  start: instant,
  end: instant,
  host: z.string().min(1),
  holdUntil: instant,
});
export type BookingSuggestion = z.infer<typeof bookingSuggestionSchema>;

export const bookingSchema = z.object({
  id: z.string().min(1),
  type: z.object({ id: z.string(), version: z.number().int().positive(), name: z.string() }),
  settings: resolvedSettingsSchema,
  contact: z.string().min(1),
  /** The record it is about (a work order), when known. */
  subject: z.object({ connection: idSchema, entity: z.string(), recordId: z.string() }).optional(),
  host: z.string().min(1),
  pool: z.string().optional(),
  start: instant,
  end: instant,
  /** The block it came under; for a blank one, what it set the occurrence to. */
  block: z.string().optional(),
  placement: z.string().optional(),
  occurrence: z.string().optional(),
  /** The contact's time zone, for showing them times. */
  timezone: z.string(),
  location: z.object({ kind: z.enum(LOCATION_KINDS), value: z.string().max(300).optional() }).optional(),
  status: z.enum(BOOKING_STATUSES),
  /** Pending: the slot is held until then. */
  holdUntil: instant.optional(),
  /** Suggested: the times a member offered, each held. */
  suggestions: z.array(bookingSuggestionSchema).max(10).optional(),
  /** A move waiting for approval; the confirmed time stays held meanwhile. */
  change: z.object({ start: instant, end: instant, host: z.string(), holdUntil: instant }).optional(),
  decision: z
    .object({
      outcome: z.enum(["approved", "suggested", "denied"]),
      by: z.string(),
      at: instant,
      /** For the team only; never shown or sent to the person who booked. */
      reason: z.string().max(1000).optional(),
      /** For the person who booked. */
      message: z.string().max(1000).optional(),
    })
    .optional(),
  /** Answers given for this booking (`request.*`). */
  answers: z.record(z.unknown()).default({}),
  /** The booking's facts, normalized, for grouping and stacking later bookings with it. */
  values: z.record(z.string()).default({}),
  origin: z.enum(BOOKING_ORIGINS),
  agent: z.string().optional(),
  /** The link token it came through. */
  link: z.string().optional(),
  reschedules: z.number().int().nonnegative().default(0),
  history: z
    .array(
      z.object({
        at: instant,
        status: z.enum(BOOKING_STATUSES),
        event: z.enum(BOOKING_EVENTS).optional(),
        by: bookingActorSchema,
        note: z.string().max(500).optional(),
      }),
    )
    .default([]),
  revision: z.number().int().positive().default(1),
  createdAt: instant,
  updatedAt: instant,
});
export type Booking = z.infer<typeof bookingSchema>;

export const bookingEventSchema = z.object({
  /** `<booking>:<revision>:<kind>`: the same change written twice is one event. */
  id: z.string().min(1),
  booking: z.string().min(1),
  kind: z.enum(BOOKING_EVENTS),
  at: instant,
  /** The type, for triggers that take some types only; and what the event is about. */
  type: z.string(),
  payload: z.record(z.unknown()).default({}),
});
export type BookingEvent = z.infer<typeof bookingEventSchema>;

/* ── what a booking holds ──────────────────────────────────────────────── */

export interface BookingHold {
  readonly host: string;
  readonly start: number;
  readonly end: number;
  /** The booking's own time, as opposed to a suggestion or a change waiting for approval. */
  readonly own: boolean;
}

/** The time a booking keeps from others: its own while pending or confirmed, a pending move's, and each suggestion's. */
export const holdsOf = (booking: Pick<Booking, "status" | "host" | "start" | "end" | "suggestions" | "change">): BookingHold[] => {
  const at = (value: string) => Date.parse(value);
  switch (booking.status) {
    case "pending":
      return [{ host: booking.host, start: at(booking.start), end: at(booking.end), own: true }];
    case "confirmed":
      return [
        { host: booking.host, start: at(booking.start), end: at(booking.end), own: true },
        ...(booking.change ? [{ host: booking.change.host, start: at(booking.change.start), end: at(booking.change.end), own: false }] : []),
      ];
    case "suggested":
      return (booking.suggestions ?? []).map((one) => ({ host: one.host, start: at(one.start), end: at(one.end), own: false }));
    default:
      return [];
  }
};

/**
 * When something about a booking next falls due by itself: a pending hold
 * running out, a suggestion or a change running out, or a confirmed
 * appointment ending. None for a booking that is over.
 */
export const dueAt = (booking: Pick<Booking, "status" | "holdUntil" | "suggestions" | "change" | "end">): string | undefined => {
  const times: string[] = [];
  if (booking.status === "pending" && booking.holdUntil) times.push(booking.holdUntil);
  if (booking.status === "suggested") times.push(...(booking.suggestions ?? []).map((one) => one.holdUntil));
  if (booking.status === "confirmed") {
    times.push(booking.end);
    if (booking.change) times.push(booking.change.holdUntil);
  }
  return times.length === 0 ? undefined : times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
};
