import { fieldValueOf, type Booking } from "@freebirdai/dash-spec";
import type { ContactService } from "../contacts/service.js";
import type { SchedulingService } from "../scheduling/service.js";
import type { WorkflowBookings } from "../workflows/env.js";
import type { BookingService } from "./service.js";

/**
 * A booking as workflow steps read it.
 *
 * A case a booking starts has the booking as its row, so every template can
 * say `{{ contact.name }}`, `{{ when }}`, `{{ type.name }}`, `{{ host.name }}`
 * and `{{ link }}`, and `{{ id }}` is the booking itself. Times are in the
 * contact's own zone, the way they will read them.
 */

/** "Tue, Oct 13, 9:00 AM CDT": one wording everywhere a person is told a time. */
export const whenWords = (at: number | string, zone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone, timeZoneName: "short" }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
};

export const workflowBookings = (deps: {
  readonly service: BookingService;
  readonly contacts: ContactService;
  readonly scheduling: SchedulingService;
  /** The person's status page for a booking, once public pages exist. */
  readonly linkFor?: (booking: Booking) => Promise<string | undefined>;
}): WorkflowBookings => {
  const zoneOf = async (contact: string, fallback = "UTC") => (await deps.contacts.get(contact))?.timezone ?? fallback;
  return {
    service: deps.service,
    contact: (id) => deps.contacts.get(id),
    when: async (at, contact) => whenWords(at, await zoneOf(contact)),
    row: async (booking) => {
      const contact = await deps.contacts.get(booking.contact);
      const type = await deps.scheduling.findType(booking.type.id);
      const host = await deps.scheduling.findProfile(booking.host);
      const fields = Object.fromEntries(Object.entries(contact?.fields ?? {}).flatMap(([key, field]) => {
        const best = fieldValueOf(field);
        return best ? [[key, best.value]] : [];
      }));
      const link = (await deps.linkFor?.(booking)) ?? "";
      return {
        ...booking,
        when: whenWords(booking.start, booking.timezone),
        link,
        contact: {
          ...fields,
          id: booking.contact,
          name: contact?.name || contact?.emails[0] || "",
          email: contact?.emails[0] ?? "",
          phone: contact?.phones[0] ?? "",
        },
        type: { id: booking.type.id, name: booking.type.name, slug: type?.slug ?? "", description: type?.description ?? "" },
        host: { id: booking.host, name: host?.displayName ?? booking.host },
        suggestions: (booking.suggestions ?? []).map((one) => ({ ...one, when: whenWords(one.start, booking.timezone) })),
      };
    },
  };
};
