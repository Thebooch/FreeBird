import type { AuthContext, ChatMessage } from "@freebirdai/core";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import Fastify from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installIdentity } from "../identity/context.js";
import { localOwner, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../identity/resolver.js";
import { chatTopicRoutes, type TimelineTask } from "../routes/chat-topics.js";
import { type ChatDb, openChatDb, truncateChat } from "./db.js";
import {
  contextTopics,
  dayOf,
  decideTopic,
  explicitNewTopic,
  renderEarlierTopics,
  TopicStore,
  withTopicContext,
  type TopicSummary,
} from "./topics.js";

let db: ChatDb;

beforeAll(async () => {
  db = await openChatDb({ databaseUrl: undefined, inMemory: true });
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await truncateChat(db);
});

const owner = { userId: LOCAL_USER_ID, tenantId: LOCAL_WORKSPACE_ID };
const auth: AuthContext = { userId: owner.userId, orgId: owner.tenantId };
const NOW = Date.parse("2026-10-07T18:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

/** A topic with messages said at the given times (hours ago). */
const topic = async (name: string, said: ReadonlyArray<readonly [hours: number, role: "user" | "assistant", text: string]>) => {
  const session = await db.adapter.createSession({ title: name }, auth);
  await sql`UPDATE freebird_chat_session SET created_at = ${hoursAgo(said[0]?.[0] ?? 0)} WHERE id = ${session.id}`.execute(db.kysely);
  for (const [hours, role, content] of said) {
    const message = await db.adapter.appendMessage({ sessionId: session.id, role, content }, auth);
    await sql`UPDATE freebird_chat_message SET created_at = ${hoursAgo(hours)} WHERE id = ${message.id}`.execute(db.kysely);
  }
  return session.id;
};

const summary = (id: string, hours: number, count = 2): TopicSummary => ({
  id,
  name: id,
  firstAt: hoursAgo(hours + 1),
  lastAt: hoursAgo(hours),
  count,
});

describe("the context window", () => {
  it("takes at most the two topics before the current one", () => {
    const recent = [summary("now", 0), summary("a", 1), summary("b", 2), summary("c", 3)];
    expect(contextTopics(recent, "now", NOW).map((one) => one.id)).toEqual(["a", "b"]);
  });

  it("drops a topic last active more than 24 hours ago, whichever comes first", () => {
    const recent = [summary("now", 0), summary("a", 5), summary("b", 30)];
    expect(contextTopics(recent, "now", NOW).map((one) => one.id)).toEqual(["a"]);
  });

  it("never reaches past the second topic for one that is inside the window", () => {
    const recent = [summary("now", 0), summary("a", 40), summary("b", 41), summary("c", 2)];
    expect(contextTopics(recent, "now", NOW)).toEqual([]);
  });

  it("writes earlier topics oldest first, and says nothing when there are none", () => {
    const messages: ChatMessage[] = [
      { id: "1", sessionId: "b", role: "user", content: "rent for unit 4?", references: [], createdAt: new Date(hoursAgo(3)) },
      { id: "2", sessionId: "a", role: "user", content: "open work orders", references: [], createdAt: new Date(hoursAgo(1)) },
    ];
    const note = renderEarlierTopics([summary("a", 1), summary("b", 3)], messages, NOW)!;
    expect(note.indexOf('"b"')).toBeLessThan(note.indexOf('"a"'));
    expect(note).toContain("Person: rent for unit 4?");
    expect(renderEarlierTopics([], [], NOW)).toBeNull();
  });
});

describe("TopicStore", () => {
  it("lists topics by last activity and reads a day across topics", async () => {
    const rent = await topic("Rent", [[30, "user", "rent?"], [2, "user", "back to rent"]]);
    const orders = await topic("Work orders", [[5, "user", "orders?"], [4.9, "assistant", "three open"]]);
    const store = new TopicStore(db, owner);

    expect((await store.recent()).map((one) => one.id)).toEqual([rent, orders]);

    const today = dayOf(NOW, "UTC");
    const on = await store.messagesOn("UTC", today);
    expect(on.messages.map((one) => one.content)).toEqual(["orders?", "three open", "back to rent"]);
    expect(on.topics).toEqual({ [rent]: "Rent", [orders]: "Work orders" });
    expect(on.prev).toBe(dayOf(hoursAgo(30), "UTC"));
    expect(on.next).toBeNull();

    expect((await store.topicsOn("UTC", today)).map((one) => [one.name, one.count])).toEqual([
      ["Work orders", 2],
      ["Rent", 1],
    ]);
    expect((await store.days("UTC")).map((one) => one.day)).toEqual([today, dayOf(hoursAgo(30), "UTC")]);
    expect((await store.days("UTC", { before: today })).map((one) => one.day)).toEqual([dayOf(hoursAgo(30), "UTC")]);
  });

  it("keeps one person's topics from another", async () => {
    await topic("Rent", [[1, "user", "rent?"]]);
    const other = new TopicStore(db, { userId: "someone-else", tenantId: owner.tenantId });
    expect(await other.recent()).toEqual([]);
    expect((await other.messagesOn("UTC", dayOf(NOW, "UTC"))).messages).toEqual([]);
  });

  it("groups by the reader's own day", async () => {
    // 03:00 UTC is still the evening before in Chicago.
    const session = await db.adapter.createSession({ title: "Late" }, auth);
    const message = await db.adapter.appendMessage({ sessionId: session.id, role: "user", content: "late" }, auth);
    await sql`UPDATE freebird_chat_message SET created_at = ${"2026-10-07T03:00:00Z"} WHERE id = ${message.id}`.execute(db.kysely);
    const store = new TopicStore(db, owner);
    expect((await store.days("America/Chicago"))[0]!.day).toBe("2026-10-06");
    expect((await store.days("UTC"))[0]!.day).toBe("2026-10-07");
  });
});

describe("withTopicContext", () => {
  it("gives a chat turn the earlier topics, and every other read the store as it is", async () => {
    const old = await topic("Old", [[40, "user", "too old"]]);
    const rent = await topic("Rent", [[3, "user", "rent for unit 4?"]]);
    const current = await topic("Orders", [[1, "user", "open orders?"]]);
    void old;
    void rent;
    const wrapped = withTopicContext(db.adapter, {
      storeFor: () => new TopicStore(db, owner),
      isTurn: (one) => one.extra?.["turn"] === true,
      now: () => NOW,
    });

    const plain = await wrapped.listMessages(current, auth);
    expect(plain.map((one) => one.content)).toEqual(["open orders?"]);

    const turn = await wrapped.listMessages(current, { ...auth, extra: { turn: true } });
    expect(turn).toHaveLength(2);
    expect(turn[0]!.role).toBe("system");
    expect(turn[0]!.content).toContain("rent for unit 4?");
    expect(turn[0]!.content).not.toContain("too old");
    // Everything else the adapter does still works through the wrapper.
    expect(await wrapped.getSession(current, auth)).not.toBeNull();
  });
});

const model = (answer: { topic: number; name?: string } | Error): LlmAdapter => ({
  defaultModel: "test",
  generate: async () => {
    if (answer instanceof Error) throw answer;
    return { text: "", toolCalls: [{ id: "1", name: "choose_topic", args: answer }] } as never;
  },
  stream: async function* () {},
});

describe("decideTopic", () => {
  const candidates = [
    { id: "now", name: "Rent", recent: "Person: rent?" },
    { id: "earlier", name: "Work orders", recent: "Person: orders?" },
  ];

  it("always splits on an explicit new topic, with or without a name", async () => {
    expect(explicitNewTopic("new topic: lease renewals")).toEqual({ name: "Lease renewals" });
    expect(explicitNewTopic("Let's start a new topic")).toEqual({ name: "" });
    expect(explicitNewTopic("what's new in topics")).toBeNull();
    expect(await decideTopic({ text: "New topic: vendors", candidates, llm: null })).toEqual({
      kind: "new",
      name: "Vendors",
      why: "explicit",
    });
    const unnamed = await decideTopic({ text: "new topic", candidates, llm: model({ topic: -1, name: "Fresh start" }) });
    expect(unnamed).toEqual({ kind: "new", name: "Fresh start", why: "explicit" });
  });

  it("stays without a model, and starts the day's first topic from the words", async () => {
    expect(await decideTopic({ text: "and unit 5?", candidates, llm: null })).toEqual({ kind: "same", id: "now" });
    expect(await decideTopic({ text: "how many leases end this month?", candidates: [], fresh: "new-day", llm: null })).toEqual({
      kind: "new",
      name: "How many leases end this month",
      why: "new-day",
    });
  });

  it("follows the model's choice, and stays when it fails", async () => {
    expect(await decideTopic({ text: "back to orders", candidates, llm: model({ topic: 1 }) })).toEqual({ kind: "same", id: "earlier" });
    expect(await decideTopic({ text: "vendors?", candidates, llm: model({ topic: -1, name: "Vendors." }) })).toEqual({
      kind: "new",
      name: "Vendors",
      why: "model",
    });
    expect(await decideTopic({ text: "x", candidates, llm: model({ topic: 7 }) })).toEqual({ kind: "same", id: "now" });
    expect(await decideTopic({ text: "x", candidates, llm: model(new Error("down")) })).toEqual({ kind: "same", id: "now" });
  });
});

describe("chat topic routes", () => {
  const build = async (options: { llm?: LlmAdapter | null; work?: TimelineTask[] } = {}) => {
    const app = Fastify();
    installIdentity(app, localOwner());
    await app.register(
      chatTopicRoutes({
        storeFor: () => new TopicStore(db, owner),
        llm: () => options.llm ?? null,
        work: async () => options.work ?? [],
        now: () => NOW,
      }),
    );
    return app;
  };

  it("starts a topic for the first message, then stays in it", async () => {
    const app = await build();
    const first = await app.inject({ method: "POST", url: "/api/chat/route", payload: { text: "rent for unit 4?", tz: "UTC" } });
    expect(first.json()).toMatchObject({ isNew: true, name: "Rent for unit 4" });
    const id = first.json().topicId as string;
    await db.adapter.appendMessage({ sessionId: id, role: "user", content: "rent for unit 4?" }, auth);
    await sql`UPDATE freebird_chat_message SET created_at = ${hoursAgo(1)}`.execute(db.kysely);

    const next = await app.inject({ method: "POST", url: "/api/chat/route", payload: { text: "and unit 5?", topicId: id, tz: "UTC" } });
    expect(next.json()).toEqual({ topicId: id, name: "Rent for unit 4", isNew: false });
  });

  it("starts a new topic on a new day", async () => {
    const yesterday = await topic("Rent", [[30, "user", "rent?"]]);
    const app = await build();
    const routed = await app.inject({ method: "POST", url: "/api/chat/route", payload: { text: "rent again", topicId: yesterday, tz: "UTC" } });
    expect(routed.json()).toMatchObject({ isNew: true });
  });

  it("can continue an older topic the person jumped to", async () => {
    const yesterday = await topic("Rent", [[30, "user", "rent?"]]);
    const app = await build({ llm: model({ topic: 0 }) });
    const routed = await app.inject({
      method: "POST",
      url: "/api/chat/route",
      payload: { text: "and unit 5?", topicId: yesterday, viewing: yesterday, tz: "UTC" },
    });
    expect(routed.json()).toEqual({ topicId: yesterday, name: "Rent", isNew: false });
  });

  it("lists days with talk or finished work, and a day's topics and tasks", async () => {
    await topic("Rent", [[30, "user", "rent?"]]);
    await topic("Orders", [[1, "user", "orders?"]]);
    const work: TimelineTask[] = [
      { id: "run:1", kind: "run", at: hoursAgo(2), title: "Late rent reminders", status: "succeeded" },
      { id: "run:2", kind: "run", at: hoursAgo(80), title: "Weekly report", status: "succeeded" },
    ];
    const app = await build({ work });
    const days = (await app.inject({ method: "GET", url: "/api/chat/days?tz=UTC" })).json();
    expect(days.today).toBe(dayOf(NOW, "UTC"));
    expect(days.days.map((one: { day: string; tasks: number }) => [one.day, one.tasks])).toEqual([
      [dayOf(NOW, "UTC"), 1],
      [dayOf(hoursAgo(30), "UTC"), 0],
      [dayOf(hoursAgo(80), "UTC"), 1],
    ]);

    const day = (await app.inject({ method: "GET", url: `/api/chat/day/${dayOf(NOW, "UTC")}?tz=UTC` })).json();
    expect(day.topics.map((one: { name: string }) => one.name)).toEqual(["Orders"]);
    expect(day.tasks.map((one: { title: string }) => one.title)).toEqual(["Late rent reminders"]);

    const messages = (await app.inject({ method: "GET", url: "/api/chat/messages?tz=UTC" })).json();
    expect(messages.day).toBe(dayOf(NOW, "UTC"));
    expect(messages.messages.map((one: { content: string }) => one.content)).toEqual(["orders?"]);
    expect(messages.prev).toBe(dayOf(hoursAgo(30), "UTC"));

    expect((await app.inject({ method: "GET", url: "/api/chat/day/yesterday" })).statusCode).toBe(400);
  });
});
