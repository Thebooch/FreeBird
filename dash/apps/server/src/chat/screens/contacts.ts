import type { ActionDefinition, ActionPreflightResult, ComponentDefinition } from "@freebirdai/core";
import { withTransient } from "@freebirdai/core";
import { CONTACT_CHANNELS, fieldValueOf, type Contact } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { BookingLinks } from "../../bookings/links.js";
import type { ContactService } from "../../contacts/service.js";
import type { SchedulingOverview } from "../../scheduling/service.js";
import { SCREENS, actor, allowedTo, argsOf, blocked, changeRows, findBy, landed, listed, screenComponent, shown, type ScreenAccess } from "./common.js";

/**
 * Contacts (`#/agent/contacts`): finding and reading them, adding and
 * changing them, matching them to records, and their personal booking links.
 * Everything goes through `ContactService` (and `BookingLinks` for links), as
 * the contact sheet does. A link is shown once and never kept in the
 * conversation: only its hash is stored anywhere.
 */

export interface ContactsDeps extends ScreenAccess {
  readonly contacts: ContactService;
  readonly links: BookingLinks;
  readonly setup: SchedulingOverview;
  readonly fieldKeys: readonly string[];
}

const SCREEN = SCREENS.contacts;
const MANAGE = "Your role here does not allow changing contacts.";
const READ = "Your role here does not allow reading contacts.";

const current = z.string().optional().describe("Filled in by the system with the contact as they are now; leave it out.");
const contactKey = z.string().min(1).describe("The contact, by id, name, email or phone.");

/** One line about a contact, for cards and lists. */
export const contactWords = (contact: Contact): string =>
  [contact.name || "(no name)", ...contact.emails.slice(0, 2), ...contact.phones.slice(0, 2)].filter(Boolean).join(" · ");

const contactDetail = (contact: Contact) => ({
  id: contact.id,
  name: contact.name,
  emails: contact.emails,
  phones: contact.phones,
  timezone: contact.timezone,
  preferredHost: contact.preferredHost,
  preferences: contact.preferences,
  fields: Object.fromEntries(Object.keys(contact.fields).map((key) => [key, fieldValueOf(contact.fields[key])])),
  links: contact.links.map((one) => ({ connection: one.connection, entity: one.entity, recordId: one.recordId })),
  stats: contact.stats,
});

const recordTarget = z
  .object({ connection: z.string().min(1).describe("The connection's id."), entity: z.string().min(1).describe("The record type."), recordId: z.string().min(1).describe("The record's id.") })
  .strict();

export const contactsScreen = (deps: ContactsDeps): ComponentDefinition => {
  const { contacts } = deps;
  const manage = allowedTo(deps, "contacts.manage", MANAGE);
  const read = allowedTo(deps, "records.read", READ);

  /** A contact by id, name, email or phone: exactly one, with what it is now for the card. */
  const resolve = async (key: string): Promise<{ contact: Contact } | { problem: string }> => {
    const held = await contacts.get(key);
    if (held) return { contact: held };
    const { contacts: found } = await contacts.list({ search: key, limit: 6 });
    if (found.length === 1) return { contact: found[0]! };
    if (found.length === 0) return { problem: `No contact matches "${key}".` };
    return { problem: `Several contacts match "${key}": ${found.map((one) => `${contactWords(one)} (${one.id})`).join("; ")}. Say which.` };
  };
  const preflightContact = async (key: string): Promise<ActionPreflightResult> => {
    const found = await resolve(key);
    return "problem" in found ? blocked("contact", found.problem) : { ok: true, resolvedArgs: { contact: found.contact.id, current: contactWords(found.contact) } };
  };

  const find: ActionDefinition<{ search?: string; limit?: number }, unknown, unknown> = {
    id: "find_contacts",
    description: "Find contacts by name, email or phone, or list the latest.",
    schema: z.object({ search: z.string().optional().describe("Part of a name, email or phone."), limit: z.number().int().min(1).max(50).optional().describe("Default 20.") }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: read,
    handler: async (args) => {
      const { contacts: found } = await contacts.list({ ...(args.search ? { search: args.search } : {}), limit: args.limit ?? 20 });
      return { count: found.length, contacts: found.map((one) => ({ id: one.id, summary: contactWords(one) })) };
    },
  };

  const readOne: ActionDefinition<{ contact: string }, unknown, unknown> = {
    id: "read_contact",
    description: "Read one contact: their details, fields (with where each came from), the records they match, and their booking counts.",
    schema: z.object({ contact: contactKey }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: read,
    handler: async (args) => {
      const found = await resolve(args.contact);
      return "problem" in found ? { error: found.problem } : contactDetail(found.contact);
    },
  };

  const details = {
    name: z.string().trim().max(160).optional().describe("Their name."),
    emails: z.array(z.string()).max(10).optional().describe("Their email addresses. Replaces the list."),
    phones: z.array(z.string()).max(10).optional().describe("Their phone numbers, with area code. Replaces the list."),
    timezone: z.string().nullable().optional().describe("Their IANA time zone. null: unknown."),
    preferredHost: z.string().nullable().optional().describe("The host they prefer, by name or id. null: none."),
    channel: z.enum(CONTACT_CHANNELS).nullable().optional().describe("How they prefer to be reached: text, email or call."),
    optOut: z.array(z.enum(CONTACT_CHANNELS)).optional().describe("Channels they asked not to be reached on."),
    fields: z.record(z.unknown()).optional().describe(`Contact fields to set, by key${deps.fieldKeys.length > 0 ? ` (${deps.fieldKeys.join(", ")})` : ""}. null clears what a member set.`),
  };
  type Details = { name?: string; emails?: string[]; phones?: string[]; timezone?: string | null; preferredHost?: string | null; channel?: (typeof CONTACT_CHANNELS)[number] | null; optOut?: Array<(typeof CONTACT_CHANNELS)[number]>; fields?: Record<string, unknown> };

  const hostId = (key: string | null | undefined) => (key ? (findBy(deps.setup.profiles, key, (one) => [one.member, one.displayName, one.email])?.member ?? key) : key);
  const inputOf = (args: Details) => ({
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.emails !== undefined ? { emails: args.emails } : {}),
    ...(args.phones !== undefined ? { phones: args.phones } : {}),
    ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
    ...(args.preferredHost !== undefined ? { preferredHost: hostId(args.preferredHost) } : {}),
    ...(args.channel !== undefined || args.optOut !== undefined ? { preferences: { ...(args.channel !== undefined ? { channel: args.channel } : {}), ...(args.optOut !== undefined ? { optOut: args.optOut } : {}) } } : {}),
    ...(args.fields !== undefined ? { fields: args.fields } : {}),
  });
  const detailRows = (args: Details, isNew: boolean) =>
    changeRows([
      { label: "Name", after: args.name, isNew },
      { label: "Emails", after: args.emails, isNew },
      { label: "Phones", after: args.phones, isNew },
      { label: "Time zone", after: args.timezone === null ? "Unknown" : args.timezone, isNew },
      { label: "Prefers host", after: args.preferredHost === null ? "None" : args.preferredHost, isNew },
      { label: "Reach them by", after: args.channel === null ? "No preference" : args.channel, isNew },
      { label: "Not on", after: args.optOut, isNew },
      ...Object.entries(args.fields ?? {}).map(([key, value]) => ({ label: key, after: value === null ? "Cleared" : shown(value), isNew })),
    ]);

  const add: ActionDefinition<Details, unknown, unknown> = {
    id: "add_contact",
    description: "Add a contact, with at least an email or a phone so they can be found. Shown on a card first.",
    schema: argsOf<Details>(z.object(details)),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => ((args.emails?.length ?? 0) + (args.phones?.length ?? 0) === 0 ? blocked("emails", "Give an email or a phone number, so they can be found.") : { ok: true }),
    preview: (args) => ({ title: `Add ${args.name || "a contact"}`, summary: "A new contact.", rows: detailRows(args, true) }),
    handler: async (args, ctx) => {
      const made = await contacts.create(inputOf(args), actor(ctx).userId);
      deps.changed();
      return landed({ created: true, id: made.id }, SCREEN, { title: made.name || "Contact", item: made.id, summary: `Added ${contactWords(made)}.` });
    },
  };

  const update: ActionDefinition<Details & { contact: string; current?: string }, unknown, unknown> = {
    id: "update_contact",
    description: "Change a contact: name, emails, phones, time zone, preferred host, how to reach them, and their contact fields. Shown on a card first.",
    schema: argsOf(z.object({ contact: contactKey, ...details, current })),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => preflightContact(args.contact),
    preview: (args) => ({ title: "Change a contact", summary: args.current ?? "", rows: detailRows(args, true) }),
    handler: async (args, ctx) => {
      const saved = await contacts.update(args.contact, inputOf(args), actor(ctx).userId);
      deps.changed();
      return landed({ updated: true, id: saved.id }, SCREEN, { title: saved.name || "Contact", item: saved.id, summary: `Changed ${contactWords(saved)}.` });
    },
  };

  const one = (spec: {
    id: string;
    description: string;
    title: string;
    note: string;
    extra?: Record<string, z.ZodTypeAny>;
    rows?: (args: Record<string, unknown>) => Array<{ label: string; value: string }>;
    run: (args: Record<string, unknown> & { contact: string }, userId: string, ctx: Parameters<typeof actor>[0]) => Promise<{ said: string; result?: object; transient?: Record<string, string> }>;
  }): ActionDefinition<Record<string, unknown> & { contact: string; current?: string }, unknown, unknown> => ({
    id: spec.id,
    description: `${spec.description} Shown on a card first.`,
    schema: argsOf(z.object({ contact: contactKey, ...(spec.extra ?? {}), current })),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => preflightContact(args.contact),
    preview: (args) => ({ title: spec.title, summary: spec.note, rows: [...(args.current ? [{ label: "Contact", value: String(args.current) }] : []), ...(spec.rows?.(args) ?? [])] }),
    handler: async (args, ctx) => {
      const out = await spec.run(args, actor(ctx).userId, ctx);
      deps.changed();
      const result = landed({ ...(out.result ?? {}), id: args.contact }, SCREEN, { title: String(args.current ?? "Contact").split(" · ")[0] ?? "Contact", item: args.contact, summary: out.said });
      return out.transient ? withTransient(result, out.transient) : result;
    },
  });

  const forget = one({
    id: "forget_contact",
    description: "Forget a contact: their details and fields are removed. Their bookings stay, without them.",
    title: "Forget this contact",
    note: "It cannot be undone.",
    run: async (args) => {
      await contacts.forget(args.contact);
      return { said: `Forgot ${String(args.current ?? "the contact")}.` };
    },
  });

  const match = one({
    id: "match_contact",
    description: "Match a contact to a record in a connected account, by the match rules (Contact fields), and copy the record's values into their fields.",
    title: "Match this contact to a record",
    note: "Reads the connected accounts as the rules say.",
    run: async (args) => {
      const { outcome } = await contacts.matchWithDetail(args.contact);
      return { said: `Matched: ${shown(outcome)}.`, result: { outcome } };
    },
  });

  const refresh = one({
    id: "refresh_contact",
    description: "Copy a contact's linked records' values into their fields again.",
    title: "Refresh this contact from their records",
    note: "Their fields from records are read again.",
    run: async (args, _user, ctx) => {
      const { problems } = await contacts.refreshWithDetail(args.contact, actor(ctx));
      return { said: problems.length > 0 ? `Refreshed, with problems: ${problems.join("; ")}` : "Refreshed from their records.", result: { problems } };
    },
  });

  const link = one({
    id: "link_contact",
    description: "Link a contact to one record in a connected account by hand, and copy its values into their fields.",
    title: "Link this contact to a record",
    note: "Values copy once; refresh copies them again.",
    extra: { record: recordTarget },
    rows: (args) => [{ label: "Record", value: shown(args["record"]) }],
    run: async (args, _user, ctx) => {
      const { problems } = await contacts.link(args.contact, args["record"] as z.infer<typeof recordTarget>, actor(ctx));
      return { said: problems.length > 0 ? `Linked, with problems: ${problems.join("; ")}` : "Linked to the record.", result: { problems } };
    },
  });

  const unlink = one({
    id: "unlink_contact",
    description: "Unlink a contact from a record. The values already copied stay.",
    title: "Unlink this contact from a record",
    note: "Values already copied stay.",
    extra: { record: recordTarget },
    rows: (args) => [{ label: "Record", value: shown(args["record"]) }],
    run: async (args) => {
      await contacts.unlink(args.contact, args["record"] as z.infer<typeof recordTarget>);
      return { said: "Unlinked from the record." };
    },
  });

  const listLinks: ActionDefinition<{ contact: string }, unknown, unknown> = {
    id: "list_contact_links",
    description: "Read a contact's personal booking links: when each was made, until when it works, and which were revoked. Never the links themselves.",
    schema: z.object({ contact: contactKey }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: manage,
    handler: async (args) => {
      const found = await resolve(args.contact);
      if ("problem" in found) return { error: found.problem };
      return { links: (await deps.links.linksOf(found.contact.id)).map((each) => ({ id: each.id, type: each.type, booking: each.booking, fromPublic: each.fromPublic === true, createdAt: each.createdAt, expiresAt: each.expiresAt, revokedAt: each.revokedAt })) };
    },
  };

  const makeLink = one({
    id: "make_contact_link",
    description: "Make a contact a personal booking link, for one appointment type or any: they see open times and their own bookings. Shown to the person once, to copy; never kept in the conversation.",
    title: "Make a booking link for this contact",
    note: "Shown to you once, to copy.",
    extra: { type: z.string().optional().describe("Only this appointment type, by name or id.") },
    rows: (args) => [{ label: "For", value: args["type"] ? (findBy(deps.setup.types, String(args["type"]), (each) => [each.id, each.name, each.slug])?.name ?? String(args["type"])) : "Any type" }],
    run: async (args) => {
      const type = args["type"] ? findBy(deps.setup.types, String(args["type"]), (each) => [each.id, each.name, each.slug])?.id : undefined;
      const made = await deps.links.contactLink(args.contact, type ? { type } : {});
      return { said: `Made ${String(args.current ?? "the contact").split(" · ")[0]} a booking link. It is shown once, to copy.`, transient: { link: made.url } };
    },
  });

  const revokeLink = one({
    id: "revoke_contact_link",
    description: "Revoke one of a contact's booking links: it stops working.",
    title: "Revoke this booking link",
    note: "It stops working at once.",
    extra: { link: z.string().min(1).describe("The link's id, from list_contact_links.") },
    run: async (args) => {
      const revoked = await deps.links.revoke(String(args["link"]), args.contact);
      if (!revoked) throw new Error("There is no such link for this contact.");
      return { said: "Revoked the link." };
    },
  });

  return screenComponent(
    SCREEN,
    [`CONTACTS: find_contacts finds them; fields they can hold: ${listed([...deps.fieldKeys], 40)}.`],
    [find, readOne, add, update, forget, match, refresh, link, unlink, listLinks, makeLink, revokeLink],
  );
};
