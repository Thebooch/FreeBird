import { withTransient, type ActionDefinition, type ActionPreflightResult, type ComponentDefinition } from "@freebirdai/core";
import { BOOKING_STATUSES, BOOKING_STATUS_WORDS, type Booking, type BookingStatus, type Principal } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { BookingLinks } from "../../bookings/links.js";
import type { BookingService } from "../../bookings/service.js";
import type { ContactService } from "../../contacts/service.js";
import type { SchedulingOverview } from "../../scheduling/service.js";
import type { TaskStore } from "../../workflows/store.js";
import { SCREENS, actor, allowedTo, argsOf, blocked, findBy, landed, listed, screenComponent, type ScreenAccess } from "./common.js";

/**
 * Bookings (on the calendar, `#/agent/calendar`): finding open times, booking
 * for a contact, and every decision the booking sheet offers — confirm, deny,
 * offer other times, cancel, move, give to another host, mark how it went —
 * and the links it hands out. Each goes through `BookingService`, which
 * re-checks the time under the hosts' locks, as the sheet's buttons do.
 */

export interface BookingsDeps extends ScreenAccess {
  readonly setup: SchedulingOverview;
  readonly bookings: BookingService;
  readonly contacts: ContactService;
  readonly links: BookingLinks;
  readonly tasks: TaskStore;
}

const SCREEN = SCREENS.bookings;
const MANAGE = "Your role here does not allow deciding on bookings.";
const DAY = 86_400_000;

const current = z.string().optional().describe("Filled in by the system with what the booking is now; leave it out.");

/** "Tue, Oct 13, 9:00 AM–9:30 AM (America/Chicago)". */
export const whenOf = (start: string, end: string | undefined, zone: string): string => {
  const at = new Date(start);
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(at);
  const time = (value: Date) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(value);
  return `${day}, ${time(at)}${end ? `–${time(new Date(end))}` : ""} (${zone})`;
};

const hostName = (setup: SchedulingOverview, member: string): string => setup.profiles.find((one) => one.member === member)?.displayName ?? member;

export const bookingsScreen = (deps: BookingsDeps): ComponentDefinition => {
  const { setup, bookings, contacts } = deps;
  const manage = allowedTo(deps, "calendar.manage", MANAGE);
  const by = (principal: Principal) => ({ kind: "member" as const, id: principal.userId });

  const contactName = async (id: string): Promise<string> => (await contacts.get(id))?.name || id;
  const summary = async (booking: Booking): Promise<string> =>
    `${await contactName(booking.contact)} · ${booking.type.name} with ${hostName(setup, booking.host)} · ${whenOf(booking.start, booking.end, booking.timezone)} · ${BOOKING_STATUS_WORDS[booking.status]}`;

  /** A booking by id, with its summary for the card, or why it cannot be found. */
  const resolveBooking = async (id: string): Promise<ActionPreflightResult> => {
    try {
      const booking = await bookings.get(id);
      return { ok: true, resolvedArgs: { current: await summary(booking) } };
    } catch {
      return blocked("booking", `There is no booking "${id}". list_bookings shows them with their ids.`);
    }
  };

  /** A contact by id, name, email or phone: exactly one, or what to ask. */
  const resolveContact = async (key: string): Promise<{ id: string; name: string } | { problem: string }> => {
    const held = await contacts.get(key);
    if (held) return { id: held.id, name: held.name || held.id };
    const { contacts: found } = await contacts.list({ search: key, limit: 6 });
    if (found.length === 1) return { id: found[0]!.id, name: found[0]!.name || found[0]!.id };
    if (found.length === 0) return { problem: `No contact matches "${key}". Add them under Contacts first.` };
    return { problem: `Several contacts match "${key}": ${found.map((one) => `${one.name || "(no name)"} (${one.id})`).join(", ")}. Say which.` };
  };
  const findType = (key: string) => findBy(setup.types, key, (one) => [one.id, one.name, one.slug]);
  const findHost = (key: string) => findBy(setup.profiles, key, (one) => [one.member, one.displayName, one.email]);

  const list: ActionDefinition<{ from?: string; days?: number; status?: BookingStatus[]; host?: string; contact?: string }, unknown, unknown> = {
    id: "list_bookings",
    description: "Read bookings: in a window, by status (pending ones wait for a decision), for one host or one contact. Each with its id, type, contact, host, time and status.",
    schema: z.object({
      from: z.string().optional().describe("ISO date or date-time to start from. Default: now."),
      days: z.number().int().min(1).max(92).optional().describe("How many days ahead. Default 14."),
      status: z.array(z.enum(BOOKING_STATUSES)).optional().describe("Only these statuses, like ['pending']."),
      host: z.string().optional().describe("Only one host's, by name or id."),
      contact: z.string().optional().describe("Only one contact's, by id."),
    }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    handler: async (args) => {
      const from = args.from && Number.isFinite(Date.parse(args.from)) ? Date.parse(args.from) : deps.now();
      const host = args.host ? findHost(args.host)?.member : undefined;
      const found = await bookings.list({ from, to: from + (args.days ?? 14) * DAY, ...(host ? { host } : {}), ...(args.contact ? { contact: args.contact } : {}), ...(args.status && args.status.length > 0 ? { statuses: args.status } : {}), limit: 100 });
      return { count: found.length, bookings: await Promise.all(found.map(async (one) => ({ id: one.id, summary: await summary(one), status: one.status, start: one.start, holdUntil: one.holdUntil }))) };
    },
  };

  const findTimes: ActionDefinition<{ type: string; contact: string; from?: string; days?: number; all?: boolean }, unknown, unknown> = {
    id: "find_times",
    description: "Open times for a type and a contact, as they would be offered (their rules, blocks, notice and limits applied), or why the type does not take them.",
    schema: z.object({
      type: z.string().min(1).describe("The type, by name or id."),
      contact: z.string().min(1).describe("The contact, by id, name, email or phone."),
      from: z.string().optional().describe("ISO date or date-time to start from. Default: now."),
      days: z.number().int().min(1).max(62).optional().describe("How many days to look at. Default 14."),
      all: z.boolean().optional().describe("Every open time rather than the ones grouped first."),
    }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    handler: async (args) => {
      const type = findType(args.type);
      if (!type) return { error: `There is no type "${args.type}". Types: ${listed(setup.types.map((one) => one.name))}.` };
      const contact = await resolveContact(args.contact);
      if ("problem" in contact) return { error: contact.problem };
      const from = args.from && Number.isFinite(Date.parse(args.from)) ? Date.parse(args.from) : deps.now();
      const found = await bookings.slotsFor(type.id, contact.id, { from, to: from + (args.days ?? 14) * DAY, ...(args.all ? { all: true } : {}) });
      return {
        type: type.name,
        contact: contact.name,
        ...found,
        slots: found.slots.slice(0, 40).map((slot) => ({
          start: new Date(slot.start).toISOString(),
          end: new Date(slot.end).toISOString(),
          hosts: slot.options.map((option) => hostName(setup, option.host)),
          needsApproval: slot.approval,
          groupedWithOthers: slot.consolidated,
        })),
      };
    },
  };

  const book: ActionDefinition<{ type: string; contact: string; start: string; host?: string; answers?: Record<string, unknown>; needsApproval?: boolean; contactName?: string }, unknown, unknown> = {
    id: "book_for_contact",
    description: "Book an appointment for a contact at an open time from find_times: confirmed, unless needsApproval. Shown on a card first.",
    schema: argsOf(
      z.object({
        type: z.string().min(1).describe("The type, by name or id."),
        contact: z.string().min(1).describe("The contact, by id, name, email or phone."),
        start: z.string().min(1).describe("When it starts: an instant from find_times, like 2026-10-13T14:00:00.000Z."),
        host: z.string().optional().describe("A host, by name or id. Default: the type's host, or the pool's rule."),
        answers: z.record(z.unknown()).optional().describe("Answers to the type's questions, like { partySize: 4 }."),
        needsApproval: z.boolean().optional().describe("Ask for approval rather than booking outright."),
        contactName: z.string().optional().describe("Filled in by the system; leave it out."),
      }),
    ),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      if (!findType(args.type)) return blocked("type", `There is no type "${args.type}". Types: ${listed(setup.types.map((one) => one.name))}.`);
      if (args.host && !findHost(args.host)) return blocked("host", `"${args.host}" is not a host. Hosts: ${listed(setup.profiles.map((one) => one.displayName))}.`);
      if (!Number.isFinite(Date.parse(args.start))) return blocked("start", "Say when as an instant from find_times.");
      const contact = await resolveContact(args.contact);
      if ("problem" in contact) return blocked("contact", contact.problem);
      return { ok: true, resolvedArgs: { contact: contact.id, contactName: contact.name } };
    },
    preview: (args) => {
      const type = findType(args.type);
      const host = args.host ? findHost(args.host) : null;
      const zone = host?.timezone ?? setup.profiles[0]?.timezone ?? "UTC";
      return {
        title: `Book ${type?.name ?? args.type} for ${args.contactName ?? args.contact}`,
        summary: args.needsApproval ? "Held pending approval." : "Confirmed straight away.",
        rows: [
          { label: "When", value: Number.isFinite(Date.parse(args.start)) ? whenOf(args.start, undefined, zone) : args.start },
          { label: "With", value: host?.displayName ?? "The type's host, or the pool's rule" },
          ...(args.answers && Object.keys(args.answers).length > 0 ? [{ label: "Answers", value: Object.entries(args.answers).map(([key, value]) => `${key}: ${String(value)}`).join("; ") }] : []),
        ],
      };
    },
    handler: async (args, ctx) => {
      const type = findType(args.type);
      const made = await bookings.request({
        type: type?.id ?? args.type,
        contact: args.contact,
        start: Date.parse(args.start),
        ...(args.host ? { host: findHost(args.host)?.member ?? args.host } : {}),
        ...(args.answers ? { answers: args.answers } : {}),
        approval: args.needsApproval ? "always" : "skip",
        origin: "member",
        by: by(actor(ctx)),
      });
      deps.changed();
      return landed({ booked: made.outcome, id: made.booking.id }, SCREEN, { title: `${made.booking.type.name}, ${args.contactName ?? "booking"}`, item: made.booking.id, summary: `${made.outcome === "confirmed" ? "Booked" : "Asked for"} ${await summary(made.booking)}.` });
    },
  };

  /** One decision on a booking: the card names it, the service decides it. */
  const decision = <A extends { booking: string; current?: string }>(spec: {
    id: string;
    description: string;
    schema: z.ZodTypeAny;
    title: (args: A) => string;
    note: string;
    rows?: (args: A) => Array<{ label: string; value: string }>;
    /** A booking, or a booking and values to show the person once (a link that is a key). */
    run: (args: A, principal: Principal) => Promise<Booking | { booking: Booking; once: Record<string, string> }>;
    said: (booking: Booking) => string;
  }): ActionDefinition<A, unknown, unknown> => ({
    id: spec.id,
    description: `${spec.description} Shown on a card first.`,
    schema: argsOf<A>(spec.schema),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => resolveBooking(args.booking),
    preview: (args) => ({ title: spec.title(args), summary: spec.note, rows: [...(args.current ? [{ label: "Booking", value: args.current }] : []), ...(spec.rows?.(args) ?? [])] }),
    handler: async (args, ctx) => {
      const out = await spec.run(args, actor(ctx));
      const booking = "once" in out ? out.booking : out;
      deps.changed();
      const result = landed({ id: booking.id, status: booking.status }, SCREEN, { title: `${booking.type.name}, ${await contactName(booking.contact)}`, item: booking.id, summary: spec.said(booking) });
      return "once" in out ? withTransient(result, out.once) : result;
    },
  });

  const bookingId = z.string().min(1).describe("The booking's id, from list_bookings.");

  const confirm = decision<{ booking: string; message?: string; current?: string }>({
    id: "confirm_booking",
    description: "Approve a pending booking (or a move waiting for approval).",
    schema: z.object({ booking: bookingId, message: z.string().max(1000).optional().describe("A note to them, sent with the confirmation."), current }),
    title: () => "Confirm this booking",
    note: "They are told it is confirmed.",
    rows: (args) => (args.message ? [{ label: "Note to them", value: args.message }] : []),
    run: (args, principal) => bookings.confirm(args.booking, by(principal), args.message ? { message: args.message } : {}),
    said: (booking) => `Confirmed: ${booking.type.name}, ${whenOf(booking.start, booking.end, booking.timezone)}.`,
  });

  const deny = decision<{ booking: string; reason?: string; message?: string; current?: string }>({
    id: "deny_booking",
    description: "Turn down a pending booking; its time is released.",
    schema: z.object({ booking: bookingId, reason: z.string().max(500).optional().describe("Why, for the record."), message: z.string().max(1000).optional().describe("What they are told."), current }),
    title: () => "Deny this booking",
    note: "Its time is released and they are told.",
    rows: (args) => [...(args.reason ? [{ label: "Why", value: args.reason }] : []), ...(args.message ? [{ label: "They are told", value: args.message }] : [])],
    run: (args, principal) => bookings.deny(args.booking, by(principal), { ...(args.reason ? { reason: args.reason } : {}), ...(args.message ? { message: args.message } : {}) }),
    said: (booking) => `Denied the ${booking.type.name} request.`,
  });

  const suggest = decision<{ booking: string; times: Array<{ start: string; host?: string }>; message?: string; reason?: string; outsideHours?: boolean; current?: string }>({
    id: "offer_other_times",
    description: "Offer the person other times instead of the one they asked for, each held for them until they answer.",
    schema: z.object({
      booking: bookingId,
      times: z.array(z.object({ start: z.string().min(1).describe("An instant from find_times."), host: z.string().optional() }).strict()).min(1).max(10).describe("The times to offer."),
      message: z.string().max(1000).optional().describe("What they are told."),
      reason: z.string().max(500).optional().describe("Why, for the record."),
      outsideHours: z.boolean().optional().describe("Allow times outside open hours."),
      current,
    }),
    title: () => "Offer other times",
    note: "Each time is held for them until they answer.",
    rows: (args) => [{ label: "Times", value: args.times.map((one) => (Number.isFinite(Date.parse(one.start)) ? new Date(one.start).toISOString().slice(0, 16).replace("T", " ") + " UTC" : one.start)).join("; ") }, ...(args.message ? [{ label: "They are told", value: args.message }] : [])],
    run: (args, principal) =>
      bookings.suggest(
        args.booking,
        by(principal),
        args.times.map((one) => ({ start: Date.parse(one.start), ...(one.host ? { host: findHost(one.host)?.member ?? one.host } : {}) })),
        { ...(args.message ? { message: args.message } : {}), ...(args.reason ? { reason: args.reason } : {}), allowOutside: args.outsideHours === true },
      ),
    said: () => "Offered other times.",
  });

  const cancel = decision<{ booking: string; reason?: string; current?: string }>({
    id: "cancel_booking",
    description: "Cancel a booking, or release a pending hold.",
    schema: z.object({ booking: bookingId, reason: z.string().max(500).optional().describe("Why, for the record and their notice."), current }),
    title: () => "Cancel this booking",
    note: "Its time is released and they are told.",
    rows: (args) => (args.reason ? [{ label: "Why", value: args.reason }] : []),
    run: (args, principal) => bookings.cancel(args.booking, by(principal), args.reason ? { reason: args.reason } : {}),
    said: (booking) => `Cancelled the ${booking.type.name}.`,
  });

  const move = decision<{ booking: string; start: string; host?: string; current?: string }>({
    id: "move_booking",
    description: "Move a booking to another open time (and host).",
    schema: z.object({ booking: bookingId, start: z.string().min(1).describe("The new start: an instant from find_times."), host: z.string().optional().describe("Another host, by name or id."), current }),
    title: () => "Move this booking",
    note: "The new time is checked again before it moves.",
    rows: (args) => [{ label: "To", value: `${Number.isFinite(Date.parse(args.start)) ? new Date(args.start).toISOString().slice(0, 16).replace("T", " ") + " UTC" : args.start}${args.host ? ` with ${findHost(args.host)?.displayName ?? args.host}` : ""}` }],
    run: (args, principal) => bookings.move(args.booking, by(principal), { start: Date.parse(args.start), ...(args.host ? { host: findHost(args.host)?.member ?? args.host } : {}) }),
    said: (booking) => `Moved it to ${whenOf(booking.start, booking.end, booking.timezone)}.`,
  });

  const reassign = decision<{ booking: string; host?: string; current?: string }>({
    id: "reassign_booking",
    description: "Give a booking to another host at the same time: one named, or the next by the pool's rule.",
    schema: z.object({ booking: bookingId, host: z.string().optional().describe("The new host, by name or id. Left out: the next by the pool's rule."), current }),
    title: (args) => `Give this booking to ${args.host ? (findHost(args.host)?.displayName ?? args.host) : "the next host"}`,
    note: "Same time; the new host must be free.",
    run: (args, principal) => bookings.assign(args.booking, by(principal), args.host ? (findHost(args.host)?.member ?? args.host) : undefined),
    said: (booking) => `It is now with ${hostName(setup, booking.host)}.`,
  });

  const mark = decision<{ booking: string; as: "completed" | "no_show"; current?: string }>({
    id: "mark_booking",
    description: "Record how an appointment went: completed, or a no-show.",
    schema: z.object({ booking: bookingId, as: z.enum(["completed", "no_show"]), current }),
    title: (args) => `Mark it ${args.as === "completed" ? "completed" : "a no-show"}`,
    note: "Counted on the contact.",
    run: (args, principal) => bookings.mark(args.booking, by(principal), args.as),
    said: (booking) => `Marked it ${BOOKING_STATUS_WORDS[booking.status].toLowerCase()}.`,
  });

  const pageLink = decision<{ booking: string; current?: string }>({
    id: "booking_page_link",
    description: "Make the contact's own page for this booking, where they see it and can cancel or reschedule: a new link to send them.",
    schema: z.object({ booking: bookingId, current }),
    title: () => "Make a link to this booking's page",
    note: "A new link; anyone holding it sees this booking. Shown to you once, to copy.",
    run: async (args) => {
      const booking = await bookings.get(args.booking);
      return { booking, once: { link: await deps.links.bookingLink(booking) } };
    },
    said: () => "Made a link to the booking's page. It is shown once, to copy.",
  });

  const approvalLink = decision<{ booking: string; current?: string }>({
    id: "approval_link",
    description: "Make a link to answer a pending booking's approval request from a phone, without signing in.",
    schema: z.object({ booking: bookingId, current }),
    title: () => "Make an approval link for this booking",
    note: "It works until the request is answered or expires.",
    run: async (args, principal) => {
      const booking = await bookings.get(args.booking);
      const waiting = (await deps.tasks.list({ status: "waiting", limit: 500 })).find((one) => one.body.kind === "booking" && one.body.booking === booking.id);
      if (!waiting) throw new Error("Nothing is waiting for an answer on this booking.");
      const deadline = waiting.wait?.deadline ?? booking.holdUntil ?? new Date(deps.now() + DAY).toISOString();
      return { booking, once: { link: await deps.links.approvalLink({ id: waiting.id, attempt: waiting.attempt }, booking, principal.userId, deadline) } };
    },
    said: () => "Made an approval link. It is shown once, to copy.",
  });

  return screenComponent(
    SCREEN,
    ["BOOKINGS: list_bookings finds them (status pending = waiting for a decision). find_times gives the instants book_for_contact, move_booking and offer_other_times take."],
    [list, findTimes, book, confirm, deny, suggest, cancel, move, reassign, mark, pageLink, approvalLink],
  );
};
