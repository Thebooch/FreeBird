import type { MailMessage, MailQuery, MailThreadMessage } from "@freebirdai/dash-spec";
import { htmlToText, mapLimit, parseAddress, parseAddressList, type MailListPage, type MailOutgoing, type MailProvider, type MailRead } from "./mail.js";
import { gmailQuery } from "./search.js";

/**
 * Gmail, through the shipped `gmail` catalog entry (`dash/catalog/gmail.json`).
 *
 * A list answers with ids only, so each message's headers are read with
 * `format=metadata` — once: a kept message is not read again. A thread is
 * read whole with `format=full`, and its text taken from the plain part
 * (or the HTML one, as words).
 */

interface GmailPart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
  readonly body?: { readonly data?: string; readonly attachmentId?: string; readonly size?: number };
  readonly parts?: readonly GmailPart[];
}

interface GmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly labelIds?: readonly string[];
  readonly snippet?: string;
  readonly internalDate?: string;
  readonly payload?: GmailPart;
}

const header = (message: GmailMessage, name: string): string | undefined =>
  message.payload?.headers?.find((one) => one.name.toLowerCase() === name.toLowerCase())?.value;

const anyAttachment = (part: GmailPart | undefined): boolean =>
  Boolean(part && ((part.filename && part.filename.length > 0) || part.body?.attachmentId || (part.parts ?? []).some(anyAttachment)));

/** Gmail's snippet arrives with HTML entities. */
const entities = (text: string): string =>
  text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export const normalizeGmail = (raw: unknown, mailbox: string): MailMessage | null => {
  const message = raw as GmailMessage | null;
  if (!message || typeof message.id !== "string") return null;
  const labels = [...(message.labelIds ?? [])];
  const at = Number(message.internalDate);
  const from = parseAddress(header(message, "From") ?? "");
  const messageId = header(message, "Message-ID") ?? header(message, "Message-Id");
  const references = header(message, "References");
  return {
    id: message.id,
    threadId: message.threadId ?? message.id,
    mailbox,
    ...(from ? { from } : {}),
    to: parseAddressList(header(message, "To")),
    cc: parseAddressList(header(message, "Cc")),
    subject: header(message, "Subject") ?? "",
    snippet: entities(message.snippet ?? "").slice(0, 1000),
    at: new Date(Number.isFinite(at) && at > 0 ? at : Date.parse(header(message, "Date") ?? "") || 0).toISOString(),
    unread: labels.includes("UNREAD"),
    sent: labels.includes("SENT"),
    labels,
    hasAttachments: anyAttachment(message.payload),
    ...(messageId ? { messageId } : {}),
    ...(references ? { references: references.slice(0, 4000) } : {}),
  };
};

const decode = (data: string | undefined): string => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

/** The message's words: its plain part, else its HTML part as words. */
export const gmailText = (part: GmailPart | undefined): string => {
  if (!part) return "";
  const find = (one: GmailPart, type: string): GmailPart | undefined =>
    one.mimeType === type && !one.filename ? one : (one.parts ?? []).map((child) => find(child, type)).find(Boolean);
  const plain = find(part, "text/plain");
  if (plain?.body?.data) return decode(plain.body.data);
  const html = find(part, "text/html");
  if (html?.body?.data) return htmlToText(decode(html.body.data));
  return decode(part.body?.data);
};

export const gmailProvider = (read: MailRead, mailbox: string): MailProvider => {
  const details = async (ids: readonly string[]): Promise<MailMessage[]> => {
    const found = await mapLimit(ids, 6, async (id) => {
      const answer = await read("message", { id, format: "metadata" }, { fresh: "10m" });
      return normalizeGmail(answer.body, mailbox);
    });
    return found.filter((one): one is MailMessage => one !== null);
  };

  const page = async (params: Record<string, string | number>, fresh: number | string): Promise<MailListPage> => {
    const answer = await read("messages", params, { fresh });
    const body = answer.body as { messages?: readonly { id: string }[]; nextPageToken?: string } | null;
    const ids = (body?.messages ?? []).map((one) => one.id).filter((id) => typeof id === "string");
    const messages = await details(ids);
    return { messages, ...(body?.nextPageToken ? { next: body.nextPageToken } : {}) };
  };

  return {
    kind: "gmail",
    profile: async () => {
      const answer = await read("profile", {}, { fresh: "1h" });
      const body = answer.body as { emailAddress?: string; historyId?: string } | null;
      return { ...(body?.emailAddress ? { address: body.emailAddress.toLowerCase() } : {}), ...(body?.historyId ? { historyId: String(body.historyId) } : {}) };
    },
    list: (token, size) => page({ maxResults: size, ...(token ? { pageToken: token } : {}) }, token ? "10m" : 0),
    search: (query: MailQuery, token, size) => page({ maxResults: size, q: gmailQuery(query), ...(token ? { pageToken: token } : {}) }, "2m"),
    thread: async (threadId) => {
      const answer = await read("thread", { id: threadId, format: "full" }, { fresh: "1m" });
      const messages = ((answer.body as { messages?: readonly GmailMessage[] } | null)?.messages ?? []);
      return messages
        .map((one): MailThreadMessage | null => {
          const normal = normalizeGmail(one, mailbox);
          return normal ? { ...normal, text: gmailText(one.payload) } : null;
        })
        .filter((one): one is MailThreadMessage => one !== null)
        .sort((a, b) => a.at.localeCompare(b.at));
    },
    sendIntent: (mail: MailOutgoing) => ({
      connection: mailbox,
      entity: "message",
      kind: "action",
      action: "send",
      values: values(mail, "threadId"),
    }),
    draftIntent: (mail: MailOutgoing) => ({
      connection: mailbox,
      entity: "draft",
      kind: "create",
      values: values(mail, "message.threadId"),
    }),
    sentId: (record) => {
      const id = (record as { id?: unknown } | null)?.id;
      return typeof id === "string" ? id : undefined;
    },
  };
};

/** The reviewed fields, only those given: an empty Cc is not sent as one. */
const values = (mail: MailOutgoing, threadField: string): Record<string, string> => {
  const out: Record<string, string> = { to: mail.to, text: mail.text };
  if (mail.cc?.trim()) out["cc"] = mail.cc;
  if (mail.subject !== undefined) out["subject"] = mail.subject;
  if (mail.inReplyTo) out["inReplyTo"] = mail.inReplyTo;
  if (mail.references) out["references"] = mail.references;
  if (mail.threadId) out[threadField] = mail.threadId;
  return out;
};
