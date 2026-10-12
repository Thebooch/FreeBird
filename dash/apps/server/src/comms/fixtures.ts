import type { HttpFetch } from "@freebirdai/connect/adapters";

/**
 * A fake Gmail and a fake Microsoft Graph, answering exactly the endpoints the
 * shipped catalog entries read and send through, so tests go through the
 * engine, the write service and the real entries. Never a real account.
 */

export interface FakeMail {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly snippet: string;
  readonly at: string;
  readonly unread?: boolean;
  readonly sent?: boolean;
  readonly text?: string;
}

export interface FakeEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  free?: boolean;
}

export interface FakeMailServer {
  /** Each provider's calendar, changed by what Dash writes. */
  readonly calendars: { gmail: FakeEvent[]; outlook: FakeEvent[] };
  readonly http: HttpFetch;
  readonly gmail: FakeMail[];
  readonly outlook: FakeMail[];
  /** What was asked of each, in order: method, path and query. */
  readonly requests: { method: string; url: string; body?: string | undefined }[];
  /** What was sent: the decoded message. */
  readonly sent: { provider: "gmail" | "outlook"; message: string; threadId?: string | undefined; draft: boolean }[];
}

const json = (url: string, body: unknown, status = 200) => ({
  status,
  text: JSON.stringify(body),
  url,
  header: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
});

const gmailShape = (one: FakeMail, full: boolean) => ({
  id: one.id,
  threadId: one.threadId,
  labelIds: [...(one.unread ? ["UNREAD"] : []), ...(one.sent ? ["SENT"] : ["INBOX"])],
  snippet: one.snippet,
  internalDate: String(Date.parse(one.at)),
  payload: {
    mimeType: full ? "multipart/alternative" : "text/plain",
    headers: [
      { name: "From", value: one.from },
      { name: "To", value: one.to },
      { name: "Subject", value: one.subject },
      { name: "Message-ID", value: `<${one.id}@fake.mail>` },
    ],
    ...(full ? { parts: [{ mimeType: "text/plain", body: { data: Buffer.from(one.text ?? one.snippet).toString("base64url") } }] } : {}),
  },
});

const graphAddress = (raw: string) => {
  const match = /^(.*)<(.+)>$/.exec(raw.trim());
  return { emailAddress: { address: (match ? match[2]! : raw).trim(), name: (match ? match[1]! : "").trim() } };
};

const graphShape = (one: FakeMail, body: boolean) => ({
  id: one.id,
  conversationId: one.threadId,
  internetMessageId: `<${one.id}@fake.outlook>`,
  from: graphAddress(one.from),
  toRecipients: one.to.split(",").map(graphAddress),
  ccRecipients: [],
  subject: one.subject,
  bodyPreview: one.snippet,
  receivedDateTime: one.at,
  sentDateTime: one.at,
  isRead: !one.unread,
  isDraft: false,
  hasAttachments: false,
  ...(body ? { body: { contentType: "text", content: one.text ?? one.snippet } } : {}),
});

const newestFirst = (list: readonly FakeMail[]) => [...list].sort((a, b) => b.at.localeCompare(a.at));

export const fakeMailServer = (seed: { gmail?: FakeMail[]; outlook?: FakeMail[] } = {}): FakeMailServer => {
  const gmail = [...(seed.gmail ?? [])];
  const outlook = [...(seed.outlook ?? [])];
  const requests: FakeMailServer["requests"] = [];
  const calendars: FakeMailServer["calendars"] = { gmail: [], outlook: [] };
  let events = 0;
  const sent: FakeMailServer["sent"] = [];

  const http: HttpFetch = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ method: init.method ?? "GET", url: `${parsed.pathname}${parsed.search}`, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    const method = init.method ?? "GET";

    if (parsed.hostname === "www.googleapis.com" && parsed.pathname.startsWith("/calendar/v3/calendars/primary/events")) {
      const id = decodeURIComponent(parsed.pathname.split("/events/")[1] ?? "");
      const body = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as { summary?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }) : {};
      if (method === "GET" && !id) {
        const from = Date.parse(parsed.searchParams.get("timeMin") ?? "");
        const to = Date.parse(parsed.searchParams.get("timeMax") ?? "");
        const items = calendars.gmail.filter((one) => Date.parse(one.end) > from && Date.parse(one.start) < to);
        return json(url, { items: items.map((one) => ({ id: one.id, summary: one.title, status: "confirmed", ...(one.free ? { transparency: "transparent" } : {}), start: { dateTime: one.start }, end: { dateTime: one.end } })) });
      }
      const held = calendars.gmail.find((one) => one.id === id);
      if (method === "GET") return held ? json(url, { id: held.id, summary: held.title, start: { dateTime: held.start }, end: { dateTime: held.end } }) : json(url, { error: "not found" }, 404);
      if (method === "POST") {
        const made = { id: `ev${++events}`, title: body.summary ?? "", start: body.start?.dateTime ?? "", end: body.end?.dateTime ?? "" };
        calendars.gmail.push(made);
        return json(url, { id: made.id, summary: made.title });
      }
      if (method === "PATCH" && held) {
        Object.assign(held, { title: body.summary ?? held.title, start: body.start?.dateTime ?? held.start, end: body.end?.dateTime ?? held.end });
        return json(url, { id: held.id, summary: held.title });
      }
      if (method === "DELETE" && held) {
        calendars.gmail.splice(calendars.gmail.indexOf(held), 1);
        return { status: 204, text: "", url, header: () => null };
      }
      return json(url, { error: "not found" }, 404);
    }

    if (parsed.hostname === "www.googleapis.com" && parsed.pathname.startsWith("/gmail/v1/users/me")) {
      const path = parsed.pathname.replace("/gmail/v1/users/me", "");
      if (path === "/profile") return json(url, { emailAddress: "team@example.com", historyId: "100" });
      if (path === "/messages" && method === "GET") {
        const q = (parsed.searchParams.get("q") ?? "").toLowerCase();
        const from = /from:(\S+)/.exec(q)?.[1];
        const list = newestFirst(gmail).filter((one) => !from || one.from.toLowerCase().includes(from));
        const size = Number(parsed.searchParams.get("maxResults") ?? 25);
        const start = Number(parsed.searchParams.get("pageToken") ?? 0);
        const page = list.slice(start, start + size);
        return json(url, { messages: page.map((one) => ({ id: one.id, threadId: one.threadId })), ...(start + size < list.length ? { nextPageToken: String(start + size) } : {}) });
      }
      const message = /^\/messages\/([^/]+)$/.exec(path);
      if (message && method === "GET") {
        const one = gmail.find((item) => item.id === decodeURIComponent(message[1]!));
        return one ? json(url, gmailShape(one, false)) : json(url, { error: "not found" }, 404);
      }
      const thread = /^\/threads\/([^/]+)$/.exec(path);
      if (thread) return json(url, { id: thread[1], messages: gmail.filter((one) => one.threadId === thread[1]).map((one) => gmailShape(one, true)) });
      if ((path === "/messages/send" || path === "/drafts") && method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { raw?: string; threadId?: string; message?: { raw?: string; threadId?: string } };
        const raw = body.raw ?? body.message?.raw ?? "";
        sent.push({ provider: "gmail", message: Buffer.from(raw, "base64url").toString("utf8"), threadId: body.threadId ?? body.message?.threadId, draft: path === "/drafts" });
        return json(url, { id: `sent-${sent.length}`, threadId: body.threadId ?? "new" });
      }
    }

    if (parsed.hostname === "graph.microsoft.com") {
      const path = parsed.pathname.replace("/v1.0", "");
      if (path === "/me") return json(url, { mail: "agent@example.org", userPrincipalName: "agent@example.org" });
      if (path === "/me/messages" && method === "GET") {
        const filter = parsed.searchParams.get("$filter") ?? "";
        const conversation = /conversationId eq '([^']+)'/.exec(filter)?.[1];
        if (conversation) return json(url, { value: outlook.filter((one) => one.threadId === conversation).map((one) => graphShape(one, true)) });
        const search = parsed.searchParams.get("$search");
        const list = newestFirst(outlook).filter((one) => !search || `${one.from} ${one.subject}`.toLowerCase().includes(search.replace(/"/g, "").replace(/^\w+:/, "").toLowerCase()));
        const size = Number(parsed.searchParams.get("$top") ?? 25);
        const start = Number(parsed.searchParams.get("$skip") ?? 0);
        const page = list.slice(start, start + size);
        return json(url, {
          value: page.map((one) => graphShape(one, false)),
          ...(start + size < list.length && !search ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/messages?$skip=${start + size}` } : {}),
        });
      }
      const message = /^\/me\/messages\/([^/]+)$/.exec(path);
      if (message && method === "GET") {
        const one = outlook.find((item) => item.id === decodeURIComponent(message[1]!));
        return one ? json(url, graphShape(one, false)) : json(url, { error: "not found" }, 404);
      }
      if ((path === "/me/sendMail" || path === "/me/messages") && method === "POST") {
        sent.push({ provider: "outlook", message: Buffer.from(String(init.body ?? ""), "base64").toString("utf8"), draft: path === "/me/messages" });
        return path === "/me/sendMail" ? { status: 202, text: "", url, header: () => null } : json(url, { id: `draft-${sent.length}` }, 201);
      }
    }
    return json(url, { error: `nothing at ${method} ${parsed.hostname}${parsed.pathname}` }, 404);
  };
  return { http, gmail, outlook, requests, sent, calendars };
};
