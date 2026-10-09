import {
  ACTIVE_BOOKING_STATUSES,
  durationMs,
  holdsOf,
  type AppointmentType,
  type Booking,
  type BookingActor,
  type BookingEventKind,
  type BookingOrigin,
  type BookingStatus,
  type CalendarEvent,
  type CalendarStatus,
} from "@freebirdai/dash-spec";
import type { CalendarStore } from "../calendar/store.js";
import type { ContactService } from "../contacts/service.js";
import { assignHost } from "../scheduling/assign.js";
import { factString, type Facts } from "../scheduling/rules.js";
import type { SchedulingService, SlotContext } from "../scheduling/service.js";
import { typeEligibility, type Busy, type HostOption, type Slot } from "../scheduling/slots.js";
import { BookingConflict, type BookingStore, type BookingTx } from "./store.js";

/**
 * Bookings: the only code that changes one.
 *
 * Every change takes the locks of every host it touches, reads the booking
 * and the time it would take fresh, asks the slot engine again whether that
 * time is still open (with every block, capacity, buffer and limit), and
 * writes the booking and its event together. Whatever the event sets off —
 * a workflow, a waiting case, a message — happens after, from the outbox.
 *
 * The calendar mirrors each booking with appointment entries owned by its
 * host: tentative while pending, suggested or waiting on a move; open once
 * confirmed; cancelled or done after.
 */

export class BookingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** For a time that was taken: what is open nearby instead. */
    readonly slots?: readonly Slot[],
  ) {
    super(message);
    this.name = "BookingError";
  }
}

export interface BookingDeps {
  readonly store: BookingStore;
  readonly scheduling: SchedulingService;
  readonly contacts: ContactService;
  readonly calendar: CalendarStore;
  readonly now: () => number;
  readonly newId: () => string;
  /** Called after each change is written, to deliver its events now rather than on the next pass. */
  readonly afterChange?: () => void;
  /**
   * Whether anyone will be asked to approve a request of this type: an
   * enabled workflow that starts on its requests. Absent: not checked.
   */
  readonly approvalAsked?: (type: string) => Promise<boolean>;
}

export interface RequestInput {
  /** An appointment type's id or booking page address. */
  readonly type: string;
  readonly contact: string;
  readonly start: number;
  /** A host they picked, or the member booking for themselves. Absent: the type's host, or the pool's rule. */
  readonly host?: string;
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly origin: BookingOrigin;
  readonly by: BookingActor;
  readonly agent?: string;
  readonly link?: string;
  readonly subject?: Booking["subject"];
  /** `type` follows the type's rules; `always` asks for approval regardless; `skip` books outright. */
  readonly approval?: "type" | "always" | "skip";
  /** A shorter hold than the type's. Never longer. */
  readonly holdFor?: string;
  /** The contact's time zone, when they said. */
  readonly timezone?: string;
  /** For a step that may run twice: the same id finds the booking the first run made. */
  readonly id?: string;
}

const DAY = 86_400_000;
const ms = (value: string | undefined): number => durationMs(value) ?? 0;
const iso = (at: number): string => new Date(at).toISOString();

/** The time a booking takes on one host, as the slot engine reads it. */
export const bookingBusy = (booking: Booking, host: string): Busy[] =>
  holdsOf(booking)
    .filter((hold) => hold.host === host)
    .map((hold) => ({
      start: hold.start,
      end: hold.end,
      kind: "booking" as const,
      buffer: ms(booking.settings.buffer),
      values: booking.values,
      ...(hold.own && booking.placement ? { placement: booking.placement } : {}),
      ...(hold.own && booking.occurrence ? { occurrence: booking.occurrence } : {}),
      ...(hold.own && booking.block ? { block: booking.block } : {}),
    }));

/** Every host's bookings as busy time, for `SchedulingDeps.bookings`. */
export const bookingsAsBusy =
  (store: BookingStore) =>
  async (member: string, from: number, to: number): Promise<Busy[]> =>
    (await store.holding(member, from, to)).flatMap((booking) => bookingBusy(booking, member));

/** The same, read inside a change's locks and leaving the changing booking out. */
const busyIn =
  (tx: BookingTx, leaveOut?: string) =>
  async (member: string, from: number, to: number): Promise<Busy[]> =>
    (await tx.holding(member, from, to)).filter((booking) => booking.id !== leaveOut).flatMap((booking) => bookingBusy(booking, member));

/** A booking's facts as comparable strings by path, so later bookings can be grouped or stacked with it. */
export const valuesOf = (facts: Facts): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (value: unknown, path: string, depth: number) => {
    const text = factString(facts, path);
    if (text !== undefined && text.length <= 300) out[path] = text;
    if (depth < 3 && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) if (key !== "stats") walk(inner, `${path}.${key}`, depth + 1);
    }
  };
  for (const root of ["contact", "request"]) {
    const scope = facts.scope[root];
    if (scope && typeof scope === "object") for (const [key, value] of Object.entries(scope as Record<string, unknown>)) if (key !== "stats") walk(value, `${root}.${key}`, 1);
  }
  return out;
};

const ENTRY_STATUS: Readonly<Record<BookingStatus, CalendarStatus>> = {
  pending: "tentative",
  suggested: "cancelled",
  confirmed: "open",
  denied: "cancelled",
  cancelled: "cancelled",
  expired: "cancelled",
  completed: "done",
  no_show: "done",
};

export class BookingService {
  constructor(private readonly deps: BookingDeps) {}

  /* ── reading ─────────────────────────────────────────────────────────── */

  async get(id: string): Promise<Booking> {
    const booking = await this.deps.store.get(id);
    if (!booking) throw new BookingError("There is no such booking.", 404);
    return booking;
  }

  list(query: Parameters<BookingStore["list"]>[0] = {}): Promise<Booking[]> {
    return this.deps.store.list(query);
  }

  private async typeOf(key: string): Promise<AppointmentType> {
    const type = await this.deps.scheduling.findType(key);
    if (!type) throw new BookingError(`There is no appointment type "${key}".`, 404);
    return type;
  }

  /** The contact's facts with this booking's answers and its type: what rules read. */
  async factsFor(contact: string, type: AppointmentType, answers: Readonly<Record<string, unknown>> = {}): Promise<Facts> {
    const facts = await this.deps.contacts.facts(contact);
    return { ...facts, scope: { ...facts.scope, request: { ...answers }, type: { id: type.id, name: type.name } } };
  }

  /** Open times for a type, as one contact would be offered them. */
  async slotsFor(typeKey: string, contact: string, range: { readonly from: number; readonly to: number; readonly all?: boolean }): Promise<Awaited<ReturnType<SchedulingService["slots"]>>> {
    const type = await this.typeOf(typeKey);
    return this.deps.scheduling.slots(type, await this.factsFor(contact, type), { ...range, limit: 300 });
  }

  /** The open slot starting exactly then, if any. */
  private async slotAt(type: AppointmentType, facts: Facts, start: number): Promise<Slot | undefined> {
    const result = await this.deps.scheduling.slots(type, facts, { from: start, to: start + DAY, all: true });
    return result.slots.find((slot) => slot.start === start);
  }

  /**
   * Whether a host is open at exactly that time, inside a change's locks:
   * the context was read before the locks, and only bookings are read here,
   * through the transaction.
   */
  private async openIn(tx: BookingTx, context: SlotContext, facts: Facts, start: number, host: string, leaveOut?: string): Promise<HostOption | undefined> {
    const busy = await busyIn(tx, leaveOut)(host, start - DAY, start + 2 * DAY);
    const result = this.deps.scheduling.slotsIn(context, facts, { from: start, to: start + DAY, all: true }, new Map([[host, busy]]));
    return result.slots.find((slot) => slot.start === start)?.options.find((one) => one.host === host);
  }

  /** Open times near one that was taken, to offer instead. */
  private async nearby(type: AppointmentType, facts: Facts, start: number): Promise<Slot[]> {
    const from = Math.max(this.deps.now(), start - DAY);
    const result = await this.deps.scheduling.slots(type, facts, { from, to: from + 3 * DAY, limit: 12 });
    return [...result.slots].sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start)).slice(0, 6);
  }

  private async pickOption(type: AppointmentType, slot: Slot, contact: string, host?: string): Promise<HostOption | null> {
    if (host) return slot.options.find((one) => one.host === host) ?? null;
    const pool = "pool" in type.hosts ? ((await this.deps.scheduling.findPool(type.hosts.pool)) ?? undefined) : undefined;
    const preferred = (await this.deps.contacts.get(contact))?.preferredHost;
    return assignHost(slot, { ...(pool ? { pool } : {}), ...(preferred ? { preferred } : {}) });
  }

  /* ── asking for a time ───────────────────────────────────────────────── */

  /**
   * A booking for a time: pending (held until `holdUntil`) when it needs
   * approval, confirmed when it doesn't. A time no longer open is refused
   * with open times nearby.
   */
  async request(input: RequestInput): Promise<{ readonly booking: Booking; readonly outcome: "pending" | "confirmed" }> {
    if (input.id) {
      const held = await this.deps.store.get(input.id);
      if (held) return { booking: held, outcome: held.status === "pending" ? "pending" : "confirmed" };
    }
    const type = await this.typeOf(input.type);
    if (!type.active) throw new BookingError(`${type.name} isn't taking bookings.`, 409);
    const contact = await this.deps.contacts.require(input.contact);
    /* How many a person may hold at once. The team, and workflows they set up, aren't limited. */
    if (input.origin !== "member" && input.origin !== "workflow") {
      const active = await this.deps.store.list({ contact: contact.id, statuses: [...ACTIVE_BOOKING_STATUSES], limit: 50 });
      if (active.filter((one) => one.type.id === type.id).length >= type.maxActivePerContact) {
        throw new BookingError(`There's already ${type.maxActivePerContact === 1 ? "a booking" : `${type.maxActivePerContact} bookings`} of ${type.name} for you. Change or cancel ${type.maxActivePerContact === 1 ? "it" : "one"} instead.`, 409);
      }
    }
    const facts = await this.factsFor(contact.id, type, input.answers);
    /* Who can book the type at all, said plainly rather than as "that time isn't open". */
    const who = typeEligibility(type, facts, this.deps.now());
    if (who.verdict === "ineligible") throw new BookingError(type.eligibility.message || `${type.name} isn't something you can book.`, 403);
    if (who.verdict === "unknown") throw new BookingError(`${type.name} needs a few answers before it can be booked.`, 409);
    const slot = await this.slotAt(type, facts, input.start);
    const option = slot ? await this.pickOption(type, slot, contact.id, input.host) : null;
    if (!option) throw new BookingError("That time isn't open.", 409, await this.nearby(type, facts, input.start));

    /* A request that needs approval with nobody to ask would sit until its hold ran out: refused instead, for anyone but the team. */
    const asked = input.origin !== "member" && input.approval !== "skip" && (input.approval === "always" || option.approval);
    if (asked && this.deps.approvalAsked && !(await this.deps.approvalAsked(type.id))) {
      throw new BookingError(`${type.name} needs approval, and nobody is set to approve it right now. Try again later, or contact the team.`, 409);
    }
    const id = input.id ?? `bk-${this.deps.newId()}`;
    const context = await this.deps.scheduling.context(type, input.start, input.start + DAY, [option.host]);
    const timezone = input.timezone ?? contact.timezone ?? (await this.deps.scheduling.findProfile(option.host))?.timezone ?? "UTC";
    const result = await this.deps.store.withHosts([option.host], async (tx) => {
      const held = await tx.get(id);
      if (held) return { booking: held, outcome: held.status === "pending" ? ("pending" as const) : ("confirmed" as const) };
      const fresh = await this.openIn(tx, context, facts, input.start, option.host);
      if (!fresh) return null;
      const needsApproval = input.approval === "skip" ? false : input.approval === "always" ? true : input.origin === "member" ? false : fresh.approval;
      const now = this.deps.now();
      const hold = Math.min(ms(fresh.settings.holdFor), input.holdFor ? ms(input.holdFor) : Number.POSITIVE_INFINITY);
      const status: BookingStatus = needsApproval ? "pending" : "confirmed";
      const booking: Booking = {
        id,
        type: { id: type.id, version: type.version, name: type.name },
        settings: { ...fresh.settings, stackOnlySame: [...fresh.settings.stackOnlySame] } as Booking["settings"],
        contact: contact.id,
        ...(input.subject ? { subject: input.subject } : {}),
        host: option.host,
        ...("pool" in type.hosts ? { pool: type.hosts.pool } : {}),
        start: iso(input.start),
        end: iso(input.start + ms(fresh.settings.length)),
        ...(fresh.block ? { block: fresh.block } : {}),
        ...(fresh.placement ? { placement: fresh.placement } : {}),
        ...(fresh.occurrence ? { occurrence: fresh.occurrence } : {}),
        timezone,
        location: type.location,
        status,
        ...(needsApproval ? { holdUntil: iso(now + Math.max(hold, 60_000)) } : {}),
        answers: { ...(input.answers ?? {}) },
        values: valuesOf(facts),
        origin: input.origin,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.link ? { link: input.link } : {}),
        reschedules: 0,
        history: [{ at: iso(now), status, event: needsApproval ? "requested" : "confirmed", by: input.by }],
        revision: 1,
        createdAt: iso(now),
        updatedAt: iso(now),
      };
      await tx.put(booking);
      const kind: BookingEventKind = needsApproval ? "requested" : "confirmed";
      await tx.event({ id: `${id}:1:${kind}`, booking: id, kind, at: iso(now), type: type.id, payload: { by: input.by } });
      return { booking, outcome: status as "pending" | "confirmed" };
    });
    if (!result) throw new BookingError("That time was just taken.", 409, await this.nearby(type, facts, input.start));
    await this.mirror(result.booking);
    this.deps.afterChange?.();
    return result;
  }

  /* ── changing one ────────────────────────────────────────────────────── */

  /**
   * One change: the locks of every host the booking holds time on (and any
   * it is moving to), a fresh read, `apply`, then the save and its events.
   * A booking that moved to another host between the read and the lock is
   * read again.
   */
  private async transition(
    id: string,
    by: BookingActor,
    apply: (booking: Booking, tx: BookingTx) => Promise<{ next: Booking; events: readonly BookingEventKind[]; payload?: Record<string, unknown>; note?: string } | "unchanged">,
    alsoHosts: readonly string[] = [],
  ): Promise<Booking> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = await this.get(id);
      const hosts = new Set([...holdsOf(before).map((hold) => hold.host), before.host, ...alsoHosts]);
      const done = await this.deps.store.withHosts([...hosts], async (tx) => {
        const booking = await tx.get(id);
        if (!booking) throw new BookingError("There is no such booking.", 404);
        if (booking.revision !== before.revision) return null;
        const change = await apply(booking, tx);
        if (change === "unchanged") return booking;
        const now = this.deps.now();
        const revision = booking.revision + 1;
        const saved: Booking = {
          ...change.next,
          revision,
          updatedAt: iso(now),
          history: [...booking.history, { at: iso(now), status: change.next.status, ...(change.events[0] ? { event: change.events[0] } : {}), by, ...(change.note ? { note: change.note.slice(0, 500) } : {}) }],
        };
        await tx.put(saved, booking.revision);
        for (const kind of change.events) {
          await tx.event({
            id: `${id}:${revision}:${kind}`,
            booking: id,
            kind,
            at: iso(now),
            type: booking.type.id,
            payload: { ...(change.payload ?? {}), previous: booking.status, by },
          });
        }
        return saved;
      }).catch((error: unknown) => {
        if (error instanceof BookingConflict) return null;
        throw error;
      });
      if (done) {
        await this.mirror(done);
        if (done.revision !== before.revision) this.deps.afterChange?.();
        return done;
      }
    }
    throw new BookingError("This booking is changing too often to save. Try again.", 409);
  }

  private refuse(booking: Booking, doing: string): never {
    throw new BookingError(`It can't be ${doing}: it is ${booking.status.replace("_", "-")} now.`, 409);
  }

  /** Approve a request, or a move waiting for approval. Approving one already confirmed changes nothing. */
  async confirm(id: string, by: BookingActor, options: { readonly message?: string } = {}): Promise<Booking> {
    return this.transition(id, by, async (booking) => {
      const now = iso(this.deps.now());
      if (booking.status === "pending") {
        const { holdUntil: _hold, ...rest } = booking;
        return { next: { ...rest, status: "confirmed", decision: { outcome: "approved", by: by.id ?? by.kind, at: now, ...(options.message ? { message: options.message } : {}) } }, events: ["confirmed"] };
      }
      if (booking.status === "confirmed" && booking.change) {
        const { change, ...rest } = booking;
        return {
          next: { ...rest, start: change.start, end: change.end, host: change.host, reschedules: booking.reschedules + 1 },
          events: ["rescheduled"],
          payload: { from: { start: booking.start, end: booking.end, host: booking.host } },
        };
      }
      if (booking.status === "confirmed") return "unchanged";
      return this.refuse(booking, "approved");
    });
  }

  /**
   * Offer other times instead: for a request, or after a denial or the
   * person declining. Each is checked as if the person were asking for it,
   * unless a member chose to offer a time outside the open ones.
   */
  async suggest(
    id: string,
    by: BookingActor,
    times: ReadonlyArray<{ readonly start: number; readonly host?: string }>,
    options: {
      readonly message?: string;
      readonly reason?: string;
      readonly holdFor?: string;
      readonly allowOutside?: boolean;
      /** Only from these statuses: an approval answers a request still pending, never one answered meanwhile. */
      readonly onlyFrom?: readonly BookingStatus[];
    } = {},
  ): Promise<Booking> {
    if (times.length === 0) throw new BookingError("Offer at least one time.");
    if (times.length > 10) throw new BookingError("Offer at most ten times.");
    const current = await this.get(id);
    const hosts = times.map((one) => one.host ?? current.host);
    const type = await this.typeOf(current.type.id);
    const facts = await this.factsFor(current.contact, type, current.answers);
    const contexts = await Promise.all(times.map((time, index) => this.deps.scheduling.context(type, time.start, time.start + DAY, [hosts[index]!])));
    return this.transition(
      id,
      by,
      async (booking, tx) => {
        /* Pending, or turned down or declined already: the team can still offer other times. */
        if (!["pending", "denied", "expired", "cancelled"].includes(booking.status)) return this.refuse(booking, "given other times");
        if (options.onlyFrom && !options.onlyFrom.includes(booking.status)) return this.refuse(booking, "given other times");
        const now = this.deps.now();
        const holdUntil = iso(now + Math.max(Math.min(ms(booking.settings.suggestionHoldFor), options.holdFor ? ms(options.holdFor) : Number.POSITIVE_INFINITY), 60_000));
        const suggestions = [];
        for (const [index, time] of times.entries()) {
          const host = hosts[index]!;
          const open = Boolean(await this.openIn(tx, contexts[index]!, facts, time.start, host, booking.id));
          if (!open && !options.allowOutside) throw new BookingError(`${new Date(time.start).toISOString()} isn't open for that host.`, 409);
          suggestions.push({ id: `s${index + 1}`, start: iso(time.start), end: iso(time.start + ms(booking.settings.length)), host, holdUntil });
        }
        const { holdUntil: _hold, ...rest } = booking;
        return {
          next: {
            ...rest,
            status: "suggested",
            suggestions,
            decision: { outcome: "suggested", by: by.id ?? by.kind, at: iso(now), ...(options.reason ? { reason: options.reason } : {}), ...(options.message ? { message: options.message } : {}) },
          },
          events: ["suggested"],
        };
      },
      hosts,
    );
  }

  /** Turn a request down, or a move waiting for approval (the booking stays where it was). */
  async deny(id: string, by: BookingActor, options: { readonly reason?: string; readonly message?: string } = {}): Promise<Booking> {
    return this.transition(id, by, async (booking) => {
      const at = iso(this.deps.now());
      const decision = { outcome: "denied" as const, by: by.id ?? by.kind, at, ...(options.reason ? { reason: options.reason } : {}), ...(options.message ? { message: options.message } : {}) };
      if (booking.status === "pending") {
        const { holdUntil: _hold, ...rest } = booking;
        return { next: { ...rest, status: "denied", decision }, events: ["denied"] };
      }
      if (booking.status === "confirmed" && booking.change) {
        const { change: _change, ...rest } = booking;
        return { next: { ...rest, decision }, events: ["denied"], payload: { change: true } };
      }
      return this.refuse(booking, "denied");
    });
  }

  /** The person takes one of the times offered: confirmed, with no second approval. */
  async acceptSuggestion(id: string, suggestion: string, by: BookingActor): Promise<Booking> {
    return this.transition(id, by, async (booking) => {
      if (booking.status !== "suggested") return this.refuse(booking, "accepted");
      const picked = booking.suggestions?.find((one) => one.id === suggestion);
      if (!picked) throw new BookingError("That time isn't one of those offered.", 404);
      if (Date.parse(picked.holdUntil) <= this.deps.now()) throw new BookingError("That time is no longer held. Pick another.", 409);
      const { suggestions: _all, ...rest } = booking;
      return { next: { ...rest, status: "confirmed", start: picked.start, end: picked.end, host: picked.host }, events: ["suggestion_accepted", "confirmed"] };
    });
  }

  /** The person turns down every time offered. */
  async declineSuggestions(id: string, by: BookingActor): Promise<Booking> {
    return this.transition(id, by, async (booking) => {
      if (booking.status !== "suggested") return this.refuse(booking, "declined");
      const { suggestions: _all, ...rest } = booking;
      return { next: { ...rest, status: "cancelled" }, events: ["suggestion_declined"] };
    });
  }

  /** Cancel. The person booking can't, online, inside the type's cutoff. */
  async cancel(id: string, by: BookingActor, options: { readonly reason?: string } = {}): Promise<Booking> {
    return this.transition(id, by, async (booking) => {
      if (!["pending", "suggested", "confirmed"].includes(booking.status)) return this.refuse(booking, "cancelled");
      if (by.kind === "contact" && booking.status === "confirmed" && Date.parse(booking.start) - this.deps.now() < ms(booking.settings.cancelCutoff)) {
        throw new BookingError("It's too close to the time to cancel online. Contact the team.", 409);
      }
      const { holdUntil: _hold, suggestions: _suggestions, change: _change, ...rest } = booking;
      return { next: { ...rest, status: "cancelled" }, events: ["cancelled"], payload: options.reason ? { reason: options.reason } : {}, ...(options.reason ? { note: options.reason } : {}) };
    });
  }

  /**
   * Move to another time (and host). A confirmed booking the person moves
   * waits for approval when the new time needs it, keeping its time
   * meanwhile; a pending one moves and is held again; a suggested one is
   * asked for again at the new time.
   */
  async move(id: string, by: BookingActor, to: { readonly start: number; readonly host?: string }, options: { readonly approval?: "type" | "always" | "skip" } = {}): Promise<Booking> {
    const current = await this.get(id);
    const type = await this.typeOf(current.type.id);
    const facts = await this.factsFor(current.contact, type, current.answers);
    const slot = await this.slotAt(type, facts, to.start);
    const option = slot ? ((to.host ? slot.options.find((one) => one.host === to.host) : slot.options.find((one) => one.host === current.host)) ?? (await this.pickOption(type, slot, current.contact))) : null;
    if (!option) throw new BookingError("That time isn't open.", 409, await this.nearby(type, facts, to.start));
    const context = await this.deps.scheduling.context(type, to.start, to.start + DAY, [option.host]);
    return this.transition(
      id,
      by,
      async (booking, tx) => {
        if (!["pending", "suggested", "confirmed"].includes(booking.status)) return this.refuse(booking, "moved");
        const now = this.deps.now();
        if (by.kind === "contact" && booking.status === "confirmed") {
          if (Date.parse(booking.start) - now < ms(booking.settings.rescheduleCutoff)) throw new BookingError("It's too close to the time to move it online. Contact the team.", 409);
          if (booking.reschedules >= booking.settings.maxReschedules) throw new BookingError("It has been moved as many times as it can be online. Contact the team.", 409);
        }
        const fresh = await this.openIn(tx, context, facts, to.start, option.host, booking.id);
        if (!fresh) throw new BookingError("That time was just taken.", 409);
        const needsApproval = options.approval === "skip" ? false : options.approval === "always" ? true : by.kind === "member" ? false : fresh.approval;
        const start = iso(to.start);
        const end = iso(to.start + ms(booking.settings.length));
        const holdUntil = iso(now + Math.max(ms(booking.settings.holdFor), 60_000));
        const where = {
          start,
          end,
          host: option.host,
          ...(fresh.block ? { block: fresh.block } : {}),
          ...(fresh.placement ? { placement: fresh.placement } : {}),
          ...(fresh.occurrence ? { occurrence: fresh.occurrence } : {}),
        };
        const { block: _block, placement: _placement, occurrence: _occurrence, holdUntil: _hold, suggestions: _suggestions, change: _change, ...rest } = booking;
        const from = { start: booking.start, end: booking.end, host: booking.host };
        if (booking.status === "confirmed" && needsApproval) {
          return { next: { ...booking, change: { start, end, host: option.host, holdUntil } }, events: ["reschedule_requested"], payload: { to: { start, end, host: option.host } } };
        }
        if (booking.status === "confirmed") {
          return { next: { ...rest, ...where, status: "confirmed", reschedules: booking.reschedules + (by.kind === "contact" ? 1 : 0) }, events: ["rescheduled"], payload: { from } };
        }
        if (booking.status === "pending") {
          return { next: { ...rest, ...where, status: "pending", holdUntil }, events: ["rescheduled"], payload: { from } };
        }
        /* Suggested: asked for again, at the time they picked. */
        return needsApproval
          ? { next: { ...rest, ...where, status: "pending", holdUntil }, events: ["requested"], payload: { from } }
          : { next: { ...rest, ...where, status: "confirmed" }, events: ["confirmed"], payload: { from } };
      },
      [option.host],
    );
  }

  /** Give it to another host at the same time: one named, or the next by the pool's rule. */
  async assign(id: string, by: BookingActor, toHost?: string): Promise<Booking> {
    const current = await this.get(id);
    if (!["pending", "confirmed"].includes(current.status)) this.refuse(current, "given to someone else");
    const type = await this.typeOf(current.type.id);
    const facts = await this.factsFor(current.contact, type, current.answers);
    const start = Date.parse(current.start);
    const slot = await this.slotAt(type, facts, start);
    const others = slot ? { ...slot, options: slot.options.filter((one) => one.host !== current.host) } : undefined;
    const option = others ? (toHost ? (others.options.find((one) => one.host === toHost) ?? null) : await this.pickOption(type, others, current.contact)) : null;
    if (!option) throw new BookingError(toHost ? "They aren't free then." : "Nobody else is free then.", 409);
    const context = await this.deps.scheduling.context(type, start, start + DAY, [option.host]);
    return this.transition(
      id,
      by,
      async (booking, tx) => {
        if (!["pending", "confirmed"].includes(booking.status)) return this.refuse(booking, "given to someone else");
        const fresh = await this.openIn(tx, context, facts, start, option.host, booking.id);
        if (!fresh) throw new BookingError("They were just booked then.", 409);
        const { block: _block, placement: _placement, occurrence: _occurrence, ...rest } = booking;
        return {
          next: { ...rest, host: option.host, ...(fresh.block ? { block: fresh.block } : {}), ...(fresh.placement ? { placement: fresh.placement } : {}), ...(fresh.occurrence ? { occurrence: fresh.occurrence } : {}) },
          events: ["rescheduled"],
          payload: { from: { start: booking.start, end: booking.end, host: booking.host } },
        };
      },
      [option.host],
    );
  }

  /** Mark it done or a no-show: once it is confirmed, or up to a week after it ended. */
  async mark(id: string, by: BookingActor, as: "completed" | "no_show"): Promise<Booking> {
    return this.transition(id, by, async (booking) => {
      const recent = booking.status === "completed" && this.deps.now() - Date.parse(booking.end) <= 7 * DAY;
      if (booking.status !== "confirmed" && !recent) return this.refuse(booking, `marked ${as === "completed" ? "completed" : "a no-show"}`);
      if (booking.status === as) return "unchanged";
      const { change: _change, ...rest } = booking;
      return { next: { ...rest, status: as }, events: [as] };
    });
  }

  /* ── by itself, over time ────────────────────────────────────────────── */

  /**
   * What has fallen due: a pending hold that ran out expires; suggestions
   * that ran out are dropped, and the booking expires when none are left; a
   * move waiting too long is dropped; a confirmed appointment that has ended
   * is completed. Returns how many bookings changed.
   */
  async settleDue(limit = 100): Promise<number> {
    let changed = 0;
    for (const due of await this.deps.store.due(this.deps.now(), limit)) {
      try {
        const after = await this.transition(due.id, { kind: "system" }, async (booking) => {
          const now = this.deps.now();
          const past = (at: string | undefined) => at !== undefined && Date.parse(at) <= now;
          if (booking.status === "pending" && past(booking.holdUntil)) {
            const { holdUntil: _hold, ...rest } = booking;
            return { next: { ...rest, status: "expired" }, events: ["expired"], note: "Nobody answered before the hold ran out." };
          }
          if (booking.status === "suggested") {
            const left = (booking.suggestions ?? []).filter((one) => !past(one.holdUntil));
            if (left.length === (booking.suggestions ?? []).length) return "unchanged";
            if (left.length === 0) {
              const { suggestions: _all, ...rest } = booking;
              return { next: { ...rest, status: "expired" }, events: ["expired"], note: "The times offered ran out." };
            }
            return { next: { ...booking, suggestions: left }, events: [] };
          }
          if (booking.status === "confirmed") {
            if (past(booking.end)) {
              const { change: _change, ...rest } = booking;
              return { next: { ...rest, status: "completed" }, events: ["completed"] };
            }
            if (booking.change && past(booking.change.holdUntil)) {
              const { change: _change, ...rest } = booking;
              return { next: rest, events: [], note: "The move waited too long for an answer." };
            }
          }
          return "unchanged";
        });
        if (after.revision !== due.revision) changed++;
      } catch {
        /* One booking that can't settle now is tried again on the next pass. */
      }
    }
    return changed;
  }

  /* ── the calendar ────────────────────────────────────────────────────── */

  /**
   * The booking's entries on its host's calendar: one for its own time, one
   * per suggested time, one for a move waiting for approval. Entries for
   * times it no longer holds are removed. Safe to run any number of times.
   */
  async mirror(booking: Booking): Promise<void> {
    const contact = await this.deps.contacts.get(booking.contact);
    const who = contact?.name || contact?.emails[0] || "someone";
    const now = iso(this.deps.now());
    const base = {
      kind: "appointment" as const,
      allDay: false,
      booking: booking.id,
      createdBy: "booking",
      createdAt: now,
      updatedAt: now,
      pinned: false,
    };
    const wanted: Array<CalendarEvent & { dedupeKey: string }> = [
      {
        ...base,
        id: `cal-${booking.id}`,
        dedupeKey: `booking:${booking.id}`,
        title: `${booking.type.name} · ${who}`,
        notes: `${booking.status === "pending" ? "Waiting for approval. " : ""}${Object.entries(booking.answers)
          .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
          .join("\n")}`.trim(),
        at: booking.start,
        end: booking.end,
        status: ENTRY_STATUS[booking.status],
        owner: { kind: "member", id: booking.host },
      },
      ...(booking.status === "suggested"
        ? (booking.suggestions ?? []).map((one) => ({
            ...base,
            id: `cal-${booking.id}-${one.id}`,
            dedupeKey: `booking:${booking.id}:${one.id}`,
            title: `Offered: ${booking.type.name} · ${who}`,
            notes: "A time offered instead, held until they answer.",
            at: one.start,
            end: one.end,
            status: "tentative" as const,
            owner: { kind: "member" as const, id: one.host },
          }))
        : []),
      ...(booking.status === "confirmed" && booking.change
        ? [
            {
              ...base,
              id: `cal-${booking.id}-change`,
              dedupeKey: `booking:${booking.id}:change`,
              title: `Move requested: ${booking.type.name} · ${who}`,
              notes: "They asked to move here. The booking keeps its time until this is approved.",
              at: booking.change.start,
              end: booking.change.end,
              status: "tentative" as const,
              owner: { kind: "member" as const, id: booking.change.host },
            },
          ]
        : []),
    ];
    for (const entry of wanted) await this.deps.calendar.upsertByKey(entry);
    const keep = new Set(wanted.map((one) => one.dedupeKey));
    for (const stale of await this.deps.calendar.list({ booking: booking.id, limit: 100 })) {
      if (stale.dedupeKey && !keep.has(stale.dedupeKey)) await this.deps.calendar.delete(stale.id);
    }
  }
}
