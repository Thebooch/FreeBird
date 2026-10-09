import type { Contact, ContactOrigin, MatchOutcome } from "@freebirdai/dash-spec";
import type { Facts } from "../scheduling/rules.js";

/**
 * What scheduling needs from contacts, and all it may use.
 *
 * Today `ContactService` implements it over Dash's own store. The CRM, when
 * it comes, supplies its own implementation and must keep what this promises:
 *
 * 1. Contact ids stay stable. A merge re-points bookings, links and tokens to
 *    the contact that survives and keeps the other id as an alias, so an old
 *    booking link still finds its booking.
 * 2. Fields keep where each value came from (`from`, `ref`, `at`) and the same
 *    precedence — member, then record, then the person — because rules that
 *    want a trusted value depend on it.
 * 3. A record's values are copied once and on Refresh. Any background sync is
 *    opt-in: a rule never changes under a booking without a visible refresh.
 * 4. It owns the timeline and the stats rules read (`bookings`,
 *    `cancellations`, `noShows`, `lastBookedAt`).
 * 5. It owns consent (channel, opt-outs, quiet hours) and verification of
 *    email and phone, which messages and `requireVerifiedContact` check.
 * 6. Forgetting a person cancels their future bookings, revokes their links
 *    and leaves past bookings with the contact anonymized.
 */
export interface ContactDirectory {
  get(id: string): Promise<Contact | null>;
  /** The contact with this email or phone, made if there is none. Never matched on a name alone. */
  findOrCreate(input: { readonly email?: string; readonly phone?: string; readonly name?: string; readonly origin: ContactOrigin }): Promise<Contact>;
  /** `contact.*` and `contact.stats.*`, for block rules. */
  facts(id: string): Promise<Facts>;
  /** A value the person gave, or a member set. */
  record(id: string, field: string, value: unknown, from: "person" | "member", by?: string): Promise<void>;
  /** Tries the workspace's match rules once: exactly one record links it. */
  match(id: string): Promise<MatchOutcome>;
  /** Copies its linked records' values again. */
  refresh(id: string): Promise<void>;
  bump(id: string, stat: "bookings" | "cancellations" | "noShows", at: string): Promise<void>;
  /** Who they booked with before; sets it when `host` is given. */
  preferredHost(id: string, host?: string): Promise<string | undefined>;
  /** Deletes the person. */
  forget(id: string): Promise<void>;
}
