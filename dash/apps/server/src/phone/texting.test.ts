import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTwilioProvider, twilioSignature, type TwilioOptions } from "@freebirdai/adapters-phone-twilio";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { Contact, InboundText, PhoneLineSpec, PhoneLineView, Task } from "@freebirdai/dash-spec";
import { FAKE_SECRET, FakeCarrier } from "@freebirdai/phone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryAgentStore } from "../agents/store.js";
import { ContactError, ContactService } from "../contacts/service.js";
import { MemoryContactStore } from "../contacts/store.js";
import { MemoryInboundStore } from "../inbound/store.js";
import { openDashDb } from "../platform/db.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { MemoryCaseStore, MemoryTaskStore, MemoryWorkflowStore } from "../workflows/store.js";
import { agentOf, node, owner, workflowOf } from "../workflows/testing.js";
import { keywordAnswer, PhoneInbox } from "./inbox.js";
import { PhoneOutreach, type PhoneLine } from "./outreach.js";
import { PhoneSetup, forwardingSteps } from "./setup.js";
import { PhoneLines } from "./lines.js";
import { DbPhoneTextStore, KEPT_TEXTS, MemoryPhoneTextStore } from "./texts.js";
import { MemoryPhoneUsageStore } from "./usage.js";

/*
 * Dash Phone, Phase 1: texting. The four send checks in order, STOP / HELP /
 * START, kept texts and who started a conversation, consent on contacts,
 * Settings → Phone with the public address check, and the whole server path
 * over the fake carrier and over Twilio's recorded answers.
 */

const T0 = Date.parse("2026-11-12T15:00:00.000Z");
const CUSTOMER = "+15550100200";
const STRANGER = "+15550100300";
const LINE_A = "+15550100100";
const LINE_B = "+15550100111";

const lineOf = (id: string, number: string, phone: Partial<PhoneLineSpec> = {}): PhoneLine => ({
  id,
  title: `Line ${id}`,
  phone: { provider: "fake", number, owner: { kind: "agent", id: "maint" }, text: { status: "approved" }, voice: { status: "ready" }, ceilings: { textsPerDay: 200, callMinutesPerDay: 120 }, calls: { answer: "agent", recording: true, disclosure: "" }, ...phone },
});

const inbound = (from: string, to: string, body: string, id: string): InboundText => ({ from, to, body, media: [], at: new Date(T0).toISOString(), providerId: id });

const setUp = (options: { lines?: PhoneLine[]; consent?: Record<string, "given" | "withdrawn">; tasks?: { get(id: string): Promise<Task | null>; put(task: Task): Promise<void> } } = {}) => {
  const carrier = new FakeCarrier({ now: () => T0 });
  const lines = options.lines ?? [lineOf("a", LINE_A)];
  const consent = new Map<string, "given" | "withdrawn">(Object.entries(options.consent ?? {}));
  const texts = new MemoryPhoneTextStore();
  const usage = new MemoryPhoneUsageStore();
  const outreach = new PhoneOutreach({
    lines: () => lines,
    providers: { fake: carrier.open },
    keysFor: () => ({ secret: FAKE_SECRET }),
    usage,
    agents: { get: async () => agentOf() },
    consent: async (number) => (consent.has(number) ? { status: consent.get(number)! } : null),
    texts,
    ...(options.tasks ? { tasks: options.tasks } : {}),
    now: () => T0,
  });
  const arrived: InboundText[] = [];
  const inbox = new PhoneInbox({
    texts,
    outreach,
    consent: {
      withdraw: async (number) => void consent.set(number, "withdrawn"),
      restore: async (number) => (consent.has(number) ? (consent.set(number, "given"), true) : false),
    },
    brand: async () => "Acme Plumbing",
    arrived: async (_line, text) => {
      arrived.push(text);
      return { contact: "ct-1" };
    },
  });
  const send = (key: string, to = CUSTOMER) => outreach.send({ channel: "text", to, text: "Hello from Acme", agent: { id: "maint", name: "Maintenance agent" }, key });
  return { carrier, lines, consent, texts, usage, outreach, inbox, arrived, send };
};

describe("the four send checks, in order", () => {
  it("1: an unregistered line refuses first, whatever else is true", async () => {
    const w = setUp({ lines: [lineOf("a", LINE_A, { text: { status: "pending" } })], consent: { [CUSTOMER]: "withdrawn" } });
    expect((await w.send("k")).detail).toMatch(/registration is approved/);
  });

  it("2: someone who replied STOP is refused, even after texting first", async () => {
    const w = setUp({ consent: { [CUSTOMER]: "withdrawn" } });
    await w.inbox.receive(w.lines[0]!, inbound(CUSTOMER, LINE_A, "Hi there", "IM1"));
    expect((await w.send("k")).detail).toMatch(/replied STOP/);
    expect(w.carrier.sent).toHaveLength(0);
  });

  it("3: no consent and no text from them is refused; consent on record or a text from them first allows it, and says which", async () => {
    const w = setUp();
    const refused = await w.send("k1");
    expect(refused).toMatchObject({ status: "not_sent", detail: expect.stringMatching(/not agreed to texts/) });
    await w.inbox.receive(w.lines[0]!, inbound(CUSTOMER, LINE_A, "Do you do Saturdays?", "IM1"));
    expect(await w.send("k2")).toMatchObject({ status: "queued", basis: "texted_first" });
    const agreed = setUp({ consent: { [CUSTOMER]: "given" } });
    expect(await agreed.send("k3")).toMatchObject({ status: "queued", basis: "on_record" });
  });

  it("3: texting a line first counts for that line only, and only when they wrote first", async () => {
    const w = setUp({ lines: [lineOf("a", LINE_A), lineOf("b", LINE_B, { owner: { kind: "team" } })] });
    await w.inbox.receive(w.lines[1]!, inbound(CUSTOMER, LINE_B, "Hello?", "IM1"));
    /* The agent's own line is "a": they wrote to "b", so "a" may not start a conversation with them. */
    expect((await w.send("k")).status).toBe("not_sent");
    /* A conversation the business started stays the business's, even after they answer. */
    const started = setUp({ consent: { [CUSTOMER]: "given" } });
    await started.send("first");
    started.consent.clear();
    await started.inbox.receive(started.lines[0]!, inbound(CUSTOMER, LINE_A, "who is this?", "IM2"));
    expect((await started.send("second")).detail).toMatch(/not agreed to texts/);
  });

  it("4: the ceiling comes last, so a refused text never uses one up", async () => {
    const w = setUp({ lines: [lineOf("a", LINE_A, { ceilings: { textsPerDay: 1, callMinutesPerDay: 120 } })] });
    await w.send("no-consent");
    w.consent.set(CUSTOMER, "given");
    expect((await w.send("ok")).status).toBe("queued");
    expect((await w.send("over")).detail).toMatch(/1 texts for today/);
  });

  it("keeps each text it sends in the line's conversation", async () => {
    const w = setUp({ consent: { [CUSTOMER]: "given" } });
    await w.send("k");
    const [kept] = await w.texts.thread("a", CUSTOMER);
    expect(kept).toMatchObject({ direction: "out", body: "Hello from Acme", agent: "maint", status: "queued" });
    expect((await w.texts.threadOf("a", CUSTOMER))?.startedBy).toBe("us");
  });

  it("fills the task's delivery from the provider's later update", async () => {
    const held = new Map<string, Task>([["task-1", { id: "task-1", status: "done", delivery: { status: "queued", key: "k" } } as unknown as Task]]);
    const tasks = { get: async (id: string) => held.get(id) ?? null, put: async (task: Task) => void held.set(task.id, task) };
    const w = setUp({ consent: { [CUSTOMER]: "given" }, tasks });
    await w.outreach.send({ channel: "text", to: CUSTOMER, text: "Hi", agent: { id: "maint", name: "M" }, key: "k", task: "task-1" });
    w.carrier.failDelivery(CUSTOMER, "30006");
    const [sent] = w.carrier.sent;
    await w.outreach.delivered("a", { providerId: sent!.providerId, status: "failed", errorCode: "30006" });
    expect((await tasks.get("task-1"))?.delivery).toMatchObject({ status: "failed", detail: expect.stringContaining("30006") });
    expect((await w.texts.get("a", sent!.providerId))?.status).toBe("failed");
  });
});

describe("STOP, HELP and START, answered by Dash", () => {
  it("STOP withdraws consent, confirms once, reaches nobody, and stops every line", async () => {
    const w = setUp({ lines: [lineOf("a", LINE_A, { owner: { kind: "team" } }), lineOf("b", LINE_B)], consent: { [CUSTOMER]: "given" } });
    expect(await w.inbox.receive(w.lines[0]!, inbound(CUSTOMER, LINE_A, " stop! ", "IM1"))).toEqual({ kind: "keyword", keyword: "stop" });
    expect(w.consent.get(CUSTOMER)).toBe("withdrawn");
    expect(w.arrived).toEqual([]);
    expect(w.carrier.sent).toEqual([expect.objectContaining({ from: LINE_A, to: CUSTOMER, body: keywordAnswer("stop", "Acme Plumbing", false) })]);
    /* The agent's line is "b": it was never texted STOP, and still may not text them. */
    expect((await w.send("after")).detail).toMatch(/replied STOP/);
    /* The same webhook again does nothing more. */
    expect(await w.inbox.receive(w.lines[0]!, inbound(CUSTOMER, LINE_A, "STOP", "IM1"))).toEqual({ kind: "duplicate" });
    expect(w.carrier.sent).toHaveLength(1);
    expect((await w.texts.thread("a", CUSTOMER)).map((one) => [one.direction, one.keyword])).toEqual([["out", "stop"], ["in", "stop"]]);
  });

  it("HELP says who this is and how to reach a person; START restores consent given before, and only that", async () => {
    const w = setUp({ consent: { [CUSTOMER]: "withdrawn" } });
    await w.inbox.receive(w.lines[0]!, inbound(CUSTOMER, LINE_A, "help", "IM1"));
    expect(w.carrier.sent.at(-1)!.body).toMatch(/^Acme Plumbing: .*person/);
    await w.inbox.receive(w.lines[0]!, inbound(CUSTOMER, LINE_A, "START", "IM2"));
    expect(w.consent.get(CUSTOMER)).toBe("given");
    expect(w.carrier.sent.at(-1)!.body).toMatch(/subscribed again/);
    await w.inbox.receive(w.lines[0]!, inbound(STRANGER, LINE_A, "start", "IM3"));
    expect(w.consent.has(STRANGER)).toBe(false);
    expect(w.carrier.sent.at(-1)!.body).toMatch(/don't have your agreement/);
    expect(w.arrived).toEqual([]);
  });

  it("a sentence with STOP in it is conversation, not a keyword", async () => {
    const w = setUp({ consent: { [CUSTOMER]: "given" } });
    expect(await w.inbox.receive(w.lines[0]!, inbound(CUSTOMER, LINE_A, "Please stop by on Tuesday", "IM1"))).toEqual({ kind: "arrived", held: false });
    expect(w.consent.get(CUSTOMER)).toBe("given");
    expect(w.arrived).toHaveLength(1);
  });
});

describe("kept texts", () => {
  it("keeps the newest per line and remembers who started each conversation after they are trimmed", async () => {
    const texts = new MemoryPhoneTextStore();
    await texts.add({ line: "a", id: "first", number: CUSTOMER, direction: "in", body: "hi", at: "2026-01-01T00:00:00.000Z" });
    for (let i = 0; i < KEPT_TEXTS; i++) await texts.add({ line: "a", id: `m${i}`, number: STRANGER, direction: "out", body: String(i), at: new Date(Date.parse("2026-02-01T00:00:00Z") + i * 1000).toISOString() });
    expect(await texts.get("a", "first")).toBeNull();
    expect((await texts.threadOf("a", CUSTOMER))?.startedBy).toBe("them");
  });

  it("holds in the database, sealed, once per provider id", async () => {
    const db = await openDashDb({ databaseUrl: undefined, inMemory: true });
    try {
      const cipher = { encrypt: (plain: string) => `sealed:${Buffer.from(plain).toString("base64")}`, decrypt: (token: string) => Buffer.from(token.slice(7), "base64").toString() };
      const texts = new DbPhoneTextStore(db, cipher, "acme");
      const one = { line: "a", id: "IM1", number: CUSTOMER, direction: "in" as const, body: "Is Saturday open?", at: new Date(T0).toISOString() };
      expect(await texts.add(one)).toBe(true);
      expect(await texts.add(one)).toBe(false);
      await texts.add({ ...one, id: "SM1", direction: "out", body: "Yes", at: new Date(T0 + 1000).toISOString() });
      await texts.update("a", "SM1", { status: "delivered" });
      expect((await texts.thread("a", CUSTOMER)).map((row) => [row.id, row.status])).toEqual([["SM1", "delivered"], ["IM1", undefined]]);
      expect(await texts.threadOf("a", CUSTOMER)).toMatchObject({ startedBy: "them", lastAt: new Date(T0 + 1000).toISOString() });
      expect((await texts.threads("a")).map((row) => row.number)).toEqual([CUSTOMER]);
      const raw = await db.kysely.selectFrom("dash_phone_texts" as never).selectAll().execute();
      expect(JSON.stringify(raw)).not.toContain("Saturday");
      expect(await new DbPhoneTextStore(db, cipher, "other").get("a", "IM1")).toBeNull();
    } finally {
      await db.close();
    }
  });
});

describe("consent to texts on a contact", () => {
  const contactsOf = () => new ContactService({ store: new MemoryContactStore(), now: () => T0, newId: (() => { let n = 0; return () => `n${++n}`; })() });

  it("is given only by an opt-in form or a booking page, for the contact's own number, with the words agreed to", async () => {
    const contacts = contactsOf();
    const made = await contacts.findOrCreate({ phone: CUSTOMER, name: "Dana", origin: "public_link" });
    await expect(contacts.giveTextConsent(made.id, { source: "keyword", wording: "x", phone: CUSTOMER })).rejects.toBeInstanceOf(ContactError);
    await expect(contacts.giveTextConsent(made.id, { source: "imported", wording: "x", phone: CUSTOMER })).rejects.toThrow(/opt-in form or a booking page/);
    await expect(contacts.giveTextConsent(made.id, { source: "booking_page", wording: "x", phone: STRANGER })).rejects.toThrow(/own numbers/);
    const given = await contacts.giveTextConsent(made.id, { source: "booking_page", wording: "Text me about this booking.", phone: CUSTOMER });
    expect(given.textConsent).toEqual({ status: "given", source: "booking_page", at: new Date(T0).toISOString(), wording: "Text me about this booking.", phone: CUSTOMER });
  });

  it("is never set by a member's edit", async () => {
    const contacts = contactsOf();
    const made = await contacts.findOrCreate({ phone: CUSTOMER, origin: "member" });
    const edited = await contacts.update(made.id, { name: "Dana", textConsent: { status: "given", source: "booking_page", at: "x", wording: "y" } }, "sam");
    expect(edited.textConsent).toBeUndefined();
  });

  it("STOP withdraws it keeping where it came from; START restores only what a page gave", async () => {
    const contacts = contactsOf();
    const made = await contacts.findOrCreate({ phone: CUSTOMER, origin: "public_link" });
    await contacts.giveTextConsent(made.id, { source: "booking_page", wording: "Text me.", phone: CUSTOMER });
    expect((await contacts.withdrawTextConsent(CUSTOMER))?.textConsent).toMatchObject({ status: "withdrawn", source: "booking_page", wording: "Text me." });
    expect(await contacts.restoreTextConsent(CUSTOMER)).toBe(true);
    expect((await contacts.byPhone(CUSTOMER))?.textConsent?.status).toBe("given");
    const stranger = await contacts.findOrCreate({ phone: STRANGER, origin: "text" });
    expect((await contacts.withdrawTextConsent(STRANGER))?.textConsent).toMatchObject({ status: "withdrawn", source: "keyword" });
    expect(await contacts.restoreTextConsent(STRANGER)).toBe(false);
    expect((await contacts.get(stranger.id))?.textConsent?.status).toBe("withdrawn");
  });
});

describe("Settings → Phone", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-phone-setup-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const setupWith = (name: string, options: { origin?: string; reachable?: boolean } = {}) => {
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 3)), join(dir, name, "vault.json"));
    const store = new SpecStore(join(dir, name, "d"), join(dir, name, "c"), join(dir, name, "r"));
    const carrier = new FakeCarrier({ now: () => T0, numbers: ["+15550100400"] });
    const lines = new PhoneLines({
      connections: { list: () => store.listConnections(), get: (id) => store.getConnection(id), put: (spec) => store.putConnection(spec), remove: async (id) => store.deleteConnection(id) },
      keys,
      providers: { fake: carrier.open },
      usage: new MemoryPhoneUsageStore(),
      policy: { can: () => ({ ok: true }) },
      agents: { get: async (id) => (id === "maint" ? agentOf() : null) },
      now: () => T0,
    });
    const asked: string[] = [];
    let setup: PhoneSetup;
    setup = new PhoneSetup({
      providers: { fake: carrier.open },
      keys,
      lines,
      workspace: "acme",
      ...(options.origin === undefined ? { publicOrigin: "https://dash.example" } : options.origin ? { publicOrigin: options.origin } : {}),
      probe: async (url) => {
        asked.push(url);
        const nonce = url.split("/").at(-1)!;
        return options.reachable === false ? Promise.reject(new Error("ECONNREFUSED")) : { status: 200, text: setup.answer(nonce) ? JSON.stringify({ nonce }) : "{}" };
      },
      now: () => T0,
    });
    return { setup, carrier, keys, store, asked };
  };

  it("checks keys with the provider and keeps them only when they are good", async () => {
    const s = setupWith("keys");
    await expect(s.setup.connect("fake", { secret: "wrong" })).rejects.toThrow(/refused/);
    expect(s.setup.accounts()[0]).toMatchObject({ id: "fake", connected: false });
    expect(await s.setup.connect("fake", { secret: FAKE_SECRET })).toMatchObject({ trial: false });
    expect(s.setup.accounts()[0]).toMatchObject({ connected: true });
    expect(JSON.stringify(s.setup.accounts())).not.toContain(FAKE_SECRET);
    s.setup.disconnect("fake");
    expect(s.setup.accounts()[0]).toMatchObject({ connected: false });
  });

  it("checks the public address by asking itself, and says how to fix it when it fails", async () => {
    expect(await setupWith("ok").setup.checkAddress()).toEqual({ ok: true, origin: "https://dash.example" });
    const none = await setupWith("none", { origin: "" }).setup.checkAddress();
    expect(none).toMatchObject({ ok: false, problem: expect.stringMatching(/does not know the address/) });
    expect(none.fixes!.map((one) => one.title)).toEqual(["Use a tunnel", "Use this server's own domain"]);
    expect(none.fixes![0]!.steps.join(" ")).toContain("cloudflared tunnel --url http://localhost:");
    expect((await setupWith("http", { origin: "http://dash.example" }).setup.checkAddress()).problem).toMatch(/not an https address/);
    expect((await setupWith("down", { reachable: false }).setup.checkAddress()).problem).toMatch(/Nothing answered/);
  });

  it("answers only its own question, and only while asking", async () => {
    const s = setupWith("answer");
    expect(s.setup.answer("never-asked-this-one")).toBe(false);
    await s.setup.checkAddress();
    expect(s.setup.answer(s.asked[0]!.split("/").at(-1)!)).toBe(false);
  });

  it("buys nothing while the address fails", async () => {
    const s = setupWith("nobuy", { reachable: false });
    await s.setup.connect("fake", { secret: FAKE_SECRET });
    await expect(s.setup.addLine({ provider: "fake", choice: "new", number: "+15555550100" })).rejects.toThrow(/Nothing answered/);
    expect(s.carrier.owned.map((one) => one.number)).toEqual(["+15550100400"]);
    expect(s.store.listConnections()).toEqual([]);
  });

  it("buys a new number, uses one in the account, or receives on a new one for a forwarded business number; and wires each", async () => {
    const s = setupWith("lines");
    await expect(s.setup.addLine({ provider: "fake", choice: "existing", number: "+15550100400" })).rejects.toThrow(/Connect the provider/);
    await s.setup.connect("fake", { secret: FAKE_SECRET });
    const [found] = await s.setup.search("fake", "415");
    const bought = await s.setup.addLine({ provider: "fake", choice: "new", number: found!.number, owner: { kind: "agent", id: "maint" } });
    expect(bought.line).toMatchObject({ number: found!.number, owner: { kind: "agent", id: "maint" } });
    expect(s.carrier.routes.get(found!.number)).toEqual({ textWebhook: `https://dash.example/api/public/acme/phone/${bought.line.id}/text` });
    const existing = await s.setup.addLine({ provider: "fake", choice: "existing", number: "+15550100400" });
    expect(existing.forwarding).toBeUndefined();
    await expect(s.setup.addLine({ provider: "fake", choice: "existing", number: "+15550100499" })).rejects.toThrow(/not in this account/);
    const forwarded = await s.setup.addLine({ provider: "fake", choice: "forward", number: "+15550100777" });
    expect(forwarded.forwarding).toEqual(forwardingSteps("+15550100777"));
    expect(forwarded.forwarding!.join(" ")).toContain("*725550100777");
    expect((await s.setup.owned("fake")).map((one) => one.number).sort()).toEqual([found!.number, "+15550100400", "+15550100777"].sort());
  });
});

describe("texting through the server", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-phone-server-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const serverWith = async (name: string, providers: Parameters<typeof buildServer>[0]["phoneProviders"]) => {
    const store = new SpecStore(join(dir, name, "d"), join(dir, name, "c"), join(dir, name, "r"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 9)), join(dir, name, "vault.json"));
    const agents = new MemoryAgentStore();
    await agents.put(agentOf({ id: "desk", name: "Front desk" }));
    const workflows = new MemoryWorkflowStore();
    await workflows.put(
      workflowOf({
        id: "answer-text",
        name: "Answer texts",
        trigger: { kind: "message_received", channels: ["text"] },
        enabledBy: owner,
        nodes: [node("reply", "outreach.text", { agentId: "desk", to: "{{ from.address }}", purpose: "Answer", content: "fixed", wording: "Yes, Saturdays 9 to 1." })],
      }),
    );
    const contactStore = new MemoryContactStore();
    const inboundStore = new MemoryInboundStore();
    const tasks = new MemoryTaskStore();
    const cases = new MemoryCaseStore();
    let app: ReturnType<typeof buildServer>;
    app = buildServer({
      store,
      keys,
      llm: null,
      agents,
      workflows,
      cases,
      tasks,
      contacts: contactStore,
      inbound: inboundStore,
      phoneProviders: providers,
      publicOrigin: "https://dash.example",
      /* The public address, reached: the request comes back into this same server. */
      phoneProbe: async (url) => {
        const answer = await app.inject({ method: "GET", url: new URL(url).pathname });
        return { status: answer.statusCode, text: answer.body };
      },
    });
    return { app, store, keys, contactStore, inboundStore, tasks, cases };
  };

  it("sets a line up, takes a text in as a contact, screens it, answers it, and handles STOP", async () => {
    const carrier = new FakeCarrier({ now: () => Date.now() });
    const s = await serverWith("fake", { fake: carrier.open });
    try {
      expect((await s.app.inject({ method: "POST", url: "/api/comms/lines/address-check" })).json()).toEqual({ ok: true, origin: "https://dash.example" });
      expect((await s.app.inject({ method: "POST", url: "/api/comms/lines/accounts/fake", payload: { keys: { secret: FAKE_SECRET } } })).statusCode).toBe(200);
      const [number] = ((await s.app.inject({ method: "GET", url: "/api/comms/lines/accounts/fake/numbers?areaCode=415" })).json() as { numbers: { number: string }[] }).numbers;
      const made = (await s.app.inject({ method: "POST", url: "/api/comms/lines/setup", payload: { provider: "fake", choice: "new", number: number!.number, owner: { kind: "agent", id: "desk" } } })).json() as { line: PhoneLineView };
      expect(made.line).toMatchObject({ text: "approved", owner: { kind: "agent", id: "desk" } });
      const hook = `/api/public/local/phone/${made.line.id}/text`;
      expect(carrier.routes.get(number!.number)?.textWebhook).toBe(`https://dash.example${hook}`);

      const raw = carrier.inboundText({ from: STRANGER, to: number!.number, body: "Are you open Saturdays?" }, `https://dash.example${hook}`);
      expect((await s.app.inject({ method: "POST", url: hook, headers: raw.headers as Record<string, string>, payload: raw.body })).statusCode).toBe(200);
      const contact = (await s.contactStore.byKey(`phone:${STRANGER}`)) as Contact;
      expect(contact).toMatchObject({ origin: "text", phones: [STRANGER] });
      expect(await s.inboundStore.screens()).toEqual([expect.objectContaining({ channel: "text", from: STRANGER, mailbox: made.line.id, contact: contact.id })]);
      /* They texted first: the workflow's answer goes, and says why. */
      expect(carrier.sent).toEqual([expect.objectContaining({ to: STRANGER, body: "Yes, Saturdays 9 to 1." })]);
      const [task] = await s.tasks.list({ limit: 10 });
      expect(task?.delivery).toMatchObject({ status: "queued", basis: "texted_first" });
      /* The carrier's delivery update, signed, fills the task. */
      const status = carrier.statusRequest(carrier.takeUpdates()[0]!, `https://dash.example/api/public/local/phone/${made.line.id}/status`);
      expect((await s.app.inject({ method: "POST", url: `/api/public/local/phone/${made.line.id}/status`, headers: status.headers as Record<string, string>, payload: status.body })).statusCode).toBe(200);
      expect((await s.tasks.get(task!.id))?.delivery?.status).toBe("delivered");
      const threads = (await s.app.inject({ method: "GET", url: `/api/comms/lines/${made.line.id}/threads` })).json() as { threads: { number: string; startedBy: string }[] };
      expect(threads.threads).toEqual([expect.objectContaining({ number: STRANGER, startedBy: "them" })]);

      /* STOP: consent withdrawn on the contact, one confirmation, no workflow. */
      const stop = carrier.stopReply(STRANGER, number!.number, `https://dash.example${hook}`);
      await s.app.inject({ method: "POST", url: hook, headers: stop.headers as Record<string, string>, payload: stop.body });
      expect((await s.contactStore.byKey(`phone:${STRANGER}`))?.textConsent).toMatchObject({ status: "withdrawn" });
      expect(carrier.sent.at(-1)!.body).toMatch(/unsubscribed/);
      expect(await s.tasks.list({ limit: 10 })).toHaveLength(1);
      const thread = (await s.app.inject({ method: "GET", url: `/api/comms/lines/${made.line.id}/threads/${encodeURIComponent(STRANGER)}` })).json() as { texts: { direction: string; keyword?: string }[] };
      expect(thread.texts.map((one) => one.keyword ?? one.direction)).toEqual(["in", "out", "stop", "stop"]);

      /* Owner. */
      expect((await s.app.inject({ method: "PUT", url: `/api/comms/lines/${made.line.id}/owner`, payload: { owner: { kind: "team" } } })).json()).toMatchObject({ owner: { kind: "team" } });
    } finally {
      await s.app.close();
    }
  });

  it("takes a Twilio-signed text in on a Twilio line, and checks it with the line's own Auth Token", async () => {
    const SID = "AC" + "0123456789abcdef".repeat(2);
    const TOKEN = "twilio-token";
    const NUMBER = { sid: "PN0123456789abcdef0123456789abcdef", phone_number: "+14155550100", capabilities: { voice: true, sms: true } };
    const calls: string[] = [];
    const fetch: NonNullable<TwilioOptions["fetch"]> = async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(`${init.method} ${path}`);
      const body =
        path.endsWith(`${SID}.json`) ? { sid: SID, friendly_name: "Acme Plumbing", status: "active", type: "Trial" }
        : path.endsWith("/IncomingPhoneNumbers.json") ? { incoming_phone_numbers: [NUMBER] }
        : path.endsWith(`/IncomingPhoneNumbers/${NUMBER.sid}.json`) ? NUMBER
        : null;
      return { status: body ? 200 : 404, text: async () => JSON.stringify(body ?? { code: 20404, message: "Not found" }) };
    };
    const s = await serverWith("twilio", { twilio: createTwilioProvider({ fetch }) });
    try {
      expect((await s.app.inject({ method: "POST", url: "/api/comms/lines/accounts/twilio", payload: { keys: { accountSid: SID, authToken: TOKEN } } })).json()).toEqual({ name: "Acme Plumbing", trial: true });
      const made = (await s.app.inject({ method: "POST", url: "/api/comms/lines/setup", payload: { provider: "twilio", choice: "existing", number: "+14155550100", owner: { kind: "agent", id: "desk" } } })).json() as { line: PhoneLineView };
      expect(made.line).toMatchObject({ provider: "twilio", text: "needs_registration", voice: "not_connected" });
      expect(calls).toContain(`POST /2010-04-01/Accounts/${SID}/IncomingPhoneNumbers/${NUMBER.sid}.json`);
      const hook = `/api/public/local/phone/${made.line.id}/text`;
      const form = new URLSearchParams({ MessageSid: "SM1", From: STRANGER, To: "+14155550100", Body: "Hello", NumMedia: "0" });
      const signed = (token: string) => ({ "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, `https://dash.example${hook}`, form) });
      expect((await s.app.inject({ method: "POST", url: hook, headers: signed("someone-else"), payload: form.toString() })).statusCode).toBe(403);
      expect((await s.app.inject({ method: "POST", url: hook, headers: signed(TOKEN), payload: form.toString() })).statusCode).toBe(200);
      expect(await s.contactStore.byKey(`phone:${STRANGER}`)).not.toBeNull();
      /* Not registered yet: the answer is not sent, and the task says why. */
      const [task] = await s.tasks.list({ limit: 10 });
      expect(task?.delivery).toMatchObject({ status: "not_sent", detail: expect.stringMatching(/registration is approved/) });
    } finally {
      await s.app.close();
    }
  });
});
