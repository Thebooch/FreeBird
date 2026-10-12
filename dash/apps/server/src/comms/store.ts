import type { RowCipher } from "@freebirdai/connect/host";
import {
  commsSettingsSchema,
  commsStateSchema,
  mailDraftSchema,
  mailMessageSchema,
  type CommsSettings,
  type CommsState,
  type MailDraft,
  type MailMessage,
  type Principal,
} from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * What Communications keeps, and nothing more.
 *
 * - **The newest 100 per mailbox** (`dash_mail_recent`): headers, snippet and
 *   flags, never a body, sealed with the vault's key like a running read's
 *   rows. The second narrow exception to "no disk cache" (2026-10-06), so the
 *   inbox opens at once, after a restart too. Trimmed to 100 on every save and
 *   dropped with the mailbox.
 * - **Where each mailbox stands** (`dash_comms_mailboxes`): when it was last
 *   read, what went wrong, Gmail's history id. No mail.
 * - **What agents did** (`dash_comms_state`): by message id, never content.
 * - **Drafts** (`dash_comms_drafts`): replies an agent or a person wrote,
 *   until sent, saved or discarded. Dash's own work, not a provider's copy.
 * - **Settings** (`dash_comms_settings`): senders never made into contacts.
 */

export const KEPT_PER_MAILBOX = 100;

export interface MailboxMark {
  readonly refreshedAt?: string | undefined;
  readonly historyId?: string | undefined;
  readonly error?: string | undefined;
  /** Who turned on putting appointments in its calendar: the changes are made as them. */
  readonly calendarBy?: Principal | undefined;
  /** What went wrong putting appointments in its calendar, last time. */
  readonly calendarError?: string | undefined;
  readonly calendarAt?: string | undefined;
}

/** One appointment written into a mailbox's calendar: the event it became, and what it said then. */
export interface CalendarLink {
  readonly mailbox: string;
  /** The Dash calendar entry's id. */
  readonly entry: string;
  /** The provider's event id. */
  readonly external: string;
  /** What was written, so a change is written again and nothing else is. */
  readonly digest: string;
}

export interface CommsStore {
  /** A mailbox's kept messages, newest first. */
  recent(mailbox: string): Promise<MailMessage[]>;
  /** Replace a mailbox's kept messages with these (trimmed to the newest 100). */
  keep(mailbox: string, messages: readonly MailMessage[]): Promise<void>;
  mark(mailbox: string): Promise<MailboxMark>;
  setMark(mailbox: string, mark: MailboxMark): Promise<void>;
  /** The mailbox is gone: everything kept for it goes too. */
  forget(mailbox: string): Promise<void>;

  states(mailbox: string, messages: readonly string[]): Promise<CommsState[]>;
  putState(state: CommsState): Promise<void>;

  drafts(filter?: { readonly mailbox?: string; readonly status?: MailDraft["status"]; readonly threadId?: string }): Promise<MailDraft[]>;
  draft(id: string): Promise<MailDraft | null>;
  putDraft(draft: MailDraft): Promise<void>;

  settings(): Promise<CommsSettings>;
  putSettings(settings: CommsSettings): Promise<void>;

  calendarLinks(mailbox: string): Promise<CalendarLink[]>;
  putCalendarLink(link: CalendarLink): Promise<void>;
  deleteCalendarLink(mailbox: string, entry: string): Promise<void>;

  /** Take a notice's turn to be sent: false when it was sent (or is being sent) already. */
  claimNotice(key: string, at: string): Promise<boolean>;
  /** It did not go: it may be sent again. */
  releaseNotice(key: string): Promise<void>;
}

const newestFirst = (a: MailMessage, b: MailMessage): number => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
const trimmed = (messages: readonly MailMessage[]): MailMessage[] => {
  const unique = new Map<string, MailMessage>();
  for (const one of messages) unique.set(one.id, one);
  return [...unique.values()].sort(newestFirst).slice(0, KEPT_PER_MAILBOX);
};
const draftMatches = (draft: MailDraft, filter: { readonly mailbox?: string; readonly status?: MailDraft["status"]; readonly threadId?: string }): boolean =>
  (filter.mailbox === undefined || draft.mailbox === filter.mailbox) &&
  (filter.status === undefined || draft.status === filter.status) &&
  (filter.threadId === undefined || draft.threadId === filter.threadId);

/* ── memory ────────────────────────────────────────────────────────────── */

export class MemoryCommsStore implements CommsStore {
  private readonly kept = new Map<string, MailMessage[]>();
  private readonly marks = new Map<string, MailboxMark>();
  private readonly state = new Map<string, CommsState>();
  private readonly draftsById = new Map<string, MailDraft>();
  private held: CommsSettings = commsSettingsSchema.parse({});
  private readonly notices = new Set<string>();
  private readonly links = new Map<string, CalendarLink>();

  async recent(mailbox: string): Promise<MailMessage[]> {
    return [...(this.kept.get(mailbox) ?? [])];
  }
  async keep(mailbox: string, messages: readonly MailMessage[]): Promise<void> {
    this.kept.set(mailbox, trimmed(messages.map((one) => mailMessageSchema.parse(one))));
  }
  async mark(mailbox: string): Promise<MailboxMark> {
    return this.marks.get(mailbox) ?? {};
  }
  async setMark(mailbox: string, mark: MailboxMark): Promise<void> {
    this.marks.set(mailbox, mark);
  }
  async forget(mailbox: string): Promise<void> {
    this.kept.delete(mailbox);
    this.marks.delete(mailbox);
    for (const key of [...this.state.keys()]) if (key.startsWith(`${mailbox}\u0000`)) this.state.delete(key);
    for (const [id, draft] of [...this.draftsById]) if (draft.mailbox === mailbox) this.draftsById.delete(id);
    for (const [key, link] of [...this.links]) if (link.mailbox === mailbox) this.links.delete(key);
  }
  async states(mailbox: string, messages: readonly string[]): Promise<CommsState[]> {
    return messages.map((id) => this.state.get(`${mailbox}\u0000${id}`)).filter((one): one is CommsState => one !== undefined);
  }
  async putState(state: CommsState): Promise<void> {
    const one = commsStateSchema.parse(state);
    this.state.set(`${one.mailbox}\u0000${one.message}`, one);
  }
  async drafts(filter: { readonly mailbox?: string; readonly status?: MailDraft["status"]; readonly threadId?: string } = {}): Promise<MailDraft[]> {
    return [...this.draftsById.values()].filter((one) => draftMatches(one, filter)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async draft(id: string): Promise<MailDraft | null> {
    return this.draftsById.get(id) ?? null;
  }
  async putDraft(draft: MailDraft): Promise<void> {
    const one = mailDraftSchema.parse(draft);
    this.draftsById.set(one.id, one);
  }
  async settings(): Promise<CommsSettings> {
    return this.held;
  }
  async putSettings(settings: CommsSettings): Promise<void> {
    this.held = commsSettingsSchema.parse(settings);
  }
  async claimNotice(key: string, _at?: string): Promise<boolean> {
    if (this.notices.has(key)) return false;
    this.notices.add(key);
    return true;
  }
  async releaseNotice(key: string): Promise<void> {
    this.notices.delete(key);
  }
  async calendarLinks(mailbox: string): Promise<CalendarLink[]> {
    return [...this.links.values()].filter((one) => one.mailbox === mailbox);
  }
  async putCalendarLink(link: CalendarLink): Promise<void> {
    this.links.set(`${link.mailbox}\u0000${link.entry}`, link);
  }
  async deleteCalendarLink(mailbox: string, entry: string): Promise<void> {
    this.links.delete(`${mailbox}\u0000${entry}`);
  }
}

/* ── Dash's database ───────────────────────────────────────────────────── */

const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

export class DbCommsStore implements CommsStore {
  constructor(
    private readonly db: DashDb,
    private readonly cipher: RowCipher,
    private readonly workspace = "local",
  ) {}

  async recent(mailbox: string): Promise<MailMessage[]> {
    const result = await sql<{ record: string }>`
      SELECT record FROM dash_mail_recent WHERE workspace = ${this.workspace} AND mailbox = ${mailbox} ORDER BY at DESC, message_id DESC
    `.execute(this.db.kysely);
    const out: MailMessage[] = [];
    for (const row of result.rows) {
      try {
        out.push(mailMessageSchema.parse(JSON.parse(this.cipher.decrypt(row.record))));
      } catch {
        /* Sealed under another key, or damaged: read again from the provider. */
      }
    }
    return out;
  }
  async keep(mailbox: string, messages: readonly MailMessage[]): Promise<void> {
    const rows = trimmed(messages.map((one) => mailMessageSchema.parse(one)));
    await this.db.kysely.transaction().execute(async (tx) => {
      await sql`DELETE FROM dash_mail_recent WHERE workspace = ${this.workspace} AND mailbox = ${mailbox}`.execute(tx);
      for (const one of rows) {
        await sql`
          INSERT INTO dash_mail_recent (workspace, mailbox, message_id, at, record)
          VALUES (${this.workspace}, ${mailbox}, ${one.id}, ${one.at}, ${this.cipher.encrypt(JSON.stringify(one))})
        `.execute(tx);
      }
    });
  }
  async mark(mailbox: string): Promise<MailboxMark> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_comms_mailboxes WHERE workspace = ${this.workspace} AND mailbox = ${mailbox}`.execute(this.db.kysely);
    return (result.rows[0] ? parsed(result.rows[0].record) : {}) as MailboxMark;
  }
  async setMark(mailbox: string, mark: MailboxMark): Promise<void> {
    await sql`
      INSERT INTO dash_comms_mailboxes (workspace, mailbox, record) VALUES (${this.workspace}, ${mailbox}, ${JSON.stringify(mark)}::jsonb)
      ON CONFLICT (workspace, mailbox) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async forget(mailbox: string): Promise<void> {
    for (const table of ["dash_mail_recent", "dash_comms_mailboxes", "dash_comms_state", "dash_comms_drafts", "dash_comms_calendar"] as const) {
      await sql`DELETE FROM ${sql.table(table)} WHERE workspace = ${this.workspace} AND mailbox = ${mailbox}`.execute(this.db.kysely);
    }
  }
  async states(mailbox: string, messages: readonly string[]): Promise<CommsState[]> {
    if (messages.length === 0) return [];
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_comms_state WHERE workspace = ${this.workspace} AND mailbox = ${mailbox} AND message_id = ANY(${[...messages]}::text[])
    `.execute(this.db.kysely);
    return result.rows.map((row) => commsStateSchema.parse(parsed(row.record)));
  }
  async putState(state: CommsState): Promise<void> {
    const one = commsStateSchema.parse(state);
    await sql`
      INSERT INTO dash_comms_state (workspace, mailbox, message_id, record) VALUES (${this.workspace}, ${one.mailbox}, ${one.message}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, mailbox, message_id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async drafts(filter: { readonly mailbox?: string; readonly status?: MailDraft["status"]; readonly threadId?: string } = {}): Promise<MailDraft[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_comms_drafts
      WHERE workspace = ${this.workspace} AND (${filter.mailbox ?? null}::text IS NULL OR mailbox = ${filter.mailbox ?? null})
      ORDER BY updated_at DESC LIMIT 1000
    `.execute(this.db.kysely);
    return result.rows.map((row) => mailDraftSchema.parse(parsed(row.record))).filter((one) => draftMatches(one, filter));
  }
  async draft(id: string): Promise<MailDraft | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_comms_drafts WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
    return result.rows[0] ? mailDraftSchema.parse(parsed(result.rows[0].record)) : null;
  }
  async putDraft(draft: MailDraft): Promise<void> {
    const one = mailDraftSchema.parse(draft);
    await sql`
      INSERT INTO dash_comms_drafts (workspace, id, mailbox, updated_at, record) VALUES (${this.workspace}, ${one.id}, ${one.mailbox}, ${one.updatedAt}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET record = EXCLUDED.record, updated_at = EXCLUDED.updated_at, mailbox = EXCLUDED.mailbox
    `.execute(this.db.kysely);
  }
  async settings(): Promise<CommsSettings> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_comms_settings WHERE workspace = ${this.workspace}`.execute(this.db.kysely);
    return commsSettingsSchema.parse(result.rows[0] ? parsed(result.rows[0].record) : {});
  }
  async putSettings(settings: CommsSettings): Promise<void> {
    const one = commsSettingsSchema.parse(settings);
    await sql`
      INSERT INTO dash_comms_settings (workspace, record) VALUES (${this.workspace}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async claimNotice(key: string, at: string): Promise<boolean> {
    /* One statement: of two servers sending the same notice, one inserts. */
    const result = await sql<{ key: string }>`
      INSERT INTO dash_comms_notices (workspace, key, at) VALUES (${this.workspace}, ${key}, ${at})
      ON CONFLICT (workspace, key) DO NOTHING RETURNING key
    `.execute(this.db.kysely);
    return result.rows.length > 0;
  }
  async releaseNotice(key: string): Promise<void> {
    await sql`DELETE FROM dash_comms_notices WHERE workspace = ${this.workspace} AND key = ${key}`.execute(this.db.kysely);
  }
  async calendarLinks(mailbox: string): Promise<CalendarLink[]> {
    const result = await sql<{ entry: string; external: string; digest: string }>`
      SELECT entry, external, digest FROM dash_comms_calendar WHERE workspace = ${this.workspace} AND mailbox = ${mailbox}
    `.execute(this.db.kysely);
    return result.rows.map((row) => ({ mailbox, entry: row.entry, external: row.external, digest: row.digest }));
  }
  async putCalendarLink(link: CalendarLink): Promise<void> {
    await sql`
      INSERT INTO dash_comms_calendar (workspace, mailbox, entry, external, digest) VALUES (${this.workspace}, ${link.mailbox}, ${link.entry}, ${link.external}, ${link.digest})
      ON CONFLICT (workspace, mailbox, entry) DO UPDATE SET external = EXCLUDED.external, digest = EXCLUDED.digest
    `.execute(this.db.kysely);
  }
  async deleteCalendarLink(mailbox: string, entry: string): Promise<void> {
    await sql`DELETE FROM dash_comms_calendar WHERE workspace = ${this.workspace} AND mailbox = ${mailbox} AND entry = ${entry}`.execute(this.db.kysely);
  }
}
