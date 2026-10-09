/**
 * What can happen to a booking: what its outbox carries and what a
 * workflow's `booking` trigger listens for. Kept apart from `booking.ts` so
 * the workflow spec can read it without importing scheduling.
 */
export const BOOKING_EVENTS = [
  "requested",
  "confirmed",
  "suggested",
  "denied",
  "suggestion_accepted",
  "suggestion_declined",
  "reschedule_requested",
  "rescheduled",
  "cancelled",
  "expired",
  "completed",
  "no_show",
  /** Not a booking's: someone the type's "Who can book" rules turned away, once a day per person and type. */
  "turned_away",
] as const;
export type BookingEventKind = (typeof BOOKING_EVENTS)[number];

/** Each event as the end of "When a Visit …". */
export const BOOKING_EVENT_WORDS: Readonly<Record<BookingEventKind, string>> = {
  requested: "is requested",
  confirmed: "is confirmed",
  suggested: "gets other times offered",
  denied: "is denied",
  suggestion_accepted: "has an offered time accepted",
  suggestion_declined: "has the offered times declined",
  reschedule_requested: "has a move asked for",
  rescheduled: "is moved",
  cancelled: "is cancelled",
  expired: "runs out",
  completed: "is completed",
  no_show: "is marked a no-show",
  turned_away: "is turned away",
};
