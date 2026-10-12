import { idSchema, type MailboxOwner } from "@freebirdai/connect-spec";
import { z } from "zod";

/**
 * Communications: mail now, texts and calls later (plan 7, then 9).
 *
 * A mailbox is a connection (`connectionSchema.mailbox`): Gmail or Outlook,
 * signed in to through the engine's OAuth, read through the engine's single
 * read and sent through the write service's review. Everything here is the
 * one shape both providers are brought to, and what Dash itself keeps:
 *
 * - **messages** are read live; only the newest 100 per mailbox are kept
 *   (headers, snippet and flags, sealed with the vault's key) so the inbox
 *   opens at once. Bodies are never kept.
 * - **areas**: a mailbox is the team's own (Your comms) or one agent's
 *   (Agent comms), as its owner says. Mail never moves between them.
 * - **drafts** an agent wrote wait here for a person, who edits, sends,
 *   saves to the provider's drafts or discards them.
 * - **state**: what an agent did with a message, by id only, never content.
 */

export const mailAddressSchema = z.object({
  address: z.string().max(320),
  name: z.string().max(200).optional(),
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

/** One message, the same from either provider. No body: bodies are read live in the thread. */
export const mailMessageSchema = z.object({
  id: z.string().min(1).max(400),
  threadId: z.string().max(400),
  /** The mailbox (connection) it was read from. */
  mailbox: idSchema,
  from: mailAddressSchema.optional(),
  to: z.array(mailAddressSchema).max(200).default([]),
  cc: z.array(mailAddressSchema).max(200).default([]),
  subject: z.string().max(1000).default(""),
  snippet: z.string().max(1000).default(""),
  /** When it arrived or was sent, ISO. */
  at: z.string(),
  unread: z.boolean().default(false),
  /** Sent from this mailbox, rather than received by it. */
  sent: z.boolean().default(false),
  labels: z.array(z.string().max(120)).max(100).default([]),
  hasAttachments: z.boolean().default(false),
  /** Its Message-ID header, for a reply to thread under it. */
  messageId: z.string().max(1000).optional(),
  references: z.string().max(4000).optional(),
});
export type MailMessage = z.infer<typeof mailMessageSchema>;

/** A message in a thread, with its text, read live and never kept. */
export interface MailThreadMessage extends MailMessage {
  readonly text: string;
}

/** Which part of Communications: the team's own mail, or one agent's. */
export type CommsArea = { readonly kind: "team" } | { readonly kind: "agent"; readonly id: string };

export const areaOf = (owner: MailboxOwner | undefined): CommsArea => (owner?.kind === "agent" ? { kind: "agent", id: owner.id } : { kind: "team" });

/** `team` or `agent:<id>`, as an address and a query say it. */
export const areaKey = (area: CommsArea): string => (area.kind === "team" ? "team" : `agent:${area.id}`);

export const parseAreaKey = (key: string | undefined): CommsArea | null => {
  if (!key || key === "team") return { kind: "team" };
  const match = /^agent:([A-Za-z0-9_-]{1,80})$/.exec(key);
  return match ? { kind: "agent", id: match[1]! } : null;
};

/** A mailbox as Communications shows it. */
export interface MailboxView {
  readonly id: string;
  readonly title: string;
  readonly provider: "gmail" | "outlook";
  readonly address?: string | undefined;
  readonly owner: MailboxOwner;
  /** Signed in and readable; otherwise what it needs. */
  readonly status: "ready" | "needs_app" | "needs_sign_in";
  /** How many of its newest are kept for a fast open. */
  readonly kept: number;
  readonly refreshedAt?: string | undefined;
  readonly error?: string | undefined;
}

/** One page of the merged list: newest first across every mailbox asked for. */
export interface MailPage {
  readonly messages: readonly (MailMessage & { readonly agent?: string | undefined; readonly status?: CommsStatus | undefined; readonly draft?: string | undefined })[];
  /** Where to carry on: per mailbox, or absent when every one has been read to its end. */
  readonly cursor?: string | undefined;
  /** Mailboxes that could not be read this time, with why. */
  readonly problems: readonly { readonly mailbox: string; readonly message: string }[];
  /** A search: it asked each provider's own index, not only what is kept. */
  readonly searched?: boolean | undefined;
  /** Mailboxes whose search stopped at the provider's limit, or whose results are not in date order. */
  readonly capped?: readonly string[] | undefined;
}

/* ── what Dash keeps ───────────────────────────────────────────────────── */

export const COMMS_STATUSES = ["new", "triaged", "drafted", "replied", "ignored"] as const;
export type CommsStatus = (typeof COMMS_STATUSES)[number];

/** What an agent did with one message. Keyed by id; never its content. */
export const commsStateSchema = z.object({
  mailbox: idSchema,
  message: z.string().min(1).max(400),
  agent: idSchema.optional(),
  status: z.enum(COMMS_STATUSES),
  note: z.string().max(400).optional(),
  /** Contacts and agents have seen it: it is not looked at again. */
  processed: z.boolean().optional(),
  updatedAt: z.string(),
});
export type CommsState = z.infer<typeof commsStateSchema>;

export const DRAFT_STATUSES = ["open", "sent", "saved", "discarded", "failed"] as const;
export type MailDraftStatus = (typeof DRAFT_STATUSES)[number];

/**
 * A reply an agent wrote, waiting for a person (or one a person started).
 * The text is kept until it is sent, saved or discarded: it is Dash's own
 * work, not a copy of a provider's mail.
 */
export const mailDraftSchema = z.object({
  id: idSchema,
  /** The mailbox it goes out from. */
  mailbox: idSchema,
  /** The message it answers, and that message's thread. */
  replyTo: z.string().max(400).optional(),
  threadId: z.string().max(400).optional(),
  to: z.string().max(4000),
  cc: z.string().max(4000).default(""),
  subject: z.string().max(1000).default(""),
  text: z.string().max(100_000),
  inReplyTo: z.string().max(1000).optional(),
  references: z.string().max(4000).optional(),
  /** The agent that wrote it, which the sent message is labelled with. */
  agent: idSchema.optional(),
  /** The workflow step it came from: sending it wakes that case. */
  workflow: idSchema.optional(),
  task: z.string().max(200).optional(),
  status: z.enum(DRAFT_STATUSES).default("open"),
  /** The sent message's id, where the provider said. */
  sentId: z.string().max(400).optional(),
  error: z.string().max(1000).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().optional(),
  sentBy: z.string().optional(),
});
export type MailDraft = z.infer<typeof mailDraftSchema>;

/** What a person may change on a draft before it goes. */
export const mailDraftEditSchema = mailDraftSchema.pick({ to: true, cc: true, subject: true, text: true }).partial();

/* ── search ────────────────────────────────────────────────────────────── */

/**
 * One small query syntax for both providers and the kept mail: free words,
 * `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, and
 * `before:` / `after:` dates (YYYY-MM-DD). Quoted phrases stay together.
 */
export interface MailQuery {
  readonly words: readonly string[];
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly subject: readonly string[];
  readonly hasAttachment: boolean;
  readonly unread: boolean;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const parseMailQuery = (text: string): MailQuery => {
  const words: string[] = [];
  const from: string[] = [];
  const to: string[] = [];
  const subject: string[] = [];
  let hasAttachment = false;
  let unread = false;
  let before: string | undefined;
  let after: string | undefined;
  for (const match of text.matchAll(/(\w+:)?(?:"([^"]*)"|(\S+))/g)) {
    const prefix = match[1]?.toLowerCase();
    const value = (match[2] ?? match[3] ?? "").trim();
    if (!value) continue;
    switch (prefix) {
      case "from:":
        from.push(value.toLowerCase());
        break;
      case "to:":
        to.push(value.toLowerCase());
        break;
      case "subject:":
        subject.push(value.toLowerCase());
        break;
      case "has:":
        if (value.toLowerCase() === "attachment") hasAttachment = true;
        else words.push(`has:${value}`.toLowerCase());
        break;
      case "is:":
        if (value.toLowerCase() === "unread") unread = true;
        else words.push(`is:${value}`.toLowerCase());
        break;
      case "before:":
        if (DATE.test(value)) before = value;
        break;
      case "after:":
        if (DATE.test(value)) after = value;
        break;
      default:
        words.push(`${match[1] ?? ""}${value}`.toLowerCase());
    }
  }
  return { words, from, to, subject, hasAttachment, unread, ...(before ? { before } : {}), ...(after ? { after } : {}) };
};

export const isEmptyMailQuery = (query: MailQuery): boolean =>
  query.words.length + query.from.length + query.to.length + query.subject.length === 0 && !query.hasAttachment && !query.unread && !query.before && !query.after;

const addressText = (one: MailAddress | undefined): string => (one ? `${one.name ?? ""} ${one.address}`.toLowerCase() : "");

/** Whether a kept message answers a query: what the list filters as someone types. */
export const matchesMailQuery = (message: MailMessage, query: MailQuery): boolean => {
  const from = addressText(message.from);
  const to = [...message.to, ...message.cc].map(addressText).join(" ");
  const subject = message.subject.toLowerCase();
  const all = `${from} ${to} ${subject} ${message.snippet.toLowerCase()}`;
  const day = message.at.slice(0, 10);
  return (
    query.words.every((word) => all.includes(word)) &&
    query.from.every((one) => from.includes(one)) &&
    query.to.every((one) => to.includes(one)) &&
    query.subject.every((one) => subject.includes(one)) &&
    (!query.hasAttachment || message.hasAttachments) &&
    (!query.unread || message.unread) &&
    (!query.before || day < query.before) &&
    (!query.after || day >= query.after)
  );
};

/** Addresses never made into contacts: the workspace's own, and senders nobody answers. */
export const DEFAULT_CONTACT_IGNORE = ["noreply@*", "no-reply@*", "donotreply@*", "do-not-reply@*", "mailer-daemon@*", "postmaster@*", "notifications@*"] as const;

/** Whether an address is on an ignore list of addresses, `name@*` and `*@domain` patterns. */
export const ignoredAddress = (address: string, patterns: readonly string[]): boolean => {
  const wanted = address.trim().toLowerCase();
  const [local = "", domain = ""] = wanted.split("@");
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith("*@")) return domain === pattern.slice(2) || domain.endsWith(`.${pattern.slice(2)}`);
    if (pattern.endsWith("@*")) return local === pattern.slice(0, -2);
    if (!pattern.includes("@")) return domain === pattern || domain.endsWith(`.${pattern}`);
    return wanted === pattern;
  });
};

/** Comms settings a workspace keeps: senders never made into contacts. */
export const commsSettingsSchema = z.object({
  contactIgnore: z.array(z.string().trim().min(1).max(200)).max(200).default([...DEFAULT_CONTACT_IGNORE]),
  /**
   * Where team notices go for a member with no email of their own: approval
   * requests, booking changes and highlights. On a server nobody signs in to,
   * that is every notice.
   */
  noticesTo: z
    .string()
    .trim()
    .max(320)
    .refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "That is not an email address.")
    .optional(),
});
export type CommsSettings = z.infer<typeof commsSettingsSchema>;
