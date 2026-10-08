import {
  CALENDAR_KINDS,
  CALENDAR_STATUSES,
  calendarEntryInputSchema,
  calendarEnd,
  calendarStart,
  isDateOnly,
  type CalendarEvent,
  type CalendarKind,
  type CalendarStatus,
  type Principal,
} from "@freebirdai/dash-spec";
import type { CalendarListOptions, CalendarStore } from "./store.js";

/**
 * What people do to the calendar by hand: add an entry, change it, mark it
 * done or cancelled, remove one they added. The routes and the chat both come
 * through here, so the rules are in one place:
 *
 * - A person's change to a workflow's entry pins it: later runs of that
 *   workflow leave it where they put it.
 * - An appointment is changed through its booking, never here, so the
 *   calendar can never say something the booking does not.
 * - Only entries a person added are removed. A workflow's entry is cancelled
 *   instead, so what it did stays on record.
 */

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CalendarError";
  }
}

const validTime = (value: string): boolean => isDateOnly(value) || !Number.isNaN(Date.parse(value));

/** Parse the query string a list is asked with. */
export const listOptionsOf = (query: Record<string, string | undefined>): CalendarListOptions => {
  const words = (value: string | undefined): string[] => (value ?? "").split(",").map((one) => one.trim()).filter(Boolean);
  const kinds = words(query["kind"]).filter((one): one is CalendarKind => (CALENDAR_KINDS as readonly string[]).includes(one));
  const statuses = words(query["status"]).filter((one): one is CalendarStatus => (CALENDAR_STATUSES as readonly string[]).includes(one));
  const owners = words(query["owner"]);
  const from = query["from"] && validTime(query["from"]) ? query["from"] : undefined;
  const to = query["to"] && validTime(query["to"]) ? query["to"] : undefined;
  const limit = Number(query["limit"]);
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(owners.length > 0 ? { owners } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(statuses.length > 0 ? { statuses } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
  };
};

export class CalendarService {
  constructor(
    private readonly deps: {
      readonly store: CalendarStore;
      readonly now: () => number;
      readonly newId: () => string;
    },
  ) {}

  list(options: CalendarListOptions = {}): Promise<CalendarEvent[]> {
    return this.deps.store.list(options);
  }

  async get(id: string): Promise<CalendarEvent> {
    const held = await this.deps.store.get(id);
    if (!held) throw new CalendarError(`There is no calendar entry "${id}".`, 404);
    return held;
  }

  /** Add an entry by hand. Yours unless it names an agent or another member. */
  async create(principal: Principal, body: unknown): Promise<CalendarEvent> {
    const input = this.input(body);
    const at = this.iso();
    const event: CalendarEvent = {
      id: `cal-${this.deps.newId()}`,
      title: input.title,
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      at: input.at,
      ...(input.end ? { end: input.end } : {}),
      allDay: input.allDay ?? isDateOnly(input.at),
      kind: input.kind ?? "event",
      status: "open",
      owner: input.owner ?? { kind: "member", id: principal.userId },
      ...(input.source ? { source: input.source } : {}),
      pinned: false,
      createdBy: principal.userId,
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.store.put(event);
    return event;
  }

  /** Change an entry. A workflow's entry is pinned by the change. */
  async update(_principal: Principal, id: string, body: unknown): Promise<CalendarEvent> {
    const held = await this.get(id);
    this.refuseAppointment(held);
    const input = this.input({ title: held.title, at: held.at, ...(body && typeof body === "object" ? body : {}) });
    const changed: CalendarEvent = {
      ...held,
      title: input.title,
      at: input.at,
      allDay: input.allDay ?? (input.at !== held.at ? isDateOnly(input.at) : held.allDay),
      kind: input.kind ?? held.kind,
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.source ? { source: input.source } : {}),
      pinned: held.pinned || held.workflow !== undefined,
      updatedAt: this.iso(),
    };
    const has = (key: string) => body !== null && typeof body === "object" && key in body;
    /* `end` and `notes` are cleared by sending them empty. */
    if (has("end")) {
      if (input.end) changed.end = input.end;
      else delete changed.end;
    }
    if (has("notes")) {
      if (input.notes?.trim()) changed.notes = input.notes.trim();
      else delete changed.notes;
    }
    this.checkTimes(changed);
    await this.deps.store.put(changed);
    return changed;
  }

  /** Done, cancelled, or open again. */
  async setStatus(_principal: Principal, id: string, status: unknown): Promise<CalendarEvent> {
    if (status !== "open" && status !== "done" && status !== "cancelled") throw new CalendarError('Say { status: "done" }, "cancelled" or "open".');
    const held = await this.get(id);
    this.refuseAppointment(held);
    const changed: CalendarEvent = { ...held, status, pinned: held.pinned || held.workflow !== undefined, updatedAt: this.iso() };
    await this.deps.store.put(changed);
    return changed;
  }

  /** Remove an entry a person added. A workflow's entry is cancelled instead, so the record of what it did stays. */
  async remove(_principal: Principal, id: string): Promise<{ removed: true; id: string }> {
    const held = await this.get(id);
    this.refuseAppointment(held);
    if (held.workflow) throw new CalendarError("A workflow made this entry. Cancel it instead, so what the workflow did stays on record.", 409);
    await this.deps.store.delete(id);
    return { removed: true, id };
  }

  private refuseAppointment(held: CalendarEvent): void {
    if (held.kind === "appointment" || held.booking) {
      throw new CalendarError("This is an appointment. Change it from its booking, so the booking page and the calendar agree.", 409);
    }
  }

  private input(body: unknown) {
    const parsed = calendarEntryInputSchema.safeParse(body);
    if (!parsed.success) throw new CalendarError(parsed.error.issues.map((one) => one.message).join(" "));
    const input = parsed.data;
    if (!validTime(input.at)) throw new CalendarError(`"${input.at}" is not a date or a time.`);
    if (input.end && !validTime(input.end)) throw new CalendarError(`"${input.end}" is not a date or a time.`);
    this.checkTimes(input);
    return input;
  }

  private checkTimes(event: { readonly at: string; readonly end?: string | undefined }): void {
    if (event.end && calendarEnd(event) < calendarStart(event)) throw new CalendarError("An entry cannot end before it starts.");
  }

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }
}
