import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { DashDb } from "../platform/db.js";

/**
 * Tokens for pages anyone may open: a contact's booking link, and a team
 * member's approval link. The token itself is 32 random bytes, handed out
 * once; only its SHA-256 is kept, as with invites, so the store never holds
 * anything that opens a page.
 *
 * - A **booking link** is one contact's (with a type, host or record when it
 *   was made for one). It lives 30 days, and while a booking on it is active.
 * - An **approval** link is one member's, for one booking and the one
 *   Approve a booking step waiting on it. It expires with the step's
 *   deadline, is spent when used, and is revoked when the step finishes.
 * - A **calendar feed** is one member's own calendar as `.ics`, read-only,
 *   for their phone. Making a new one stops the old.
 */

export const TOKEN_PURPOSES = ["booking_link", "approval", "calendar_feed"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export const publicTokenSchema = z.object({
  id: z.string(),
  hash: z.string(),
  purpose: z.enum(TOKEN_PURPOSES),
  contact: z.string().optional(),
  type: z.string().optional(),
  host: z.string().optional(),
  subject: z.object({ connection: z.string(), entity: z.string(), recordId: z.string() }).optional(),
  booking: z.string().optional(),
  /**
   * Made on a public link, where anyone can type an email: it shows and
   * changes only the bookings made through it, never the contact's others.
   */
  fromPublic: z.boolean().optional(),
  member: z.string().optional(),
  /** The Approve a booking task it answers, and the try of its step it was made for. */
  task: z.string().optional(),
  attempt: z.string().optional(),
  expiresAt: z.string(),
  usedAt: z.string().optional(),
  /** Who used it: what the page could tell, kept with the answer. */
  usedBy: z.object({ ip: z.string().optional(), userAgent: z.string().optional() }).optional(),
  revokedAt: z.string().optional(),
  createdAt: z.string(),
});
export type PublicToken = z.infer<typeof publicTokenSchema>;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A fresh token and the record to keep for it. */
export const mintToken = (fields: Omit<PublicToken, "id" | "hash" | "createdAt">, now: number): { readonly token: string; readonly record: PublicToken } => {
  const token = randomBytes(32).toString("base64url");
  return { token, record: publicTokenSchema.parse({ ...fields, id: randomUUID(), hash: hashToken(token), createdAt: new Date(now).toISOString() }) };
};

export interface TokenFilter {
  readonly task?: string;
  readonly contact?: string;
  readonly member?: string;
  readonly purpose?: TokenPurpose;
}

export interface PublicTokenStore {
  put(token: PublicToken): Promise<void>;
  /** The token a presented value is, by its hash. */
  byHash(hash: string): Promise<PublicToken | null>;
  /** Tokens of one task, contact or member, and of one purpose. */
  list(filter: TokenFilter): Promise<PublicToken[]>;
}

export class MemoryPublicTokenStore implements PublicTokenStore {
  private readonly tokens = new Map<string, PublicToken>();
  async put(token: PublicToken): Promise<void> {
    this.tokens.set(token.id, publicTokenSchema.parse(token));
  }
  async byHash(hash: string): Promise<PublicToken | null> {
    return [...this.tokens.values()].find((one) => one.hash === hash) ?? null;
  }
  async list(filter: TokenFilter): Promise<PublicToken[]> {
    return [...this.tokens.values()].filter(
      (one) =>
        (filter.task === undefined || one.task === filter.task) &&
        (filter.contact === undefined || one.contact === filter.contact) &&
        (filter.member === undefined || one.member === filter.member) &&
        (filter.purpose === undefined || one.purpose === filter.purpose),
    );
  }
}

const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

/** Tokens in `dash_public_tokens`, found by their hash. */
export class DbPublicTokenStore implements PublicTokenStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}
  async put(token: PublicToken): Promise<void> {
    const one = publicTokenSchema.parse(token);
    await sql`
      INSERT INTO dash_public_tokens (workspace, id, hash, purpose, task, contact, record)
      VALUES (${this.workspace}, ${one.id}, ${one.hash}, ${one.purpose}, ${one.task ?? null}, ${one.contact ?? null}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async byHash(hash: string): Promise<PublicToken | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_public_tokens WHERE workspace = ${this.workspace} AND hash = ${hash}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? publicTokenSchema.parse(parsed(row.record)) : null;
  }
  async list(filter: TokenFilter): Promise<PublicToken[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_public_tokens WHERE workspace = ${this.workspace}
        ${filter.task !== undefined ? sql`AND task = ${filter.task}` : sql``}
        ${filter.contact !== undefined ? sql`AND contact = ${filter.contact}` : sql``}
        ${filter.member !== undefined ? sql`AND record->>'member' = ${filter.member}` : sql``}
        ${filter.purpose !== undefined ? sql`AND purpose = ${filter.purpose}` : sql``}
      ORDER BY id
    `.execute(this.db.kysely);
    return result.rows.map((row) => publicTokenSchema.parse(parsed(row.record)));
  }
}

/** Why a presented token can't be used, or null when it can. */
export const tokenProblem = (token: PublicToken | null, purpose: TokenPurpose, now: number, options: { readonly activeBooking?: boolean; readonly answering?: boolean } = {}): string | null => {
  if (!token || token.purpose !== purpose) return "This link isn't valid.";
  /* A used or closed approval link still opens, to show what was decided; it can't answer again. */
  if (purpose === "approval" && token.usedAt && options.answering) return "This link has been used.";
  if (token.revokedAt && (options.answering || purpose !== "approval")) return "This link was replaced or withdrawn.";
  if (Date.parse(token.expiresAt) <= now && !options.activeBooking) return "This link has expired.";
  return null;
};
