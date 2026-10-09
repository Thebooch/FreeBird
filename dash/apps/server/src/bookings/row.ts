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

/** Where someone was turned away, as a sentence ends: "They asked on …". */
export const TURNED_AWAY_VIA = ["booking_page", "public_link", "agent"] as const;
export type TurnedAwayVia = (typeof TURNED_AWAY_VIA)[number];
const VIA_WORDS: Readonly<Record<TurnedAwayVia, string>> = { booking_page: "their booking page", public_link: "the public booking page", agent: "a conversation with an agent" };

/** "partySize" → "Party size". */
const keyWords = (key: string): string => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const workflowBookings = (deps: {
  readonly service: BookingService;
  readonly contacts: ContactService;
  readonly scheduling: SchedulingService;
  /** The person's status page for a booking, once public pages exist. */
  readonly linkFor?: (booking: Booking) => Promise<string | undefined>;
  readonly links?: WorkflowBookings["links"];
}): WorkflowBookings => {
  const zoneOf = async (contact: string, fallback = "UTC") => (await deps.contacts.get(contact))?.timezone ?? fallback;
  /** The contact as a step reads it: their fields, then who they are. */
  const contactRow = async (id: string) => {
    const contact = await deps.contacts.get(id);
    const fields = Object.fromEntries(Object.entries(contact?.fields ?? {}).flatMap(([key, field]) => {
      const best = fieldValueOf(field);
      return best ? [[key, best.value]] : [];
    }));
    return { contact, row: { ...fields, id, name: contact?.name || contact?.emails[0] || "", email: contact?.emails[0] ?? "", phone: contact?.phones[0] ?? "" } };
  };
  return {
    service: deps.service,
    contact: (id) => deps.contacts.get(id),
    turnedAwayRow: async (event) => {
      const payload = event.payload;
      const { contact, row: person } = await contactRow(String(payload["contact"] ?? ""));
      const type = await deps.scheduling.findType(event.type);
      const answers = payload["answers"] && typeof payload["answers"] === "object" ? (payload["answers"] as Record<string, unknown>) : {};
      const via = (TURNED_AWAY_VIA as readonly string[]).includes(String(payload["via"])) ? (payload["via"] as TurnedAwayVia) : "booking_page";
      const answersText = Object.entries(answers)
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
        .map(([key, value]) => `${keyWords(key)}: ${String(value)}`)
        .join("\n");
      return {
        id: event.booking,
        title: `${type?.name ?? event.type} · ${person.name || "someone"}`,
        when: whenWords(event.at, contact?.timezone ?? "UTC"),
        contact: person,
        type: { id: event.type, name: type?.name ?? event.type, slug: type?.slug ?? "", description: type?.description ?? "" },
        request: answers,
        answersText: answersText || "No answers given.",
        /* What the person was told: the type's own words. */
        reason: type?.eligibility.message ?? "",
        via,
        viaWords: VIA_WORDS[via],
        ...(typeof payload["agent"] === "string" ? { agent: payload["agent"] } : {}),
      };
    },
    ...(deps.links ? { links: deps.links } : {}),
    when: async (at, contact) => whenWords(at, await zoneOf(contact)),
    row: async (booking, known = {}) => {
      const contact = await deps.contacts.get(booking.contact);
      const type = await deps.scheduling.findType(booking.type.id);
      const host = await deps.scheduling.findProfile(booking.host);
      const fields = Object.fromEntries(Object.entries(contact?.fields ?? {}).flatMap(([key, field]) => {
        const best = fieldValueOf(field);
        return best ? [[key, best.value]] : [];
      }));
      const link = known.link || ((await deps.linkFor?.(booking)) ?? "");
      return {
        ...booking,
        when: whenWords(booking.start, booking.timezone),
        title: `${booking.type.name} · ${contact?.name || contact?.emails[0] || "someone"}`,
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
