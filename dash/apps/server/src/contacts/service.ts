import {
  contactFieldDefInputSchema,
  contactInputSchema,
  contactMatchRuleInputSchema,
  fieldValueFor,
  fieldValueOf,
  isTimeZone,
  normalizeEmail,
  normalizePhone,
  readField,
  type Contact,
  type ContactField,
  type ContactFieldDef,
  type ContactLink,
  type ContactMatchRule,
  type ContactOrigin,
  type MatchOutcome,
  type Principal,
} from "@freebirdai/dash-spec";
import type { ZodError } from "zod";
import { normalizeFact, type FactKind, type Facts } from "../scheduling/rules.js";
import type { ContactDirectory } from "./directory.js";
import type { ContactListOptions, ContactStore } from "./store.js";

/**
 * Contacts: finding them, what they hold, and linking them to API records.
 *
 * The only code that reads or writes a contact. Matching and Refresh read
 * through `ContactReads`, as a person who may read the connection — the one
 * who saved the match rule, or the member who pressed Refresh — so a contact
 * never learns what nobody here could see. A read that is refused, failed or
 * did not reach every record is never taken for "no such record": the
 * contact stays unlinked and says why.
 */

export class ContactError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** For a clash: the contact that already has the email or phone. */
    readonly holder?: string,
  ) {
    super(message);
  }
}

/** Reading a connection's records for matching and Refresh. */
export interface ContactReads {
  /** Every record of a type, as someone; `refused` when they may not read it. */
  read(
    as: Principal,
    target: { readonly connection: string; readonly entity: string },
    fresh: number | string,
  ): Promise<{ readonly rows: readonly unknown[]; readonly complete: boolean } | { readonly refused: string }>;
  /** The field a record's id is in. */
  idField(connection: string, entity: string): string | undefined;
  /** What a record is called, when its type says. */
  label?(connection: string, entity: string, row: unknown): string | undefined;
  /** "Billing's clients", for sentences. */
  describe?(connection: string, entity: string): string;
}

export interface ContactDeps {
  readonly store: ContactStore;
  readonly reads?: ContactReads;
  /** The country code a phone number written without one is read in. */
  readonly callingCode?: () => string;
  readonly now: () => number;
  readonly newId: () => string;
}

const problem = (error: ZodError): string => error.issues[0]?.message ?? "That is not right.";

const iso = (ms: number): string => new Date(ms).toISOString();

const recordIdOf = (row: unknown, field: string | undefined): string | undefined => {
  const value = readField(row, field ?? "id");
  return value === undefined || value === null || value === "" ? undefined : String(value);
};

/** A record's value at a path, as the strings it could be matched by. */
const recordValues = (row: unknown, path: string, kind: "email" | "phone" | FactKind, callingCode: string): string[] => {
  const raw = readField(row, path);
  const all = Array.isArray(raw) ? raw : [raw];
  return all.map((one) => comparable(one, kind, callingCode)).filter((one): one is string => one !== undefined);
};

const comparable = (value: unknown, kind: "email" | "phone" | FactKind, callingCode: string): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (kind === "email") return normalizeEmail(value) ?? undefined;
  if (kind === "phone") return normalizePhone(value, callingCode) ?? undefined;
  return normalizeFact(value, kind);
};

export class ContactService implements ContactDirectory {
  constructor(private readonly deps: ContactDeps) {}

  private get callingCode(): string {
    return this.deps.callingCode?.() ?? "1";
  }

  /* ── reading ─────────────────────────────────────────────────────────── */

  async get(id: string): Promise<Contact | null> {
    return this.deps.store.get(id);
  }

  async require(id: string): Promise<Contact> {
    const contact = await this.deps.store.get(id);
    if (!contact) throw new ContactError("There is no such contact.", 404);
    return contact;
  }

  list(options: ContactListOptions = {}): ReturnType<ContactStore["list"]> {
    return this.deps.store.list(options);
  }

  async setup(): Promise<{ readonly fields: readonly ContactFieldDef[]; readonly matchRules: readonly ContactMatchRule[] }> {
    const [fields, matchRules] = await Promise.all([this.deps.store.fields(), this.deps.store.matchRules()]);
    return { fields, matchRules };
  }

  /** Each field's kind, by its path in a rule's scope, for comparing values the way the field means them. */
  async factKinds(): Promise<ReadonlyMap<string, FactKind>> {
    const kinds = new Map<string, FactKind>([
      ["contact.email", "email"],
      ["contact.phone", "phone"],
    ]);
    for (const def of await this.deps.store.fields()) kinds.set(`contact.${def.key}`, def.kind);
    return kinds;
  }

  async facts(id: string): Promise<Facts> {
    const contact = await this.require(id);
    return this.factsOf(contact, await this.deps.store.fields());
  }

  /**
   * What rules can read of a contact. A field's value is the strongest one
   * it has; it is trusted when that value came from a record or a member.
   * An email or phone counts as trusted once Comms has confirmed it.
   */
  factsOf(contact: Contact, defs: readonly ContactFieldDef[]): Facts {
    const scope: Record<string, unknown> = {
      id: contact.id,
      name: contact.name,
      emails: contact.emails,
      phones: contact.phones,
      ...(contact.emails[0] ? { email: contact.emails[0] } : {}),
      ...(contact.phones[0] ? { phone: contact.phones[0] } : {}),
      ...(contact.timezone ? { timezone: contact.timezone } : {}),
      stats: contact.stats,
    };
    const trusted = new Set<string>(["contact.id", "contact.stats"]);
    if (contact.verified.email && contact.verified.email === contact.emails[0]) trusted.add("contact.email");
    if (contact.verified.phone && contact.verified.phone === contact.phones[0]) trusted.add("contact.phone");
    for (const [key, field] of Object.entries(contact.fields)) {
      const best = fieldValueOf(field);
      if (!best) continue;
      scope[key] = best.value;
      if (best.from !== "person") trusted.add(`contact.${key}`);
    }
    const kinds = new Map<string, FactKind>([
      ["contact.email", "email"],
      ["contact.phone", "phone"],
    ]);
    for (const def of defs) kinds.set(`contact.${def.key}`, def.kind);
    return { scope: { contact: scope }, trusted, kinds };
  }

  /* ── finding and making ──────────────────────────────────────────────── */

  async findOrCreate(input: { readonly email?: string; readonly phone?: string; readonly name?: string; readonly origin: ContactOrigin }): Promise<Contact> {
    const email = input.email ? normalizeEmail(input.email) : null;
    const phone = input.phone ? normalizePhone(input.phone, this.callingCode) : null;
    if (input.email && !email) throw new ContactError("That is not an email address.");
    if (input.phone && !phone) throw new ContactError("That is not a phone number with its area code.");
    if (!email && !phone) throw new ContactError("Say an email or a phone number to find them by.");

    for (let attempt = 0; attempt < 4; attempt++) {
      const found = (email ? await this.deps.store.byKey(`email:${email}`) : null) ?? (phone ? await this.deps.store.byKey(`phone:${phone}`) : null);
      if (found) return this.fillIn(found, { email, phone, name: input.name });
      const now = iso(this.deps.now());
      const made: Contact = {
        id: `ct-${this.deps.newId()}`,
        name: input.name?.trim() ?? "",
        emails: email ? [email] : [],
        phones: phone ? [phone] : [],
        fields: {},
        links: [],
        preferences: { optOut: [] },
        stats: { bookings: 0, cancellations: 0, noShows: 0, firstContactAt: now },
        verified: {},
        origin: input.origin,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const saved = await this.deps.store.put(made);
      if (saved.ok) return saved.contact;
      /* Someone made them a moment ago: look again, and use theirs. */
    }
    throw new ContactError("They could not be saved just now. Try again.", 503);
  }

  /** A found contact, with an email or phone it lacked and a name it had none of. Never fails the finding. */
  private async fillIn(found: Contact, given: { readonly email: string | null; readonly phone: string | null; readonly name: string | undefined }): Promise<Contact> {
    const emails = given.email && !found.emails.includes(given.email) ? [...found.emails, given.email] : found.emails;
    const phones = given.phone && !found.phones.includes(given.phone) ? [...found.phones, given.phone] : found.phones;
    const name = !found.name && given.name?.trim() ? given.name.trim() : found.name;
    if (emails === found.emails && phones === found.phones && name === found.name) return found;
    const next: Contact = { ...found, emails: emails.slice(0, 10), phones: phones.slice(0, 10), name, revision: found.revision + 1, updatedAt: iso(this.deps.now()) };
    const saved = await this.deps.store.put(next, found.revision);
    return saved.ok ? saved.contact : found;
  }

  /** A contact a member adds by hand. One that already has the email or phone is not made twice. */
  async create(input: unknown, by: string): Promise<Contact> {
    const given = contactInputSchema.safeParse(input);
    if (!given.success) throw new ContactError(problem(given.error));
    const email = given.data.emails?.[0];
    const phone = given.data.phones?.[0];
    const emailKey = email ? normalizeEmail(email) : null;
    const phoneKey = phone ? normalizePhone(phone, this.callingCode) : null;
    const existing = (emailKey ? await this.deps.store.byKey(`email:${emailKey}`) : null) ?? (phoneKey ? await this.deps.store.byKey(`phone:${phoneKey}`) : null);
    if (existing) throw new ContactError(`${existing.name || "Someone"} already has that ${existing.emails.includes(emailKey ?? "") ? "email" : "phone number"}.`, 409, existing.id);
    const made = await this.findOrCreate({ ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(given.data.name ? { name: given.data.name } : {}), origin: "member" });
    const { emails: _emails, phones: _phones, revision: _revision, ...rest } = given.data;
    return Object.keys(rest).length > 0 ? this.update(made.id, { ...given.data, revision: made.revision }, by) : made;
  }

  /* ── changing ────────────────────────────────────────────────────────── */

  /**
   * Reads a contact, changes it and saves it, again from a fresh read when
   * someone saved it in between. A change that takes an email or phone
   * another contact has is refused, naming that contact.
   */
  private async mutate(id: string, change: (contact: Contact, defs: readonly ContactFieldDef[]) => Contact, expect?: number): Promise<Contact> {
    const defs = await this.deps.store.fields();
    for (let attempt = 0; attempt < 4; attempt++) {
      const contact = await this.require(id);
      if (expect !== undefined && contact.revision !== expect) throw new ContactError("Someone changed this contact since you opened it. Reopen it and try again.", 409);
      const next = change(contact, defs);
      const saved = await this.deps.store.put({ ...next, revision: contact.revision + 1, updatedAt: iso(this.deps.now()) }, contact.revision);
      if (saved.ok) return saved.contact;
      if (saved.reason === "taken") {
        const holder = saved.holder ? await this.deps.store.get(saved.holder) : null;
        const what = saved.key?.startsWith("email:") ? "email" : "phone number";
        throw new ContactError(`${holder?.name || "Another contact"} already has that ${what}.`, 409, saved.holder);
      }
      if (expect !== undefined) throw new ContactError("Someone changed this contact since you opened it. Reopen it and try again.", 409);
    }
    throw new ContactError("This contact is changing too often to save. Try again.", 409);
  }

  /** A member's change: name, emails, phones, time zone, preferences, and their own field values. */
  async update(id: string, input: unknown, by: string): Promise<Contact> {
    const given = contactInputSchema.safeParse(input);
    if (!given.success) throw new ContactError(problem(given.error));
    const change = given.data;
    const emails = change.emails?.map((one) => {
      const email = normalizeEmail(one);
      if (!email) throw new ContactError(`"${one}" is not an email address.`);
      return email;
    });
    const phones = change.phones?.map((one) => {
      const phone = normalizePhone(one, this.callingCode);
      if (!phone) throw new ContactError(`"${one}" is not a phone number with its area code.`);
      return phone;
    });
    if (emails && phones && emails.length + phones.length === 0) throw new ContactError("Keep an email or a phone number, so they can be found.");
    if (change.timezone && !isTimeZone(change.timezone)) throw new ContactError(`"${change.timezone}" is not a time zone.`);
    const defs = new Map((await this.deps.store.fields()).map((def) => [def.key, def]));
    const values = Object.entries(change.fields ?? {}).map(([key, raw]) => {
      const def = defs.get(key);
      if (!def) throw new ContactError(`There is no field "${key}". Add it under Contact fields first.`);
      if (raw === null || raw === "") return [key, null] as const;
      const checked = fieldValueFor(def, raw, this.callingCode);
      if (!checked.ok) throw new ContactError(checked.problem);
      return [key, checked.value] as const;
    });
    const at = iso(this.deps.now());
    return this.mutate(
      id,
      (contact) => {
        const nextEmails = emails ? [...new Set(emails)] : contact.emails;
        const nextPhones = phones ? [...new Set(phones)] : contact.phones;
        if (nextEmails.length + nextPhones.length === 0) throw new ContactError("Keep an email or a phone number, so they can be found.");
        const fields = { ...contact.fields };
        for (const [key, value] of values) {
          const { member: _member, ...others } = fields[key] ?? {};
          if (value === null) {
            if (Object.keys(others).length > 0) fields[key] = others;
            else delete fields[key];
          } else fields[key] = { ...others, member: { value, by, at } };
        }
        const { timezone: _timezone, preferredHost: _host, ...base } = contact;
        const timezone = change.timezone === undefined ? contact.timezone : (change.timezone ?? undefined);
        const preferredHost = change.preferredHost === undefined ? contact.preferredHost : (change.preferredHost ?? undefined);
        const channel = change.preferences?.channel === undefined ? contact.preferences.channel : (change.preferences.channel ?? undefined);
        const { channel: _channel, ...preferences } = contact.preferences;
        return {
          ...base,
          ...(change.name !== undefined ? { name: change.name } : {}),
          emails: nextEmails,
          phones: nextPhones,
          ...(timezone ? { timezone } : {}),
          ...(preferredHost ? { preferredHost } : {}),
          preferences: { ...preferences, ...(channel ? { channel } : {}), optOut: change.preferences?.optOut ?? contact.preferences.optOut },
          fields,
        };
      },
      change.revision,
    );
  }

  async record(id: string, field: string, value: unknown, from: "person" | "member", by?: string): Promise<void> {
    const def = (await this.deps.store.fields()).find((one) => one.key === field);
    if (!def) throw new ContactError(`There is no field "${field}".`);
    const checked = fieldValueFor(def, value, this.callingCode);
    if (!checked.ok) throw new ContactError(checked.problem);
    const at = iso(this.deps.now());
    await this.mutate(id, (contact) => ({
      ...contact,
      fields: { ...contact.fields, [field]: { ...contact.fields[field], [from]: { value: checked.value, ...(by ? { by } : {}), at } } },
    }));
  }

  async bump(id: string, stat: "bookings" | "cancellations" | "noShows", at: string): Promise<void> {
    await this.mutate(id, (contact) => ({
      ...contact,
      stats: { ...contact.stats, [stat]: contact.stats[stat] + 1, ...(stat === "bookings" ? { lastBookedAt: at } : {}) },
    }));
  }

  async preferredHost(id: string, host?: string): Promise<string | undefined> {
    if (host === undefined) return (await this.require(id)).preferredHost;
    return (await this.mutate(id, (contact) => ({ ...contact, preferredHost: host }))).preferredHost;
  }

  async forget(id: string): Promise<void> {
    await this.require(id);
    await this.deps.store.delete(id);
  }

  /* ── linking to records ──────────────────────────────────────────────── */

  /**
   * Tries every match rule whose record type the contact is not linked to
   * yet. Exactly one record linking it is the only way to "linked"; several
   * leave the choice to a member, on the contact; a read that was refused,
   * failed or did not reach every record is "unavailable", never "none".
   */
  async match(id: string): Promise<MatchOutcome> {
    return (await this.matchWithDetail(id)).outcome;
  }

  async matchWithDetail(id: string): Promise<{ readonly outcome: MatchOutcome; readonly contact: Contact }> {
    const contact = await this.require(id);
    const rules = await this.deps.store.matchRules();
    const defs = await this.deps.store.fields();
    const reads = this.deps.reads;
    const at = iso(this.deps.now());
    const found: Array<{ outcome: MatchOutcome; detail: string; candidates?: Array<{ connection: string; entity: string; recordId: string; label?: string }>; link?: { rule: ContactMatchRule; row: unknown; recordId: string; matchedOn: string[] } }> = [];

    for (const rule of rules) {
      if (contact.links.some((link) => link.connection === rule.connection && link.entity === rule.entity)) continue;
      const where = reads?.describe?.(rule.connection, rule.entity) ?? `${rule.connection} ${rule.entity}`;
      const wanted = rule.on.map((pair) => ({ pair, kind: this.keyKind(pair.contact, defs), values: this.contactValues(contact, pair.contact, defs) }));
      if (wanted.some((one) => one.values.length === 0)) continue;
      if (!reads) {
        found.push({ outcome: "unavailable", detail: `${where} can't be read here.` });
        continue;
      }
      let answer: Awaited<ReturnType<ContactReads["read"]>>;
      try {
        answer = await reads.read(rule.savedBy, { connection: rule.connection, entity: rule.entity }, "5m");
      } catch (error) {
        found.push({ outcome: "unavailable", detail: `${where} could not be read: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if ("refused" in answer) {
        found.push({ outcome: "unavailable", detail: `The person who set up matching may not read ${where}: ${answer.refused}` });
        continue;
      }
      const hits = answer.rows.filter((row) => wanted.every((one) => recordValues(row, one.pair.record, one.kind, this.callingCode).some((value) => one.values.includes(value))));
      const idField = reads.idField(rule.connection, rule.entity);
      const ids = [...new Set(hits.map((row) => recordIdOf(row, idField)).filter((one): one is string => one !== undefined))];
      if (ids.length >= 2) {
        found.push({
          outcome: "ambiguous",
          detail: `${ids.length} records in ${where} match. Pick the right one.`,
          candidates: ids.slice(0, 20).map((recordId) => {
            const row = hits.find((one) => recordIdOf(one, idField) === recordId);
            const label = reads.label?.(rule.connection, rule.entity, row);
            return { connection: rule.connection, entity: rule.entity, recordId, ...(label ? { label } : {}) };
          }),
        });
      } else if (!answer.complete) {
        found.push({ outcome: "unavailable", detail: `Not every record in ${where} could be read, so a match can't be confirmed.` });
      } else if (ids.length === 1) {
        found.push({
          outcome: "linked",
          detail: `Matched in ${where} on ${rule.on.map((pair) => pair.contact).join(" and ")}.`,
          link: { rule, row: hits.find((one) => recordIdOf(one, idField) === ids[0])!, recordId: ids[0]!, matchedOn: rule.on.map((pair) => pair.contact) },
        });
      } else {
        found.push({ outcome: "none", detail: `No record in ${where} has this ${rule.on.map((pair) => pair.contact).join(" and ")}.` });
      }
    }

    const linked = found.filter((one) => one.link);
    const outcome: MatchOutcome =
      linked.length > 0 ? "linked" : found.some((one) => one.outcome === "ambiguous") ? "ambiguous" : found.some((one) => one.outcome === "unavailable") ? "unavailable" : "none";
    const ambiguous = found.filter((one) => one.outcome === "ambiguous");
    const detail =
      found.length === 0
        ? rules.length === 0
          ? "No match rules are set up."
          : "Nothing to match on: no rule uses what this contact has."
        : found.map((one) => one.detail).join(" ");
    const updated = await this.mutate(id, (current) => {
      let next = current;
      for (const one of linked) {
        next = this.withLink(next, defs, { connection: one.link!.rule.connection, entity: one.link!.rule.entity, recordId: one.link!.recordId, ...this.labelOf(one.link!.rule, one.link!.row), matchedOn: one.link!.matchedOn, syncedAt: at, by: "match" }, one.link!.row).contact;
      }
      const candidates = ambiguous.flatMap((one) => one.candidates ?? []);
      return { ...next, lastMatch: { outcome, detail, ...(candidates.length > 0 ? { candidates } : {}), at } };
    });
    return { outcome, contact: updated };
  }

  private labelOf(rule: { connection: string; entity: string }, row: unknown): { label?: string } {
    const label = this.deps.reads?.label?.(rule.connection, rule.entity, row);
    return label ? { label } : {};
  }

  private keyKind(key: string, defs: readonly ContactFieldDef[]): "email" | "phone" | FactKind {
    if (key === "email" || key === "phone") return key;
    return defs.find((def) => def.key === key)?.kind ?? "text";
  }

  private contactValues(contact: Contact, key: string, defs: readonly ContactFieldDef[]): string[] {
    if (key === "email") return contact.emails;
    if (key === "phone") return contact.phones;
    const value = fieldValueOf(contact.fields[key])?.value;
    const one = comparable(value, this.keyKind(key, defs), this.callingCode);
    return one === undefined ? [] : [one];
  }

  /**
   * A contact with a link added (or renewed) and every field with a source
   * on that record type copied from the record. A value the record no
   * longer has is dropped; one that doesn't fit its field is left out and
   * said.
   */
  private withLink(contact: Contact, defs: readonly ContactFieldDef[], link: ContactLink, row: unknown): { contact: Contact; problems: string[] } {
    const problems: string[] = [];
    const fields: Record<string, ContactField> = { ...contact.fields };
    for (const def of defs) {
      for (const source of def.sources) {
        if (source.connection !== link.connection || source.entity !== link.entity) continue;
        const raw = readField(row, source.field);
        const { record: held, ...others } = fields[def.key] ?? {};
        const fromHere = held?.ref && held.ref.connection === link.connection && held.ref.entity === link.entity;
        if (raw === undefined || raw === null || raw === "") {
          if (held && !fromHere) continue;
          if (Object.keys(others).length > 0) fields[def.key] = others;
          else delete fields[def.key];
          continue;
        }
        const mapped = source.map?.[String(raw)] ?? raw;
        const checked = fieldValueFor(def, mapped, this.callingCode);
        if (!checked.ok) {
          problems.push(checked.problem);
          continue;
        }
        fields[def.key] = { ...others, record: { value: checked.value, ref: { connection: link.connection, entity: link.entity, recordId: link.recordId, field: source.field }, at: link.syncedAt } };
      }
    }
    const links = [...contact.links.filter((one) => !(one.connection === link.connection && one.entity === link.entity)), link];
    return { contact: { ...contact, fields, links }, problems };
  }

  /** Reads one record, as someone, and finds it by its id. */
  private async readOne(as: Principal, target: { connection: string; entity: string; recordId: string }, fresh: number | string): Promise<{ row: unknown } | { problem: string }> {
    const reads = this.deps.reads;
    const where = reads?.describe?.(target.connection, target.entity) ?? `${target.connection} ${target.entity}`;
    if (!reads) return { problem: `${where} can't be read here.` };
    let answer: Awaited<ReturnType<ContactReads["read"]>>;
    try {
      answer = await reads.read(as, target, fresh);
    } catch (error) {
      return { problem: `${where} could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    if ("refused" in answer) return { problem: `${where} may not be read: ${answer.refused}` };
    const idField = reads.idField(target.connection, target.entity);
    const row = answer.rows.find((one) => recordIdOf(one, idField) === target.recordId);
    if (row) return { row };
    return { problem: answer.complete ? `That record is no longer in ${where}.` : `That record wasn't among the ones of ${where} that could be read.` };
  }

  /** A member links a contact to a record by hand: picking among several that matched, or one they know. */
  async link(id: string, target: { readonly connection: string; readonly entity: string; readonly recordId: string }, as: Principal): Promise<{ readonly contact: Contact; readonly problems: readonly string[] }> {
    const read = await this.readOne(as, target, 0);
    if ("problem" in read) throw new ContactError(read.problem, 409);
    const defs = await this.deps.store.fields();
    const at = iso(this.deps.now());
    let problems: string[] = [];
    const contact = await this.mutate(id, (current) => {
      const linked = this.withLink(current, defs, { ...target, ...this.labelOf(target, read.row), matchedOn: [], syncedAt: at, by: "member" }, read.row);
      problems = linked.problems;
      const { lastMatch: _last, ...rest } = linked.contact;
      return { ...rest, lastMatch: { outcome: "linked", detail: "Linked by a member.", at } };
    });
    return { contact, problems };
  }

  /** Unlinks a record, and drops the values copied from it. */
  async unlink(id: string, target: { readonly connection: string; readonly entity: string; readonly recordId: string }): Promise<Contact> {
    return this.mutate(id, (contact) => {
      const fields: Record<string, ContactField> = {};
      for (const [key, field] of Object.entries(contact.fields)) {
        const ref = field.record?.ref;
        const fromIt = ref && ref.connection === target.connection && ref.entity === target.entity && ref.recordId === target.recordId;
        if (!fromIt) {
          fields[key] = field;
          continue;
        }
        const { record: _record, ...others } = field;
        if (Object.keys(others).length > 0) fields[key] = others;
      }
      return { ...contact, fields, links: contact.links.filter((one) => !(one.connection === target.connection && one.entity === target.entity && one.recordId === target.recordId)) };
    });
  }

  /** Copies every linked record's values again, as a person who may read it. */
  async refresh(id: string, as?: Principal): Promise<void> {
    await this.refreshWithDetail(id, as);
  }

  async refreshWithDetail(id: string, as?: Principal): Promise<{ readonly contact: Contact; readonly problems: readonly string[] }> {
    const contact = await this.require(id);
    const rules = await this.deps.store.matchRules();
    const defs = await this.deps.store.fields();
    const problems: string[] = [];
    const rows: Array<{ link: ContactLink; row: unknown }> = [];
    for (const link of contact.links) {
      const reader = as ?? rules.find((rule) => rule.connection === link.connection && rule.entity === link.entity)?.savedBy;
      const where = this.deps.reads?.describe?.(link.connection, link.entity) ?? `${link.connection} ${link.entity}`;
      if (!reader) {
        problems.push(`Nobody's permission to read ${where} with. Refresh it from the contact.`);
        continue;
      }
      const read = await this.readOne(reader, link, 0);
      if ("problem" in read) problems.push(read.problem);
      else rows.push({ link, row: read.row });
    }
    const at = iso(this.deps.now());
    const updated =
      rows.length === 0
        ? contact
        : await this.mutate(id, (current) => {
            let next = current;
            for (const { link, row } of rows) {
              const renewed = this.withLink(next, defs, { ...link, ...this.labelOf(link, row), syncedAt: at }, row);
              problems.push(...renewed.problems);
              next = renewed.contact;
            }
            return next;
          });
    return { contact: updated, problems };
  }

  /* ── setup ───────────────────────────────────────────────────────────── */

  async putField(key: string, input: unknown): Promise<ContactFieldDef> {
    const given = contactFieldDefInputSchema.safeParse(input);
    if (!given.success) throw new ContactError(problem(given.error));
    const held = (await this.deps.store.fields()).find((one) => one.key === key);
    const now = iso(this.deps.now());
    try {
      return await this.deps.store.putField({ ...given.data, key, createdAt: held?.createdAt ?? now, updatedAt: now });
    } catch (error) {
      throw new ContactError(error instanceof Error && "issues" in error ? problem(error as ZodError) : String(error));
    }
  }

  async removeField(key: string): Promise<void> {
    const rules = await this.deps.store.matchRules();
    const using = rules.find((rule) => rule.on.some((pair) => pair.contact === key));
    if (using) throw new ContactError("A match rule matches on this field. Change that rule first.", 409);
    await this.deps.store.deleteField(key);
  }

  async putMatchRule(id: string | null, input: unknown, savedBy: Principal): Promise<ContactMatchRule> {
    const given = contactMatchRuleInputSchema.safeParse(input);
    if (!given.success) throw new ContactError(problem(given.error));
    const keys = new Set(["email", "phone", ...(await this.deps.store.fields()).map((def) => def.key)]);
    const unknown = given.data.on.find((pair) => !keys.has(pair.contact));
    if (unknown) throw new ContactError(`There is no contact field "${unknown.contact}" to match on.`);
    const held = id ? (await this.deps.store.matchRules()).find((one) => one.id === id) : undefined;
    if (id && !held) throw new ContactError("There is no such match rule.", 404);
    const now = iso(this.deps.now());
    return this.deps.store.putMatchRule({ ...given.data, id: id ?? `match-${this.deps.newId().slice(0, 12)}`, savedBy, createdAt: held?.createdAt ?? now, updatedAt: now });
  }

  async removeMatchRule(id: string): Promise<void> {
    await this.deps.store.deleteMatchRule(id);
  }
}
