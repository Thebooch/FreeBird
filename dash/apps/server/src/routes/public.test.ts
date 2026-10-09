import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { Principal } from "@freebirdai/dash-spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TeamNotice } from "../bookings/notify.js";
import { MemoryBookingStore } from "../bookings/store.js";
import { MemoryCalendarStore } from "../calendar/store.js";
import { MemoryContactStore } from "../contacts/store.js";
import { MemoryMembershipStore } from "../identity/members.js";
import { rolePolicy } from "../identity/policy.js";
import { publicRoutesOf } from "../identity/public.js";
import type { IdentityResolver } from "../identity/resolver.js";
import { WorkspaceHost } from "../platform/workspaces.js";
import { MemoryRateLimiter } from "../public/limits.js";
import { MemoryPublicTokenStore } from "../public/tokens.js";
import { MemorySchedulingStore } from "../scheduling/store.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { MemoryCaseStore, MemorySignalStore, MemoryTaskStore, MemoryWorkflowStore } from "../workflows/store.js";
import { node, workflowOf } from "../workflows/testing.js";
import { PUBLIC_ROUTES } from "./public.js";

/*
 * The pages anyone may open. Every request below to `/api/public/…` is
 * made with nobody signed in: the server they go to resolves no one.
 */

const CHICAGO = "America/Chicago";
const DAY = 86_400_000;
const editorOf: Principal = { userId: "ed", workspaceId: "acme", role: "editor", kind: "member" };

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-public-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Two servers over the same stores: the team's, signed in as Ed, and the public's, signed in as nobody. */
const setup = async (name: string, options: { readonly approval?: "always" | "none"; readonly limiter?: MemoryRateLimiter } = {}) => {
  const store = new SpecStore(join(dir, name, "dashboards"), join(dir, name, "connections"), join(dir, name, "reports"));
  const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, name, ".dash", "vault.json"));
  const memberships = new MemoryMembershipStore();
  const join_ = (userId: string, role: Principal["role"]) => memberships.putMember({ workspaceId: "acme", userId, email: `${userId}@acme.test`, role, grants: [], joinedAt: "2026-10-06T00:00:00.000Z" });
  await join_("ed", "editor");
  const notices: TeamNotice[] = [];
  const shared = {
    store,
    keys,
    workspace: { id: "acme", key: "acme" },
    scheduling: new MemorySchedulingStore(),
    contacts: new MemoryContactStore(),
    bookings: new MemoryBookingStore(),
    calendar: new MemoryCalendarStore(),
    workflows: new MemoryWorkflowStore(),
    cases: new MemoryCaseStore(),
    tasks: new MemoryTaskStore(),
    signals: new MemorySignalStore(),
    tokens: new MemoryPublicTokenStore(),
    rateLimiter: options.limiter ?? new MemoryRateLimiter(),
    notifier: { notify: async (notice: TeamNotice) => (notices.push(notice), { status: "queued" as const }) },
    brand: async () => ({ name: "Acme Home Services", accent: "#0f766e" }),
    pagesOrigin: "https://dash.example.com",
    members: async () => (await memberships.members("acme")).map((one) => ({ userId: one.userId, email: one.email, role: one.role })),
    policy: rolePolicy(memberships),
  };
  const nobody: IdentityResolver = { resolve: () => null };
  const team = buildServer({ ...shared, identity: { resolve: () => editorOf } });
  const world = buildServer({ ...shared, identity: nobody });

  /* Weekdays two and three days out, 10:00 and 11:00 in Chicago (UTC-5 in October). */
  let day = Date.now() + 2 * DAY;
  while ([0, 6].includes(new Date(day).getUTCDay())) day += DAY;
  const date = new Date(day).toISOString().slice(0, 10);
  const at = (hour: number) => new Date(`${date}T${String(hour + 5).padStart(2, "0")}:00:00.000Z`).toISOString();

  await team.inject({ method: "PUT", url: "/api/scheduling/profiles/ed", payload: { displayName: "Ed", timezone: CHICAGO, bookable: true } });
  await team.inject({
    method: "PUT",
    url: "/api/scheduling/types/visit",
    payload: { name: "Visit", slug: "visit", hosts: { members: ["ed"] }, publicLink: true, settings: { length: "60m", slotStep: "60m", minNotice: "0m", approval: options.approval ?? "none", cancelCutoff: "0m" } },
  });
  const contact = async (name: string, email: string) => (await team.inject({ method: "POST", url: "/api/contacts", payload: { name, emails: [email] } })).json() as { id: string };
  const linkFor = async (id: string) => {
    const made = (await team.inject({ method: "POST", url: `/api/contacts/${id}/links`, payload: { type: "visit" } })).json() as { url: string; link: { id: string } };
    return { token: made.url.split("/").pop()!, id: made.link.id, url: made.url };
  };
  return { team, world, shared, memberships, join_, notices, at, date, contact, linkFor };
};

describe("public routes", () => {
  it("are exactly the pinned set, answer with nobody signed in, and carry the safety headers", async () => {
    const { world } = await setup("routes");
    await world.ready();
    expect(publicRoutesOf(world)).toEqual([...PUBLIC_ROUTES].sort());

    const bogus = await world.inject({ method: "GET", url: `/api/public/acme/book/${"x".repeat(43)}` });
    expect(bogus.statusCode).toBe(404);
    expect(bogus.headers).toMatchObject({ "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    /* The same workspace's private routes still want someone signed in, and another workspace's name reaches nothing. */
    expect((await world.inject({ method: "GET", url: "/api/scheduling/bookings" })).statusCode).toBe(401);
    expect((await world.inject({ method: "GET", url: "/api/public/other/types/visit" })).statusCode).toBe(404);
    expect((await world.inject({ method: "GET", url: "/api/public/acme/unknown" })).statusCode).toBe(404);
  });
});

describe("a contact's booking link", () => {
  it("shows only their own bookings, books an open time, and opening it never acts", async () => {
    const { team, world, contact, linkFor, at } = await setup("link");
    const ana = await contact("Ana Ruiz", "ana@example.com");
    const ben = await contact("Ben Ode", "ben@example.com");
    const theirs = (await team.inject({ method: "POST", url: "/api/scheduling/bookings", payload: { type: "visit", contact: ben.id, start: at(10) } })).json().booking as { id: string };
    const { token, id } = await linkFor(ana.id);
    const base = `/api/public/acme/book/${token}`;

    const first = await world.inject({ method: "GET", url: base });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ workspace: { name: "Acme Home Services", accent: "#0f766e" }, contact: { name: "Ana Ruiz" }, type: { name: "Visit", minutes: 60, approval: false }, booking: null, canBook: true });

    const times = await world.inject({ method: "POST", url: `${base}/times`, payload: { from: at(0), to: new Date(Date.parse(at(0)) + DAY).toISOString() } });
    const slots = times.json().slots as Array<{ start: string; end: string }>;
    expect(slots.map((one) => one.start)).not.toContain(at(10));
    expect(Object.keys(slots[0]!).sort()).toEqual(["approval", "end", "recommended", "start"]);

    const booked = await world.inject({ method: "POST", url: `${base}/request`, payload: { start: at(11), notes: "Side gate", timezone: CHICAGO } });
    expect(booked.statusCode).toBe(200);
    const state = booked.json();
    expect(state.booking).toMatchObject({ status: "confirmed", start: at(11), host: "Ed", canCancel: true });
    expect(state.canBook).toBe(false);
    /* Nothing about anyone else, and nothing the team keeps to itself. */
    const text = JSON.stringify(state);
    for (const leak of [theirs.id, "ben@example.com", "Ben", "history", "values", "reason", "answers"]) expect(text).not.toContain(leak);

    /* Opening it, again and again, changes nothing. */
    const before = (await team.inject({ method: "GET", url: "/api/scheduling/bookings" })).json();
    await world.inject({ method: "GET", url: base });
    await world.inject({ method: "GET", url: base });
    expect((await team.inject({ method: "GET", url: "/api/scheduling/bookings" })).json()).toEqual(before);

    const ics = await world.inject({ method: "GET", url: `${base}/ics` });
    expect(ics.headers["content-type"]).toContain("text/calendar");
    expect(ics.body).toContain("SUMMARY:Visit with Ed");
    expect(ics.body).toContain("STATUS:CONFIRMED");

    /* Another person's booking can't be touched from this link. */
    expect((await world.inject({ method: "POST", url: `${base}/cancel`, payload: { booking: theirs.id } })).statusCode).toBe(404);
    const cancelled = await world.inject({ method: "POST", url: `${base}/cancel`, payload: { booking: state.booking.id } });
    expect(cancelled.json().booking).toMatchObject({ status: "cancelled", canCancel: false });

    /* Withdrawn from the contact sheet: it stops opening at once. */
    expect((await team.inject({ method: "POST", url: `/api/contacts/${ana.id}/links/${id}/revoke` })).json()).toMatchObject({ id, revokedAt: expect.any(String) });
    const gone = await world.inject({ method: "GET", url: base });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toMatch(/replaced or withdrawn/);
    expect(JSON.stringify((await team.inject({ method: "GET", url: `/api/contacts/${ana.id}/links` })).json())).not.toContain(token);
  });

  it("asks the type's questions its rules need, and tells someone it doesn't take why, offering nothing", async () => {
    const { team, world, shared, contact, linkFor, at } = await setup("eligibility");
    await team.inject({
      method: "PUT",
      url: "/api/scheduling/types/visit",
      payload: {
        intake: [{ field: "request.partySize", required: true, ask: "How many in your party?" }],
        eligibility: { rules: { all: [{ field: "request.partySize", op: "lte", values: [8] }], any: [] }, message: "For parties of 9 or more, please call us." },
      },
    });
    /* A workflow that follows up on people turned away. */
    await shared.workflows.put(
      workflowOf({
        id: "turned",
        trial: 0,
        enabledBy: editorOf,
        trigger: { kind: "booking", events: ["turned_away"], types: [], endWhenCancelled: false },
        nodes: [node("tell", "notify.team", { title: "{{ contact.name }} was turned away ({{ answersText }})" })],
        edges: [{ id: "e1", from: "trigger", outcome: "next", to: "tell" }],
      }),
    );
    const ana = await contact("Ana Ruiz", "ana@example.com");
    const { token } = await linkFor(ana.id);
    const times = (request?: Record<string, string>) =>
      world.inject({ method: "POST", url: `/api/public/acme/book/${token}/times`, payload: { from: at(0), to: new Date(Date.parse(at(0)) + DAY).toISOString(), ...(request ? { request } : {}) } });

    const unknown = (await times()).json();
    expect(unknown.slots).toEqual([]);
    expect(unknown.questions).toEqual([expect.objectContaining({ field: "request.partySize", question: "How many in your party?", required: true })]);
    expect((await times({ partySize: "12" })).json()).toEqual({ slots: [], questions: [], consolidatedOnly: false, more: false, notEligible: "For parties of 9 or more, please call us." });
    const four = (await times({ partySize: "4" })).json();
    expect(four.slots.length).toBeGreaterThan(0);
    expect(four.notEligible).toBeUndefined();
    const refused = await world.inject({ method: "POST", url: `/api/public/acme/book/${token}/request`, payload: { start: four.slots[0].start, request: { partySize: "12" } } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("For parties of 9 or more, please call us.");

    /* Turned away three times that day: the follow-up runs once, from the booking page. */
    let cases: Awaited<ReturnType<typeof shared.cases.list>> = [];
    for (let i = 0; i < 100 && cases.length === 0; i++) {
      cases = await shared.cases.list({ workflow: "turned" });
      if (cases.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    cases = await shared.cases.list({ workflow: "turned" });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.data.row).toMatchObject({ contact: { name: "Ana Ruiz" }, request: { partySize: "12" }, via: "booking_page" });
  });

  it("limits requests from one address and on one token", async () => {
    const { world } = await setup("limits");
    const url = `/api/public/acme/book/${"y".repeat(43)}/times`;
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await world.inject({ method: "POST", url, payload: {} })).statusCode);
    expect(codes.slice(0, 20).every((code) => code === 404)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});

describe("the public link", () => {
  it("starts with who they are, refuses a filled honeypot, and shows only bookings made through it", async () => {
    const { team, world, contact, at } = await setup("public");
    const ana = await contact("Ana Ruiz", "ana@example.com");
    await team.inject({ method: "POST", url: "/api/scheduling/bookings", payload: { type: "visit", contact: ana.id, start: at(10) } });

    const page = await world.inject({ method: "GET", url: "/api/public/acme/types/visit" });
    expect(page.json()).toMatchObject({ type: { name: "Visit", slug: "visit" }, open: true });
    expect(page.json().personal).toBeUndefined();

    expect((await world.inject({ method: "POST", url: "/api/public/acme/types/visit/start", payload: { name: "Bot", email: "bot@example.com", website: "http://spam" } })).statusCode).toBe(400);

    /* Anyone can type Ana's email: what they get sees none of her bookings, and adds nothing to her. */
    const started = await world.inject({ method: "POST", url: "/api/public/acme/types/visit/start", payload: { name: "Someone", email: "ana@example.com", phone: "512-555-0199" } });
    expect(started.statusCode).toBe(200);
    const pagePath = started.json().page as string;
    expect(pagePath).toMatch(/^\/p\/acme\/book\/[A-Za-z0-9_-]{43}$/);
    const cookie = String(started.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/public\/acme\/types\/visit/);
    const token = pagePath.split("/").pop()!;
    const state = (await world.inject({ method: "GET", url: `/api/public/acme/book/${token}` })).json();
    expect(state.booking).toBeNull();
    expect(state.contact.name).toBe("Ana Ruiz");
    const held = (await team.inject({ method: "GET", url: `/api/contacts/${ana.id}` })).json();
    expect(held.phones).toEqual([]);

    /* Back on the public link, the same browser is sent to its own page. */
    const back = await world.inject({ method: "GET", url: "/api/public/acme/types/visit", headers: { cookie: cookie.split(";")[0]! } });
    expect(back.json().personal).toBe(pagePath);

    await team.inject({ method: "PUT", url: "/api/scheduling/types/visit", payload: { publicLink: false } });
    expect((await world.inject({ method: "GET", url: "/api/public/acme/types/visit" })).statusCode).toBe(404);
  });
});

describe("the approval page", () => {
  const waitFor = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const found = await read();
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Nothing came.");
  };

  it("never acts on opening, checks every answer again, applies it once, and is spent", async () => {
    const { team, world, shared, memberships, join_, notices, contact, linkFor, at } = await setup("approve", { approval: "always" });
    await shared.workflows.put(
      workflowOf({
        id: "approval",
        name: "Booking approval",
        trial: 0,
        enabledBy: editorOf,
        trigger: { kind: "booking", events: ["requested"], types: [], endWhenCancelled: true },
        nodes: [node("approve", "ask.booking")],
        edges: [{ id: "e1", from: "trigger", outcome: "next", to: "approve" }],
      }),
    );
    const ana = await contact("Ana Ruiz", "ana@example.com");
    const { token: link } = await linkFor(ana.id);
    const requested = (await world.inject({ method: "POST", url: `/api/public/acme/book/${link}/request`, payload: { start: at(10) } })).json();
    expect(requested.booking.status).toBe("pending");
    const booking = requested.booking.id as string;

    /* Ed is asked, with his own link in the notice. */
    const asked = await waitFor(async () => notices.find((one) => one.kind === "approval_request"));
    expect(asked.member).toMatchObject({ id: "ed", email: "ed@acme.test", name: "Ed" });
    expect(asked.subject).toContain("Approve Ana Ruiz: Visit");
    const token = /\/p\/acme\/approve\/([A-Za-z0-9_-]{43})/.exec(asked.text)![1]!;
    const page = `/api/public/acme/approve/${token}`;

    const opened = await world.inject({ method: "GET", url: page });
    expect(opened.json()).toMatchObject({ member: { name: "Ed", email: "ed@acme.test" }, booking: { status: "pending", contact: { name: "Ana Ruiz" } }, open: true, ask: { allowSuggest: true, maxSuggestions: 3 } });
    await world.inject({ method: "GET", url: `${page}?choice=approve` });
    expect((await team.inject({ method: "GET", url: `/api/scheduling/bookings/${booking}` })).json().status).toBe("pending");

    /* No longer on the team: refused. */
    await memberships.removeMember("acme", "ed");
    const gone = await world.inject({ method: "POST", url: page, payload: { answer: "approve" } });
    expect(gone.statusCode).toBe(409);
    expect(gone.json().error).toMatch(/no longer on this team/);
    await join_("ed", "editor");

    /* Expired: refused. */
    const [held] = await shared.tokens.list({ task: undefined, contact: ana.id }).then((all) => all.filter((one) => one.purpose === "approval"));
    await shared.tokens.put({ ...held!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await world.inject({ method: "POST", url: page, payload: { answer: "approve" } })).json().error).toMatch(/expired/);
    await shared.tokens.put(held!);

    /* Suggest from Ed's own open times. */
    const own = (await world.inject({ method: "POST", url: `${page}/times`, payload: {} })).json();
    expect(own.host).toMatchObject({ name: "Ed", self: true });
    const offer = (own.slots as Array<{ start: string }>).find((one) => one.start !== at(10))!;
    const answered = await world.inject({ method: "POST", url: page, payload: { answer: "suggest", times: [{ start: offer.start }], message: "Could you do this instead?", reason: "Van in for service" } });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({ open: false, closed: "You answered this request.", decided: { outcome: "suggested", by: "You", message: "Could you do this instead?" } });
    expect(JSON.stringify(answered.json())).not.toContain("Van in for service");

    /* Spent: a second press answers nothing. */
    const twice = await world.inject({ method: "POST", url: page, payload: { answer: "approve" } });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toMatch(/has been used/);

    /* The step finishes: every link it handed out stops answering, Ed hears it was recorded, and the page still shows what was decided. */
    await waitFor(async () => notices.find((one) => one.kind === "decision_recorded"));
    const after = (await world.inject({ method: "GET", url: page })).json();
    expect(after).toMatchObject({ open: false, decided: { outcome: "suggested", by: "You" }, booking: { status: "suggested" } });
    expect((await team.inject({ method: "POST", url: `/api/scheduling/bookings/${booking}/approval-link` })).statusCode).toBe(409);

    /* The person sees the offer, not the team's reason. */
    const theirs = (await world.inject({ method: "GET", url: `/api/public/acme/book/${link}` })).json();
    expect(theirs.booking).toMatchObject({ status: "suggested", message: "Could you do this instead?" });
    expect(theirs.booking.suggestions).toHaveLength(1);
    expect(JSON.stringify(theirs)).not.toContain("Van in for service");
  });

  it("refuses a link whose request was answered in Dash meanwhile", async () => {
    const { team, world, shared, notices, contact, linkFor, at } = await setup("moved", { approval: "always" });
    await shared.workflows.put(
      workflowOf({
        id: "approval",
        trial: 0,
        enabledBy: editorOf,
        trigger: { kind: "booking", events: ["requested"], types: [], endWhenCancelled: true },
        nodes: [node("approve", "ask.booking")],
        edges: [{ id: "e1", from: "trigger", outcome: "next", to: "approve" }],
      }),
    );
    const ben = await contact("Ben Ode", "ben@example.com");
    const { token: link } = await linkFor(ben.id);
    const booking = (await world.inject({ method: "POST", url: `/api/public/acme/book/${link}/request`, payload: { start: at(11) } })).json().booking.id as string;
    await waitFor(async () => notices.find((one) => one.kind === "approval_request"));

    /* "Copy approval link" hands Ed a link of his own while the request waits. */
    const copied = await team.inject({ method: "POST", url: `/api/scheduling/bookings/${booking}/approval-link` });
    expect(copied.statusCode).toBe(200);
    const token = /\/p\/acme\/approve\/([A-Za-z0-9_-]{43})/.exec(copied.json().url as string)![1]!;

    expect((await team.inject({ method: "POST", url: `/api/scheduling/bookings/${booking}/confirm` })).json().status).toBe("confirmed");
    const late = await world.inject({ method: "POST", url: `/api/public/acme/approve/${token}`, payload: { answer: "deny" } });
    expect(late.statusCode).toBe(409);
    expect((await team.inject({ method: "GET", url: `/api/scheduling/bookings/${booking}` })).json().status).toBe("confirmed");
  });
});

describe("a member's calendar feed", () => {
  it("serves their own entries and appointments as .ics, until they make a new link, stop it, or leave", async () => {
    const { team, world, memberships, join_, contact, at } = await setup("feed");
    const ana = await contact("Ana Ruiz", "ana@example.com");
    await team.inject({ method: "POST", url: "/api/scheduling/bookings", payload: { type: "visit", contact: ana.id, start: at(10) } });
    await team.inject({ method: "POST", url: "/api/calendar", payload: { title: "Team offsite", at: at(0).slice(0, 10), allDay: true } });

    expect((await team.inject({ method: "GET", url: "/api/calendar/feed" })).json()).toEqual({ feed: null });
    const made = (await team.inject({ method: "POST", url: "/api/calendar/feed" })).json() as { url: string; webcal: string; feed: { id: string } };
    expect(made.url).toMatch(/^https:\/\/dash\.example\.com\/api\/public\/acme\/calendar\/[A-Za-z0-9_-]{43}$/);
    expect(made.webcal.startsWith("webcal://dash.example.com/")).toBe(true);
    expect((await team.inject({ method: "GET", url: "/api/calendar/feed" })).json()).toMatchObject({ feed: { id: made.feed.id } });

    const path = new URL(made.url).pathname;
    const feed = await world.inject({ method: "GET", url: path });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers["content-type"]).toContain("text/calendar");
    expect(feed.headers["cache-control"]).toBe("no-store");
    expect(feed.body).toContain("SUMMARY:Visit");
    expect(feed.body).toContain(`DTSTART:${at(10).replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
    expect(feed.body).toMatch(/DTSTART;VALUE=DATE:\d{8}\r\nDTEND;VALUE=DATE:\d{8}\r\nSUMMARY:Team offsite/);

    /* A new link stops the old one. */
    const again = (await team.inject({ method: "POST", url: "/api/calendar/feed" })).json() as { url: string };
    expect((await world.inject({ method: "GET", url: path })).statusCode).toBe(404);
    const second = new URL(again.url).pathname;
    expect((await world.inject({ method: "GET", url: second })).statusCode).toBe(200);

    /* Leaving the team stops it too, and so does stopping it. */
    await memberships.removeMember("acme", "ed");
    expect((await world.inject({ method: "GET", url: second })).statusCode).toBe(404);
    await join_("ed", "editor");
    expect((await world.inject({ method: "GET", url: second })).statusCode).toBe(200);
    await team.inject({ method: "POST", url: "/api/calendar/feed/stop" });
    expect((await world.inject({ method: "GET", url: second })).statusCode).toBe(404);
  });
});

describe("in the hosted host", () => {
  it("routes a public request to its workspace with no principal, and a made-up workspace to nothing", async () => {
    const built: string[] = [];
    const identity: IdentityResolver = { resolve: () => null };
    const host = new WorkspaceHost({
      identity,
      exists: async (workspace) => workspace === "acme",
      build: (workspace) => {
        built.push(workspace);
        return buildServer({
          store: new SpecStore(join(dir, "hosted", workspace, "dashboards"), join(dir, "hosted", workspace, "connections"), join(dir, "hosted", workspace, "reports")),
          keys: new KeyStore(new LocalAesVault(Buffer.alloc(32, 9)), join(dir, "hosted", workspace, "vault.json")),
          identity,
          workspace: { id: workspace, key: workspace },
        });
      },
    });
    try {
      const reached = await host.inject({ method: "GET", url: "/api/public/acme/types/nothing-here" });
      expect(reached.statusCode).toBe(404);
      expect(reached.json()).toEqual({ error: "There is no booking page here." });
      expect((await host.inject({ method: "GET", url: "/api/public/made-up/types/visit" })).json()).toEqual({ error: "Not found." });
      expect((await host.inject({ method: "GET", url: "/api/scheduling/bookings" })).statusCode).toBe(401);
      expect(built).toEqual(["acme"]);
    } finally {
      await host.close();
    }
  });
});
