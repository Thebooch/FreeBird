import type { MailAddress, MailMessage, MailQuery, MailThreadMessage } from "@freebirdai/dash-spec";
import { decodeToken, encodeToken, htmlToText, type MailOutgoing, type MailProvider, type MailRead } from "./mail.js";
import { graphSearch } from "./search.js";

/**
 * Outlook, through Microsoft Graph and the shipped `outlook` catalog entry
 * (`dash/catalog/outlook.json`).
 *
 * A list answers with every field in one read. Paging is Graph's own
 * `@odata.nextLink`, whose `$skip` / `$skiptoken` are carried as our token.
 * Search is `$search` (KQL), which Graph neither sorts by date nor pages far:
 * one read of up to `SEARCH_CAP`, sorted here, and said to be capped when it
 * filled. A thread is the conversation's messages, as text (`Prefer`).
 * Sending is MIME (`/me/sendMail`), so a review shows to, cc, subject and the
 * words, exactly as for Gmail.
 */

export const SEARCH_CAP = 250;

interface GraphAddress {
  readonly emailAddress?: { readonly address?: string; readonly name?: string };
}

interface GraphMessage {
  readonly id: string;
  readonly conversationId?: string;
  readonly internetMessageId?: string;
  readonly from?: GraphAddress;
  readonly sender?: GraphAddress;
  readonly toRecipients?: readonly GraphAddress[];
  readonly ccRecipients?: readonly GraphAddress[];
  readonly subject?: string;
  readonly bodyPreview?: string;
  readonly receivedDateTime?: string;
  readonly sentDateTime?: string;
  readonly isRead?: boolean;
  readonly isDraft?: boolean;
  readonly hasAttachments?: boolean;
  readonly parentFolderId?: string;
  readonly body?: { readonly contentType?: string; readonly content?: string };
}

const address = (one: GraphAddress | undefined): MailAddress | undefined => {
  const raw = one?.emailAddress?.address?.trim();
  if (!raw) return undefined;
  const name = one?.emailAddress?.name?.trim();
  return { address: raw.toLowerCase(), ...(name && name.toLowerCase() !== raw.toLowerCase() ? { name } : {}) };
};

const addresses = (list: readonly GraphAddress[] | undefined): MailAddress[] =>
  (list ?? []).map(address).filter((one): one is MailAddress => one !== undefined);

export const normalizeGraph = (raw: unknown, mailbox: string, own: string | undefined): MailMessage | null => {
  const message = raw as GraphMessage | null;
  if (!message || typeof message.id !== "string") return null;
  const from = address(message.from ?? message.sender);
  const sent = Boolean(own && from?.address === own.toLowerCase());
  const at = (sent ? message.sentDateTime : message.receivedDateTime) ?? message.receivedDateTime ?? message.sentDateTime ?? new Date(0).toISOString();
  return {
    id: message.id,
    threadId: message.conversationId ?? message.id,
    mailbox,
    ...(from ? { from } : {}),
    to: addresses(message.toRecipients),
    cc: addresses(message.ccRecipients),
    subject: message.subject ?? "",
    snippet: (message.bodyPreview ?? "").slice(0, 1000),
    at: new Date(Date.parse(at) || 0).toISOString(),
    unread: message.isRead === false,
    sent,
    labels: [],
    hasAttachments: Boolean(message.hasAttachments),
    ...(message.internetMessageId ? { messageId: message.internetMessageId } : {}),
  };
};

interface GraphToken {
  readonly skip?: string;
  readonly skiptoken?: string;
}

/** Where the next page starts, from Graph's `@odata.nextLink`. */
const nextOf = (body: unknown): string | undefined => {
  const link = (body as { "@odata.nextLink"?: unknown } | null)?.["@odata.nextLink"];
  if (typeof link !== "string") return undefined;
  try {
    const url = new URL(link);
    const skip = url.searchParams.get("$skip") ?? undefined;
    const skiptoken = url.searchParams.get("$skiptoken") ?? undefined;
    return skip || skiptoken ? encodeToken({ ...(skip ? { skip } : {}), ...(skiptoken ? { skiptoken } : {}) }) : undefined;
  } catch {
    return undefined;
  }
};

export const graphProvider = (read: MailRead, mailbox: string, own: () => string | undefined): MailProvider => {
  const normalized = (rows: readonly unknown[]): MailMessage[] =>
    rows.map((row) => normalizeGraph(row, mailbox, own())).filter((one): one is MailMessage => one !== null);

  return {
    kind: "outlook",
    profile: async () => {
      const answer = await read("profile", {}, { fresh: "1h" });
      const body = answer.body as { mail?: string | null; userPrincipalName?: string } | null;
      const address = body?.mail || body?.userPrincipalName;
      return address ? { address: address.toLowerCase() } : {};
    },
    list: async (token, size) => {
      const at = decodeToken<GraphToken>(token);
      const answer = await read(
        "messages",
        { $top: size, ...(at?.skip ? { $skip: at.skip } : {}), ...(at?.skiptoken ? { $skiptoken: at.skiptoken } : {}) },
        { fresh: token ? "10m" : 0 },
      );
      const next = nextOf(answer.body);
      return { messages: normalized(answer.rows), ...(next ? { next } : {}) };
    },
    search: async (query: MailQuery) => {
      const search = graphSearch(query);
      if (!search) return { messages: [] };
      const answer = await read("search", { $search: search, $top: SEARCH_CAP }, { fresh: "2m" });
      /* Graph's KQL has no "unread": checked here, on what came back. */
      const messages = normalized(answer.rows)
        .filter((one) => !query.unread || one.unread)
        .sort((a, b) => b.at.localeCompare(a.at));
      return { messages, capped: answer.rows.length >= SEARCH_CAP };
    },
    thread: async (threadId) => {
      const answer = await read("conversation", { conversationId: threadId.replace(/'/g, "''") }, { fresh: "1m" });
      return answer.rows
        .map((row): MailThreadMessage | null => {
          const normal = normalizeGraph(row, mailbox, own());
          if (!normal) return null;
          const body = (row as GraphMessage).body;
          const text = body?.content ? (body.contentType?.toLowerCase() === "html" ? htmlToText(body.content) : body.content) : normal.snippet;
          return { ...normal, text };
        })
        .filter((one): one is MailThreadMessage => one !== null)
        .sort((a, b) => a.at.localeCompare(b.at));
    },
    sendIntent: (mail: MailOutgoing) => ({ connection: mailbox, entity: "message", kind: "action", action: "send", values: values(mail) }),
    draftIntent: (mail: MailOutgoing) => ({ connection: mailbox, entity: "message", kind: "create", values: values(mail) }),
    events: async (from, to) => {
      const answer = await read("events", { startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString() }, { fresh: "5m" });
      return answer.rows.flatMap((row) => {
        const one = row as { id?: string; showAs?: string; isAllDay?: boolean; isCancelled?: boolean; start?: { dateTime?: string }; end?: { dateTime?: string } };
        if (typeof one.id !== "string") return [];
        /* Asked for in UTC; Graph writes it without the Z. */
        const utc = (value: string | undefined) => Date.parse(value && !/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? `${value}Z` : (value ?? ""));
        const start = utc(one.start?.dateTime);
        const end = utc(one.end?.dateTime);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
        return [{ id: one.id, start, end, busy: !one.isCancelled && !one.isAllDay && one.showAs !== "free" && one.showAs !== "workingElsewhere" }];
      });
    },
    eventIntent: (kind, event, id) => ({
      connection: mailbox,
      entity: "event",
      kind,
      ...(id ? { id } : {}),
      ...(event
        ? {
            values: {
              subject: event.title,
              "body.contentType": "Text",
              "body.content": event.notes,
              "start.dateTime": event.start.replace(/Z$/, ""),
              "start.timeZone": "UTC",
              "end.dateTime": event.end.replace(/Z$/, ""),
              "end.timeZone": "UTC",
            },
          }
        : {}),
    }),
    eventId: (record) => {
      const id = (record as { id?: unknown } | null)?.id;
      return typeof id === "string" ? id : undefined;
    },
    /* `sendMail` answers 202 with nothing. */
    sentId: () => undefined,
  };
};

const values = (mail: MailOutgoing): Record<string, string> => {
  const out: Record<string, string> = { to: mail.to, text: mail.text };
  if (mail.cc?.trim()) out["cc"] = mail.cc;
  if (mail.subject !== undefined) out["subject"] = mail.subject;
  if (mail.inReplyTo) out["inReplyTo"] = mail.inReplyTo;
  if (mail.references) out["references"] = mail.references;
  return out;
};
