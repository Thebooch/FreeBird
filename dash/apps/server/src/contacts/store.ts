import {
  contactFieldDefSchema,
  contactKeys,
  contactMatchRuleSchema,
  contactSchema,
  type Contact,
  type ContactFieldDef,
  type ContactMatchRule,
} from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * Where contacts are kept, with the setup that fills their fields.
 *
 * A contact's emails and phones are its **keys**, and a key belongs to one
 * contact at most. `put` claims a contact's keys in the same step that saves
 * it, so two people booking with one email at the same moment end up as one
 * contact: the second save is refused with the contact that holds the key,
 * and the caller uses that one.
 */

export interface ContactListOptions {
  /** Matched against the name, emails and phones. */
  readonly search?: string;
  readonly limit?: number;
  /** The id the previous page ended on. */
  readonly after?: string;
}

export type PutResult =
  | { readonly ok: true; readonly contact: Contact }
  /** `revision`: someone saved it since it was read. `taken`: another contact holds one of its keys. */
  | { readonly ok: false; readonly reason: "revision" | "taken"; readonly holder?: string; readonly key?: string };

export interface ContactStore {
  get(id: string): Promise<Contact | null>;
  /** The contact holding a key ("email:…", "phone:…"). */
  byKey(key: string): Promise<Contact | null>;
  /** Saves a contact and claims its keys. `expect` is the revision it was read at; a contact not yet saved expects none. */
  put(contact: Contact, expect?: number): Promise<PutResult>;
  delete(id: string): Promise<void>;
  list(options?: ContactListOptions): Promise<{ readonly contacts: readonly Contact[]; readonly next?: string }>;

  fields(): Promise<ContactFieldDef[]>;
  putField(def: ContactFieldDef): Promise<ContactFieldDef>;
  deleteField(key: string): Promise<void>;

  matchRules(): Promise<ContactMatchRule[]>;
  putMatchRule(rule: ContactMatchRule): Promise<ContactMatchRule>;
  deleteMatchRule(id: string): Promise<void>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const matches = (contact: Contact, search: string): boolean => {
  const wanted = search.trim().toLowerCase();
  if (!wanted) return true;
  const digits = wanted.replace(/\D/g, "");
  return (
    contact.name.toLowerCase().includes(wanted) ||
    contact.emails.some((email) => email.includes(wanted)) ||
    (digits.length >= 3 && contact.phones.some((phone) => phone.includes(digits)))
  );
};

const byOrder = (a: ContactFieldDef, b: ContactFieldDef): number => (a.order ?? 1e9) - (b.order ?? 1e9) || a.label.localeCompare(b.label);

export class MemoryContactStore implements ContactStore {
  private readonly contacts = new Map<string, Contact>();
  private readonly keys = new Map<string, string>();
  private readonly defs = new Map<string, ContactFieldDef>();
  private readonly rules = new Map<string, ContactMatchRule>();

  async get(id: string): Promise<Contact | null> {
    return this.contacts.get(id) ?? null;
  }
  async byKey(key: string): Promise<Contact | null> {
    const id = this.keys.get(key);
    return id ? (this.contacts.get(id) ?? null) : null;
  }
  async put(contact: Contact, expect?: number): Promise<PutResult> {
    const one = contactSchema.parse(contact);
    const held = this.contacts.get(one.id);
    if ((held?.revision ?? undefined) !== expect) return { ok: false, reason: "revision" };
    const wanted = contactKeys(one);
    const clash = wanted.find((key) => (this.keys.get(key) ?? one.id) !== one.id);
    if (clash) return { ok: false, reason: "taken", holder: this.keys.get(clash)!, key: clash };
    for (const [key, id] of [...this.keys]) if (id === one.id && !wanted.includes(key)) this.keys.delete(key);
    for (const key of wanted) this.keys.set(key, one.id);
    this.contacts.set(one.id, one);
    return { ok: true, contact: one };
  }
  async delete(id: string): Promise<void> {
    this.contacts.delete(id);
    for (const [key, holder] of [...this.keys]) if (holder === id) this.keys.delete(key);
  }
  async list(options: ContactListOptions = {}): Promise<{ contacts: Contact[]; next?: string }> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const all = [...this.contacts.values()]
      .filter((one) => matches(one, options.search ?? ""))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const start = options.after ? all.findIndex((one) => one.id === options.after) + 1 : 0;
    const page = all.slice(start, start + limit);
    return { contacts: page, ...(start + limit < all.length && page.length > 0 ? { next: page.at(-1)!.id } : {}) };
  }

  async fields(): Promise<ContactFieldDef[]> {
    return [...this.defs.values()].sort(byOrder);
  }
  async putField(def: ContactFieldDef): Promise<ContactFieldDef> {
    const one = contactFieldDefSchema.parse(def);
    this.defs.set(one.key, one);
    return one;
  }
  async deleteField(key: string): Promise<void> {
    this.defs.delete(key);
  }

  async matchRules(): Promise<ContactMatchRule[]> {
    return [...this.rules.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async putMatchRule(rule: ContactMatchRule): Promise<ContactMatchRule> {
    const one = contactMatchRuleSchema.parse(rule);
    this.rules.set(one.id, one);
    return one;
  }
  async deleteMatchRule(id: string): Promise<void> {
    this.rules.delete(id);
  }
}

const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

/**
 * Contacts in `dash_contacts`, their keys in `dash_contact_keys` (one row per
 * key, the key the primary key, so the database refuses a second holder),
 * and field definitions and match rules in `dash_contact_setup`.
 */
export class DbContactStore implements ContactStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async get(id: string): Promise<Contact | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_contacts WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? contactSchema.parse(parsed(row.record)) : null;
  }

  async byKey(key: string): Promise<Contact | null> {
    const result = await sql<{ record: unknown }>`
      SELECT c.record FROM dash_contact_keys k JOIN dash_contacts c ON c.workspace = k.workspace AND c.id = k.contact
      WHERE k.workspace = ${this.workspace} AND k.key = ${key}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? contactSchema.parse(parsed(row.record)) : null;
  }

  async put(contact: Contact, expect?: number): Promise<PutResult> {
    const one = contactSchema.parse(contact);
    const wanted = contactKeys(one);
    const workspace = this.workspace;
    /* Thrown inside the transaction to roll it back, and turned into the answer outside it. */
    class Refused extends Error {
      constructor(readonly result: PutResult) {
        super("refused");
      }
    }
    try {
      await this.db.kysely.transaction().execute(async (trx) => {
        if (expect === undefined) {
          const inserted = await sql`
            INSERT INTO dash_contacts (workspace, id, revision, updated_at, record)
            VALUES (${workspace}, ${one.id}, ${one.revision}, ${one.updatedAt}, ${JSON.stringify(one)}::jsonb)
            ON CONFLICT (workspace, id) DO NOTHING
          `.execute(trx);
          if (Number(inserted.numAffectedRows ?? 0) === 0) throw new Refused({ ok: false, reason: "revision" });
        } else {
          const updated = await sql`
            UPDATE dash_contacts SET revision = ${one.revision}, updated_at = ${one.updatedAt}, record = ${JSON.stringify(one)}::jsonb
            WHERE workspace = ${workspace} AND id = ${one.id} AND revision = ${expect}
          `.execute(trx);
          if (Number(updated.numAffectedRows ?? 0) === 0) throw new Refused({ ok: false, reason: "revision" });
        }
        await sql`DELETE FROM dash_contact_keys WHERE workspace = ${workspace} AND contact = ${one.id}`.execute(trx);
        for (const key of wanted) {
          const claimed = await sql`
            INSERT INTO dash_contact_keys (workspace, key, contact) VALUES (${workspace}, ${key}, ${one.id})
            ON CONFLICT (workspace, key) DO NOTHING
          `.execute(trx);
          if (Number(claimed.numAffectedRows ?? 0) === 0) {
            const holder = await sql<{ contact: string }>`SELECT contact FROM dash_contact_keys WHERE workspace = ${workspace} AND key = ${key}`.execute(trx);
            throw new Refused({ ok: false, reason: "taken", key, ...(holder.rows[0] ? { holder: holder.rows[0].contact } : {}) });
          }
        }
      });
    } catch (error) {
      if (error instanceof Refused) return error.result;
      throw error;
    }
    return { ok: true, contact: one };
  }

  async delete(id: string): Promise<void> {
    await this.db.kysely.transaction().execute(async (trx) => {
      await sql`DELETE FROM dash_contact_keys WHERE workspace = ${this.workspace} AND contact = ${id}`.execute(trx);
      await sql`DELETE FROM dash_contacts WHERE workspace = ${this.workspace} AND id = ${id}`.execute(trx);
    });
  }

  async list(options: ContactListOptions = {}): Promise<{ contacts: Contact[]; next?: string }> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const search = (options.search ?? "").trim().toLowerCase();
    const like = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const digits = search.replace(/\D/g, "");
    const after = options.after
      ? (await sql<{ updated_at: string }>`SELECT updated_at FROM dash_contacts WHERE workspace = ${this.workspace} AND id = ${options.after}`.execute(this.db.kysely)).rows[0]
      : undefined;
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_contacts
      WHERE workspace = ${this.workspace}
        ${search ? sql`AND (lower(record->>'name') LIKE ${like} OR (record->>'emails') LIKE ${like}${digits.length >= 3 ? sql` OR (record->>'phones') LIKE ${`%${digits}%`}` : sql``})` : sql``}
        ${after ? sql`AND (updated_at, id) < (${after.updated_at}, ${options.after})` : sql``}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limit + 1}
    `.execute(this.db.kysely);
    const contacts = result.rows.map((row) => contactSchema.parse(parsed(row.record)));
    const page = contacts.slice(0, limit);
    return { contacts: page, ...(contacts.length > limit ? { next: page.at(-1)!.id } : {}) };
  }

  private async setup<T>(kind: "field" | "match_rule", parse: (value: unknown) => T): Promise<T[]> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_contact_setup WHERE workspace = ${this.workspace} AND kind = ${kind} ORDER BY id`.execute(this.db.kysely);
    return result.rows.map((row) => parse(parsed(row.record)));
  }
  private async putSetup(kind: "field" | "match_rule", id: string, record: unknown): Promise<void> {
    await sql`
      INSERT INTO dash_contact_setup (workspace, kind, id, record) VALUES (${this.workspace}, ${kind}, ${id}, ${JSON.stringify(record)}::jsonb)
      ON CONFLICT (workspace, kind, id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  private async deleteSetup(kind: "field" | "match_rule", id: string): Promise<void> {
    await sql`DELETE FROM dash_contact_setup WHERE workspace = ${this.workspace} AND kind = ${kind} AND id = ${id}`.execute(this.db.kysely);
  }

  async fields(): Promise<ContactFieldDef[]> {
    return (await this.setup("field", (value) => contactFieldDefSchema.parse(value))).sort(byOrder);
  }
  async putField(def: ContactFieldDef): Promise<ContactFieldDef> {
    const one = contactFieldDefSchema.parse(def);
    await this.putSetup("field", one.key, one);
    return one;
  }
  async deleteField(key: string): Promise<void> {
    await this.deleteSetup("field", key);
  }

  async matchRules(): Promise<ContactMatchRule[]> {
    return (await this.setup("match_rule", (value) => contactMatchRuleSchema.parse(value))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async putMatchRule(rule: ContactMatchRule): Promise<ContactMatchRule> {
    const one = contactMatchRuleSchema.parse(rule);
    await this.putSetup("match_rule", one.id, one);
    return one;
  }
  async deleteMatchRule(id: string): Promise<void> {
    await this.deleteSetup("match_rule", id);
  }
}
