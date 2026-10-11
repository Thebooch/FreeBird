import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogStore, KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { ConnectionSpec, MailPage, MailboxView } from "@freebirdai/dash-spec";
import { fakeLlm } from "@freebirdai/dash-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { fakeMailServer, type FakeMailServer } from "./fixtures.js";

/**
 * Communications end to end, against a fake Gmail and a fake Outlook that
 * answer the shipped catalog entries: through the engine's read, and the
 * write service's review for anything sent.
 */

const here = dirname(fileURLToPath(import.meta.url));
const seed = join(here, "..", "..", "..", "..", "catalog");

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let mail: FakeMailServer;

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 12, minutes)).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-comms-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 9)), join(dir, ".dash", "vault.json"));
  mail = fakeMailServer({
    gmail: [
      { id: "g1", threadId: "gt1", from: "Pat Doe <pat@example.com>", to: "team@example.com", subject: "Leak in 4B", snippet: "Water under the sink", at: at(1), unread: true, text: "Water under the sink since Monday." },
      { id: "g2", threadId: "gt2", from: "noreply@vendor.example", to: "team@example.com", subject: "Your invoice", snippet: "Invoice attached", at: at(5) },
      { id: "g3", threadId: "gt1", from: "team@example.com", to: "pat@example.com", subject: "Re: Leak in 4B", snippet: "We'll send someone", at: at(9), sent: true },
    ],
    outlook: [
      { id: "o1", threadId: "ot1", from: "Sam Lee <sam@example.net>", to: "agent@example.org", subject: "Showing on Friday?", snippet: "Is the unit still available", at: at(3), unread: true },
      { id: "o2", threadId: "ot2", from: "Kim <kim@example.net>", to: "agent@example.org", subject: "Application", snippet: "Sent my application", at: at(7) },
    ],
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const makeApp = (llm: ReturnType<typeof fakeLlm> | null = null) => buildServer({ store, keys, catalog: new CatalogStore(seed, join(dir, "overlay")), llm, http: mail.http });

/** A mailbox signed in: the token the broker would have got, put where it keeps it. */
const signIn = (id: string): void => {
  const connection = store.getConnection(id) as ConnectionSpec;
  if (connection.auth.type !== "oauth2") throw new Error("not oauth");
  keys.set(connection.auth.keyRef, `token-${id}`);
};

const setUp = async (app: ReturnType<typeof makeApp>) => {
  for (const provider of ["gmail", "outlook"]) {
    const answer = await app.inject({ method: "POST", url: `/api/comms/apps/${provider}`, payload: { clientId: `${provider}-client`, clientSecret: "secret" } });
    expect(answer.statusCode).toBe(200);
  }
  const agent = (await app.inject({ method: "PUT", url: "/api/agents/leasing", payload: { name: "Leasing", color: 3 } })).json() as { id: string };
  const gmail = (await app.inject({ method: "POST", url: "/api/comms/mailboxes", payload: { provider: "gmail", owner: { kind: "team" } } })).json() as MailboxView;
  const outlook = (await app.inject({ method: "POST", url: "/api/comms/mailboxes", payload: { provider: "outlook", owner: { kind: "agent", id: agent.id } } })).json() as MailboxView;
  return { agent, gmail, outlook };
};

describe("Communications", () => {
  it("adds a mailbox with the workspace's app copied in, waiting for its sign-in", async () => {
    const app = makeApp();
    const { gmail, outlook, agent } = await setUp(app);
    expect(gmail).toMatchObject({ id: "gmail", provider: "gmail", owner: { kind: "team" }, status: "needs_sign_in" });
    expect(outlook).toMatchObject({ id: "outlook", owner: { kind: "agent", id: agent.id } });
    const connection = store.getConnection("gmail")!;
    expect(connection.auth.type === "oauth2" && keys.get(connection.auth.clientIdRef)).toBe("gmail-client");
    const start = await app.inject({ method: "POST", url: "/api/connections/gmail/oauth/start", headers: { origin: "http://localhost:5400" } });
    const authorize = new URL((start.json() as { authorizeUrl: string }).authorizeUrl);
    expect(authorize.hostname).toBe("accounts.google.com");
    expect(authorize.searchParams.get("access_type")).toBe("offline");
    expect(authorize.searchParams.get("client_id")).toBe("gmail-client");
    await app.close();
  });

  it("keeps the team's mail and an agent's mail apart, each newest first", async () => {
    const app = makeApp();
    const { agent } = await setUp(app);
    signIn("gmail");
    signIn("outlook");
    const team = (await app.inject({ method: "GET", url: "/api/comms?area=team" })).json() as MailPage;
    expect(team.problems).toEqual([]);
    expect(team.messages.map((one) => one.id)).toEqual(["g3", "g2", "g1"]);
    expect(team.messages.find((one) => one.id === "g1")).toMatchObject({ unread: true, from: { address: "pat@example.com", name: "Pat Doe" } });
    expect(team.messages.find((one) => one.id === "g3")?.sent).toBe(true);
    const agents = (await app.inject({ method: "GET", url: `/api/comms?area=agent:${agent.id}` })).json() as MailPage;
    expect(agents.messages.map((one) => one.id)).toEqual(["o2", "o1"]);
    await app.close();
  });

  it("merges several mailboxes by time, and narrows to the ones ticked", async () => {
    const app = makeApp();
    await setUp(app);
    await app.inject({ method: "PUT", url: "/api/comms/mailboxes/outlook/owner", payload: { owner: { kind: "team" } } });
    signIn("gmail");
    signIn("outlook");
    const all = (await app.inject({ method: "GET", url: "/api/comms?area=team" })).json() as MailPage;
    expect(all.messages.map((one) => one.id)).toEqual(["g3", "o2", "g2", "o1", "g1"]);
    const one = (await app.inject({ method: "GET", url: "/api/comms?area=team&mailboxes=outlook" })).json() as MailPage;
    expect(one.messages.map((item) => item.id)).toEqual(["o2", "o1"]);
    await app.close();
  });

  it("pages across mailboxes with a cursor for each", async () => {
    const app = makeApp();
    await setUp(app);
    await app.inject({ method: "PUT", url: "/api/comms/mailboxes/outlook/owner", payload: { owner: { kind: "team" } } });
    signIn("gmail");
    signIn("outlook");
    const first = (await app.inject({ method: "GET", url: "/api/comms?area=team&size=2" })).json() as MailPage;
    expect(first.messages.map((one) => one.id)).toEqual(["g3", "o2"]);
    const second = (await app.inject({ method: "GET", url: `/api/comms?area=team&size=2&cursor=${first.cursor}` })).json() as MailPage;
    expect(second.messages.map((one) => one.id)).toEqual(["g2", "o1"]);
    const third = (await app.inject({ method: "GET", url: `/api/comms?area=team&size=2&cursor=${second.cursor}` })).json() as MailPage;
    expect(third.messages.map((one) => one.id)).toEqual(["g1"]);
    expect(third.cursor).toBeUndefined();
    await app.close();
  });

  it("searches each selected mailbox's own index", async () => {
    const app = makeApp();
    await setUp(app);
    signIn("gmail");
    const found = (await app.inject({ method: "GET", url: `/api/comms?area=team&q=${encodeURIComponent("from:pat")}` })).json() as MailPage;
    expect(found.searched).toBe(true);
    expect(found.messages.map((one) => one.id)).toEqual(["g1"]);
    expect(mail.requests.some((one) => one.url.includes("q=from%3Apat"))).toBe(true);
    await app.close();
  });

  it("makes each new sender a contact, but not the workspace's own address or a no-reply", async () => {
    const app = makeApp();
    await setUp(app);
    signIn("gmail");
    await app.inject({ method: "GET", url: "/api/comms?area=team" });
    const contacts = (await app.inject({ method: "GET", url: "/api/contacts" })).json() as { contacts: { emails: string[]; origin: string }[] };
    expect(contacts.contacts.map((one) => one.emails[0])).toEqual(["pat@example.com"]);
    expect(contacts.contacts[0]?.origin).toBe("email");
    await app.close();
  });

  it("reads a thread live, and sends a reply only through the review", async () => {
    const app = makeApp();
    await setUp(app);
    signIn("gmail");
    await app.inject({ method: "GET", url: "/api/comms?area=team" });
    const thread = (await app.inject({ method: "GET", url: "/api/comms/threads/gmail/gt1" })).json() as { messages: { id: string; text: string }[] };
    expect(thread.messages.map((one) => one.id)).toEqual(["g1", "g3"]);
    expect(thread.messages[0]?.text).toContain("since Monday");

    const draft = (await app.inject({ method: "POST", url: "/api/comms/drafts", payload: { mailbox: "gmail", replyTo: "g1", threadId: "gt1" } })).json() as { id: string; to: string; subject: string };
    expect(draft).toMatchObject({ to: "Pat Doe <pat@example.com>", subject: "Re: Leak in 4B" });
    await app.inject({ method: "PUT", url: `/api/comms/drafts/${draft.id}`, payload: { text: "Someone will be there at 9." } });
    expect(mail.sent).toEqual([]);

    const review = (await app.inject({ method: "POST", url: `/api/comms/drafts/${draft.id}/review`, payload: {} })).json() as { pendingId: string; digest: string; rows: { label: string; after: string | null }[] };
    expect(review.rows.map((row) => row.label)).toEqual(expect.arrayContaining(["To", "Subject", "Message"]));
    expect(mail.sent).toEqual([]);
    const sent = await app.inject({ method: "POST", url: `/api/comms/drafts/${draft.id}/send`, payload: { pendingId: review.pendingId, digest: review.digest } });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: "sent", sentId: "sent-1" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ provider: "gmail", threadId: "gt1", draft: false });
    expect(mail.sent[0]!.message).toContain("To: Pat Doe <pat@example.com>");
    expect(mail.sent[0]!.message).toContain("In-Reply-To: <g1@fake.mail>");
    /* The same yes cannot send it twice. */
    const again = await app.inject({ method: "POST", url: `/api/comms/drafts/${draft.id}/send`, payload: { pendingId: review.pendingId, digest: review.digest } });
    expect(again.statusCode).toBe(409);
    expect(mail.sent).toHaveLength(1);
    await app.close();
  });

  it("saves to the provider's drafts instead, for Outlook as MIME", async () => {
    const app = makeApp();
    const { agent } = await setUp(app);
    signIn("outlook");
    await app.inject({ method: "GET", url: `/api/comms?area=agent:${agent.id}` });
    const draft = (await app.inject({ method: "POST", url: "/api/comms/drafts", payload: { mailbox: "outlook", replyTo: "o1", threadId: "ot1" } })).json() as { id: string };
    await app.inject({ method: "PUT", url: `/api/comms/drafts/${draft.id}`, payload: { text: "Friday at 2 works." } });
    const review = (await app.inject({ method: "POST", url: `/api/comms/drafts/${draft.id}/review`, payload: { save: true } })).json() as { pendingId: string; digest: string };
    const saved = await app.inject({ method: "POST", url: `/api/comms/drafts/${draft.id}/send`, payload: { pendingId: review.pendingId, digest: review.digest, save: true } });
    expect(saved.json()).toMatchObject({ status: "saved" });
    expect(mail.sent[0]).toMatchObject({ provider: "outlook", draft: true });
    expect(mail.sent[0]!.message).toContain("To: Sam Lee <sam@example.net>");
    expect(mail.sent[0]!.message).toContain("Subject: Re: Showing on Friday?");
    await app.close();
  });
});

describe("Reply to the email, in a workflow", () => {
  it("drafts a reply when an email arrives, sends it from a team mailbox only with the agent's leave, and goes on", async () => {
    const app = makeApp(fakeLlm([{ text: "Thanks Rae, a plumber will call you today." }]));
    await setUp(app);
    signIn("gmail");
    /* The first read takes in what was there: no workflow starts for old mail. */
    await app.inject({ method: "GET", url: "/api/comms?area=team" });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/workflows/new",
      payload: {
        name: "Answer new mail",
        enabled: true,
        trigger: { kind: "message_received", channels: ["email"], mailboxes: ["gmail"] },
        nodes: [{ id: "reply", action: "outreach.reply", settings: { agentId: "leasing", instructions: "Say a plumber will call today.", send: "approval", timeout: "3d" }, mode: "auto" }],
        edges: [{ id: "a", from: "trigger", to: "reply" }],
      },
    });
    expect(saved.statusCode).toBe(200);
    mail.gmail.push({ id: "g4", threadId: "gt4", from: "Rae <rae@example.com>", to: "team@example.com", subject: "Sink", snippet: "The sink is leaking", at: at(30), text: "The sink is leaking again." });
    await app.inject({ method: "POST", url: "/api/comms/mailboxes/gmail/refresh" });

    const drafts = (await app.inject({ method: "GET", url: "/api/comms/drafts" })).json() as { id: string; agent: string; text: string; to: string; task: string }[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ agent: "leasing", text: "Thanks Rae, a plumber will call you today.", to: "Rae <rae@example.com>" });
    expect(mail.sent).toEqual([]);
    /* The contact came first, so the case knows who wrote. */
    const contacts = (await app.inject({ method: "GET", url: "/api/contacts" })).json() as { contacts: { emails: string[] }[] };
    expect(contacts.contacts.some((one) => one.emails.includes("rae@example.com"))).toBe(true);

    /* An agent sends from its own address: a team mailbox needs its leave. */
    const refused = await app.inject({ method: "POST", url: `/api/comms/drafts/${drafts[0]!.id}/review`, payload: {} });
    expect(refused.statusCode).toBe(403);
    await app.inject({ method: "PUT", url: "/api/agents/leasing", payload: { name: "Leasing", color: 3, reach: [{ permission: "records.read", scope: { connection: "gmail" } }, { permission: "records.act", scope: { connection: "gmail" } }] } });
    const review = (await app.inject({ method: "POST", url: `/api/comms/drafts/${drafts[0]!.id}/review`, payload: {} })).json() as { pendingId: string; digest: string };
    const sent = await app.inject({ method: "POST", url: `/api/comms/drafts/${drafts[0]!.id}/send`, payload: { pendingId: review.pendingId, digest: review.digest } });
    expect(sent.statusCode).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.message).toContain("To: Rae <rae@example.com>");

    const task = (await app.inject({ method: "GET", url: `/api/tasks/${drafts[0]!.task}` })).json() as { status: string; outcome?: string; task?: { status: string; outcome?: string } };
    const held = task.task ?? task;
    expect(held).toMatchObject({ status: "done", outcome: "sent" });

    /* What it sent is the agent's, in the team's inbox. */
    const team = (await app.inject({ method: "GET", url: "/api/comms?area=team" })).json() as MailPage;
    expect(team.messages.find((one) => one.id === "g4")).toMatchObject({ agent: "leasing", status: "replied" });
    await app.close();
  });
});
