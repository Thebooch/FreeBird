import type { RowCipher } from "@freebirdai/connect/host";
import { phoneTextSchema, type PhoneText } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * What Communications keeps of a line's texts: the newest `KEPT_TEXTS` per
 * line, in and out, sealed with the vault's key like the newest mail, and
 * one row per conversation (a line and one number) saying who wrote first.
 * The thread row outlives the texts it was made from, so "they texted this
 * line first" is still known after the texts themselves are trimmed.
 *
 * A text is kept once by its provider id: a webhook delivered twice adds
 * nothing.
 */

export const KEPT_TEXTS = 500;

export interface PhoneThread {
  readonly line: string;
  readonly number: string;
  readonly startedBy: "them" | "us";
  readonly firstAt: string;
  readonly lastAt: string;
}

export interface PhoneTextStore {
  /** Keeps a text and moves its thread on. False when it was already kept. */
  add(text: PhoneText): Promise<boolean>;
  update(line: string, id: string, patch: Partial<Pick<PhoneText, "status" | "held" | "screen" | "contact">>): Promise<void>;
  get(line: string, id: string): Promise<PhoneText | null>;
  /** One conversation, newest first. */
  thread(line: string, number: string, limit?: number): Promise<PhoneText[]>;
  /** A line's conversations, the latest first. */
  threads(line: string, limit?: number): Promise<PhoneThread[]>;
  threadOf(line: string, number: string): Promise<PhoneThread | null>;
}

const limitOf = (limit: number | undefined, max = 500): number => Math.min(Math.max(limit ?? 100, 1), max);
const newestFirst = (a: PhoneText, b: PhoneText) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

export class MemoryPhoneTextStore implements PhoneTextStore {
  /** By `line\u0000id`. */
  readonly texts = new Map<string, PhoneText>();
  /** By `line\u0000number`. */
  readonly threadRows = new Map<string, PhoneThread>();

  async add(text: PhoneText): Promise<boolean> {
    const one = phoneTextSchema.parse(text);
    const id = `${one.line}\u0000${one.id}`;
    if (this.texts.has(id)) return false;
    this.texts.set(id, one);
    const key = `${one.line}\u0000${one.number}`;
    const held = this.threadRows.get(key);
    this.threadRows.set(key, held ? { ...held, lastAt: one.at > held.lastAt ? one.at : held.lastAt } : { line: one.line, number: one.number, startedBy: one.direction === "in" ? "them" : "us", firstAt: one.at, lastAt: one.at });
    const onLine = [...this.texts.values()].filter((row) => row.line === one.line).sort(newestFirst);
    for (const old of onLine.slice(KEPT_TEXTS)) this.texts.delete(`${old.line}\u0000${old.id}`);
    return true;
  }

  async update(line: string, id: string, patch: Partial<Pick<PhoneText, "status" | "held" | "screen" | "contact">>): Promise<void> {
    const held = this.texts.get(`${line}\u0000${id}`);
    if (held) this.texts.set(`${line}\u0000${id}`, phoneTextSchema.parse({ ...held, ...patch }));
  }

  async get(line: string, id: string): Promise<PhoneText | null> {
    return this.texts.get(`${line}\u0000${id}`) ?? null;
  }

  async thread(line: string, number: string, limit?: number): Promise<PhoneText[]> {
    return [...this.texts.values()].filter((one) => one.line === line && one.number === number).sort(newestFirst).slice(0, limitOf(limit));
  }

  async threads(line: string, limit?: number): Promise<PhoneThread[]> {
    return [...this.threadRows.values()].filter((one) => one.line === line).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limitOf(limit));
  }

  async threadOf(line: string, number: string): Promise<PhoneThread | null> {
    return this.threadRows.get(`${line}\u0000${number}`) ?? null;
  }
}

interface ThreadRow {
  line: string;
  number: string;
  started_by: string;
  first_at: string;
  last_at: string;
}
const threadOfRow = (row: ThreadRow): PhoneThread => ({ line: row.line, number: row.number, startedBy: row.started_by === "them" ? "them" : "us", firstAt: row.first_at, lastAt: row.last_at });

export class DbPhoneTextStore implements PhoneTextStore {
  constructor(
    private readonly db: DashDb,
    private readonly cipher: RowCipher,
    private readonly workspace = "local",
  ) {}

  private open(record: string): PhoneText | null {
    try {
      return phoneTextSchema.parse(JSON.parse(this.cipher.decrypt(record)));
    } catch {
      /* Sealed under another key, or damaged: left out. */
      return null;
    }
  }

  async add(text: PhoneText): Promise<boolean> {
    const one = phoneTextSchema.parse(text);
    return this.db.kysely.transaction().execute(async (tx) => {
      const inserted = await sql<{ id: string }>`
        INSERT INTO dash_phone_texts (workspace, line, id, number, at, record)
        VALUES (${this.workspace}, ${one.line}, ${one.id}, ${one.number}, ${one.at}, ${this.cipher.encrypt(JSON.stringify(one))})
        ON CONFLICT (workspace, line, id) DO NOTHING
        RETURNING id
      `.execute(tx);
      if (inserted.rows.length === 0) return false;
      await sql`
        INSERT INTO dash_phone_threads (workspace, line, number, started_by, first_at, last_at)
        VALUES (${this.workspace}, ${one.line}, ${one.number}, ${one.direction === "in" ? "them" : "us"}, ${one.at}, ${one.at})
        ON CONFLICT (workspace, line, number) DO UPDATE SET last_at = GREATEST(dash_phone_threads.last_at, EXCLUDED.last_at)
      `.execute(tx);
      await sql`
        DELETE FROM dash_phone_texts WHERE workspace = ${this.workspace} AND line = ${one.line} AND id IN (
          SELECT id FROM dash_phone_texts WHERE workspace = ${this.workspace} AND line = ${one.line} ORDER BY at DESC, id DESC OFFSET ${KEPT_TEXTS}
        )
      `.execute(tx);
      return true;
    });
  }

  async update(line: string, id: string, patch: Partial<Pick<PhoneText, "status" | "held" | "screen" | "contact">>): Promise<void> {
    const held = await this.get(line, id);
    if (!held) return;
    const next = phoneTextSchema.parse({ ...held, ...patch });
    await sql`UPDATE dash_phone_texts SET record = ${this.cipher.encrypt(JSON.stringify(next))} WHERE workspace = ${this.workspace} AND line = ${line} AND id = ${id}`.execute(this.db.kysely);
  }

  async get(line: string, id: string): Promise<PhoneText | null> {
    const result = await sql<{ record: string }>`SELECT record FROM dash_phone_texts WHERE workspace = ${this.workspace} AND line = ${line} AND id = ${id}`.execute(this.db.kysely);
    return result.rows[0] ? this.open(result.rows[0].record) : null;
  }

  async thread(line: string, number: string, limit?: number): Promise<PhoneText[]> {
    const result = await sql<{ record: string }>`
      SELECT record FROM dash_phone_texts WHERE workspace = ${this.workspace} AND line = ${line} AND number = ${number} ORDER BY at DESC, id DESC LIMIT ${limitOf(limit)}
    `.execute(this.db.kysely);
    return result.rows.flatMap((row) => this.open(row.record) ?? []);
  }

  async threads(line: string, limit?: number): Promise<PhoneThread[]> {
    const result = await sql<ThreadRow>`SELECT * FROM dash_phone_threads WHERE workspace = ${this.workspace} AND line = ${line} ORDER BY last_at DESC LIMIT ${limitOf(limit)}`.execute(this.db.kysely);
    return result.rows.map(threadOfRow);
  }

  async threadOf(line: string, number: string): Promise<PhoneThread | null> {
    const result = await sql<ThreadRow>`SELECT * FROM dash_phone_threads WHERE workspace = ${this.workspace} AND line = ${line} AND number = ${number}`.execute(this.db.kysely);
    return result.rows[0] ? threadOfRow(result.rows[0]) : null;
  }
}
