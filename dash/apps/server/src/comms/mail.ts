import type { WriteIntent } from "@freebirdai/connect";
import type { MailAddress, MailMessage, MailQuery, MailThreadMessage } from "@freebirdai/dash-spec";

/**
 * One mailbox, whatever provider it is: Gmail or Outlook brought to one shape.
 *
 * A provider never makes a request of its own. It reads through the engine's
 * single read (`MailRead`, bound to the mailbox's connection: the same cache,
 * gate, sign-in and renewal as every tile) and says what to send as a write
 * intent, which only the write service sends, after a person's review.
 */

/** A read of one of the mailbox's endpoints, by id. */
export type MailRead = (
  op: string,
  params: Readonly<Record<string, string | number | boolean>>,
  options?: { readonly fresh?: number | string },
) => Promise<{ readonly rows: readonly unknown[]; readonly body: unknown }>;

/** One page of a mailbox's own order, newest first. `next` is the provider's own token for the page after. */
export interface MailListPage {
  readonly messages: readonly MailMessage[];
  readonly next?: string | undefined;
  /** A search that stopped at the provider's limit, or whose order is not by date. */
  readonly capped?: boolean | undefined;
}

/** What a reply or a new message holds, as the review shows it. */
export interface MailOutgoing {
  readonly to: string;
  readonly cc?: string | undefined;
  readonly subject?: string | undefined;
  readonly text: string;
  readonly threadId?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly references?: string | undefined;
}

export interface MailProvider {
  readonly kind: "gmail" | "outlook";
  /** The address it sends from, and (Gmail) where its history stands. */
  profile(): Promise<{ readonly address?: string | undefined; readonly historyId?: string | undefined }>;
  /** The mailbox's own order, newest first: `size` messages from `token` (absent: the newest). */
  list(token: string | undefined, size: number): Promise<MailListPage>;
  /** A search through the provider's own index. */
  search(query: MailQuery, token: string | undefined, size: number): Promise<MailListPage>;
  /** Every message in a thread, with its text, read live. */
  thread(threadId: string): Promise<readonly MailThreadMessage[]>;
  /** What sends it: the provider's send step. */
  sendIntent(mail: MailOutgoing): WriteIntent;
  /** What saves it in the provider's own drafts instead. */
  draftIntent(mail: MailOutgoing): WriteIntent;
  /** The sent message's id, from what the send answered with, where it said. */
  sentId(record: unknown): string | undefined;
}

/* ── shared helpers ────────────────────────────────────────────────────── */

const unquote = (text: string): string => text.trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();

/** `Pat Doe <pat@example.com>` or a bare address. */
export const parseAddress = (raw: string): MailAddress | undefined => {
  const text = raw.trim();
  if (!text) return undefined;
  const angle = /^(.*)<([^<>]+)>\s*$/.exec(text);
  if (angle) {
    const name = unquote(angle[1] ?? "");
    return { address: angle[2]!.trim().toLowerCase(), ...(name ? { name } : {}) };
  }
  return text.includes("@") ? { address: text.toLowerCase() } : undefined;
};

/** A header's list of addresses, split on commas outside quotes. */
export const parseAddressList = (raw: string | undefined): MailAddress[] => {
  if (!raw) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const char of raw) {
    if (char === '"') quoted = !quoted;
    if (char === "<") angled = true;
    if (char === ">") angled = false;
    if (char === "," && !quoted && !angled) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map(parseAddress).filter((one): one is MailAddress => one !== undefined);
};

/** Addresses as one header line, for a reply's To and Cc. */
export const formatAddresses = (list: readonly MailAddress[]): string =>
  list.map((one) => (one.name ? `${one.name.includes(",") || one.name.includes('"') ? `"${one.name.replace(/"/g, "")}"` : one.name} <${one.address}>` : one.address)).join(", ");

/** "Re: " once, however many times it was already there. */
export const replySubject = (subject: string): string => (/^\s*re:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`);

/** HTML as plain words, for a message that has no plain-text part. */
export const htmlToText = (html: string): string =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** At most `limit` at a time, in order. */
export const mapLimit = async <T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/** A provider token or our own page position, kept opaque. */
export const encodeToken = (value: Readonly<Record<string, unknown>>): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
export const decodeToken = <T>(token: string | undefined): T | undefined => {
  if (!token) return undefined;
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
};
