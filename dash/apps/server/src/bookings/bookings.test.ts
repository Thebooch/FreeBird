import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { Principal } from "@freebirdai/dash-spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbCalendarStore, MemoryCalendarStore } from "../calendar/store.js";
import { MemoryMembershipStore } from "../identity/members.js";
import { rolePolicy } from "../identity/policy.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { ContactService } from "../contacts/service.js";
import { DbContactStore, MemoryContactStore } from "../contacts/store.js";
import { openDashDb, type DashDb } from "../platform/db.js";
import { SchedulingService } from "../scheduling/service.js";
import { DbSchedulingStore, MemorySchedulingStore } from "../scheduling/store.js";
import { BookingService, bookingsAsBusy } from "./service.js";
import { DbBookingStore, MemoryBookingStore, type BookingStore } from "./store.js";

const CHICAGO = "America/Chicago";
const owner: Principal = { userId: "sam", workspaceId: "acme", role: "owner", kind: "member" };
const HOUR = 3_600_000;
/** Monday 12 October 2026, 6:00 in Chicago. */
const START = Date.parse("2026-10-12T11:00:00Z");
/** Tuesday 13 October, 9:00 / 10:00 / 11:00 in Chicago. */
const TUE_9 = Date.parse("2026-10-13T14:00:00Z");
const TUE_10 = TUE_9 + HOUR;
const TUE_11 = TUE_9 + 2 * HOUR;
const member = { kind: "member" as const, id: "sam" };
const them = { kind: "contact" as const };

/** Memory stores, or every store on one database: as the local build runs, one connection for all. */
const build = async (store: BookingStore = new MemoryBookingStore(), db?: DashDb) => {
  let now = START;
  let n = 0;
  const clock = { now: () => now, set: (at: number) => (now = at) };
  const calendar = db ? new DbCalendarStore(db, "acme") : new MemoryCalendarStore();
  const contacts = new ContactService({ store: db ? new DbContactStore(db, "acme") : new MemoryContactStore(), now: clock.now, newId: () => `c${++n}` });
  const scheduling = new SchedulingService({
    store: db ? new DbSchedulingStore(db, "acme") : new MemorySchedulingStore(),
    calendar,
    members: async () => [
      { userId: "sam", email: "sam@acme.test", role: "owner" },
      { userId: "ana", email: "ana@acme.test", role: "editor" },
    ],
    bookings: bookingsAsBusy(store),
    factKinds: () => contacts.factKinds(),
    contacts,
    now: clock.now,
  });
  const bookings = new BookingService({ store, scheduling, contacts, calendar, now: clock.now, newId: () => `b${++n}` });
  await contacts.putField("serviceArea", { label: "Service area", askable: true });
  await scheduling.putProfile("sam", { displayName: "Sam", bookable: true, timezone: CHICAGO });
  await scheduling.putType("visit", { name: "Visit", slug: "visit", hosts: { members: ["sam"] }, settings: { length: "60m", slotStep: "60m", minNotice: "0m" } });
  const person = async (email: string, area?: string) => {
    const one = await contacts.findOrCreate({ email, name: email.split("@")[0]!, origin: "public_link" });
    if (area) await contacts.record(one.id, "serviceArea", area, "person");
    return one.id;
  };
  return { clock, calendar, contacts, scheduling, bookings, store, person };
};

describe("asking for a time", () => {
  it("confirms a booking that needs no approval, and holds one that does until its hold runs out", async () => {
    const { bookings, scheduling, store, person } = await build();
    const ana = await person("ana@example.com");
    const confirmed = await bookings.request({ type: "visit", contact: ana, start: TUE_9, origin: "public_link", by: them });
    expect(confirmed.outcome).toBe("confirmed");
    expect(confirmed.booking).toMatchObject({ status: "confirmed", host: "sam", start: new Date(TUE_9).toISOString(), end: new Date(TUE_10).toISOString(), timezone: CHICAGO });

    await scheduling.putType("visit", { settings: { length: "60m", slotStep: "60m", minNotice: "0m", approval: "always", holdFor: "1d" } });
    const pending = await bookings.request({ type: "visit", contact: ana, start: TUE_10, origin: "public_link", by: them });
    expect(pending.outcome).toBe("pending");
    expect(pending.booking.holdUntil).toBe(new Date(START + 24 * HOUR).toISOString());

    /* A member booking for someone skips approval unless asked; a step can ask for it, or skip it. */
    const forThem = await bookings.request({ type: "visit", contact: ana, start: TUE_11, origin: "member", by: member });
    expect(forThem.outcome).toBe("confirmed");

    expect((await store.undelivered(10)).map((one) => one.kind)).toEqual(["confirmed", "requested", "confirmed"]);
  });

  it("refuses a request that needs approval when nobody is set to approve it, but not one the team makes", async () => {
    const built = await build();
    let asked = false;
    let n = 0;
    const bookings = new BookingService({ store: built.store, scheduling: built.scheduling, contacts: built.contacts, calendar: built.calendar, now: built.clock.now, newId: () => `x${++n}`, approvalAsked: async () => asked });
    await built.scheduling.putType("visit", { settings: { length: "60m", slotStep: "60m", minNotice: "0m", approval: "always" } });
    const ana = await built.person("ana@example.com");
    await expect(bookings.request({ type: "visit", contact: ana, start: TUE_9, origin: "public_link", by: them })).rejects.toThrow(/nobody is set to approve/);
    expect((await bookings.request({ type: "visit", contact: ana, start: TUE_9, origin: "member", by: member })).outcome).toBe("confirmed");
    asked = true;
    expect((await bookings.request({ type: "visit", contact: ana, start: TUE_10, origin: "public_link", by: them })).outcome).toBe("pending");
  });

  it("refuses a time already taken, offering what is open nearby, and finds the first booking again by its id", async () => {
    const { bookings, person } = await build();
    const ana = await person("ana@example.com");
    const ben = await person("ben@example.com");
    const first = await bookings.request({ type: "visit", contact: ana, start: TUE_9, origin: "agent", by: them, id: "bk-step-1" });
    const again = await bookings.request({ type: "visit", contact: ana, start: TUE_9, origin: "agent", by: them, id: "bk-step-1" });
    expect(again.booking.id).toBe(first.booking.id);

    const taken = await bookings.request({ type: "visit", contact: ben, start: TUE_9, origin: "public_link", by: them }).catch((error: unknown) => error);
    expect(taken).toMatchObject({ status: 409, message: "That time isn't open." });
    expect((taken as { slots: Array<{ start: number }> }).slots.map((one) => one.start)).toContain(TUE_10);
  });

  it("gives the last place to exactly one of several asking at once", async () => {
    const { bookings, person } = await build();
    const people = await Promise.all(["a", "b", "c", "d", "e"].map((name) => person(`${name}@example.com`)));
    const results = await Promise.allSettled(people.map((contact) => bookings.request({ type: "visit", contact, start: TUE_9, origin: "public_link", by: them })));
    expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((one) => one.status === "rejected").map((one) => (one as PromiseRejectedResult).reason.status)).toEqual([409, 409, 409, 409]);
  });

  it("lets only one of two first bookings set a blank block, when they would make it different blocks", async () => {
    const { bookings, scheduling, person } = await build();
    await scheduling.putProfile("sam", { outsideBlocks: "closed" });
    await scheduling.putBlock("north", { name: "North", rules: { all: [{ field: "contact.serviceArea", op: "in", values: ["north"] }] } });
    await scheduling.putBlock("south", { name: "South", rules: { all: [{ field: "contact.serviceArea", op: "in", values: ["south"] }] } });
    await scheduling.putBlock("open", { name: "Open", kind: "blank", becomes: ["north", "south"] });
    await scheduling.putPlacement(owner, "tue", { block: "open", target: { kind: "member", id: "sam" }, timezone: CHICAGO, start: "2026-10-13T08:00", end: "2026-10-13T12:00" });
    const ana = await person("ana@example.com", "north");
    const ben = await person("ben@example.com", "south");

    const results = await Promise.allSettled([
      bookings.request({ type: "visit", contact: ana, start: TUE_9, origin: "public_link", by: them }),
      bookings.request({ type: "visit", contact: ben, start: TUE_10, origin: "public_link", by: them }),
    ]);
    const won = results.filter((one) => one.status === "fulfilled") as Array<PromiseFulfilledResult<{ booking: { block?: string } }>>;
    expect(won).toHaveLength(1);
    expect(["north", "south"]).toContain(won[0]!.value.booking.block);
    expect(results.filter((one) => one.status === "rejected")).toHaveLength(1);
  });
});

describe("what happens to a booking", () => {
  const pendingOne = async () => {
    const built = await build();
    await built.scheduling.putType("visit", { settings: { length: "60m", slotStep: "60m", minNotice: "0m", approval: "always", holdFor: "1d", suggestionHoldFor: "2d" } });
    const ana = await built.person("ana@example.com");
    const { booking } = await built.bookings.request({ type: "visit", contact: ana, start: TUE_9, origin: "public_link", by: them });
    return { ...built, ana, booking };
  };

  it("approves, and an approved move changes the time", async () => {
    const { bookings, booking, clock } = await pendingOne();
    const approved = await bookings.confirm(booking.id, member, { message: "See you then" });
    expect(approved).toMatchObject({ status: "confirmed", decision: { outcome: "approved", by: "sam", message: "See you then" } });
    expect(approved.holdUntil).toBeUndefined();
    expect((await bookings.confirm(booking.id, member)).revision).toBe(approved.revision);

    /* The person asks to move: approval needed, so the booking keeps its time and the new one is held. */
    const asked = await bookings.move(booking.id, them, { start: TUE_11 });
    expect(asked).toMatchObject({ status: "confirmed", start: new Date(TUE_9).toISOString(), change: { start: new Date(TUE_11).toISOString() } });
    const moved = await bookings.confirm(booking.id, member);
    expect(moved).toMatchObject({ start: new Date(TUE_11).toISOString(), reschedules: 1 });
    expect(moved.change).toBeUndefined();

    /* Too close to the time, the person can't move or cancel it online. */
    clock.set(TUE_11 - 2 * HOUR);
    await expect(bookings.cancel(booking.id, them)).rejects.toThrow(/too close/);
    expect((await bookings.cancel(booking.id, member, { reason: "Ill" })).status).toBe("cancelled");
  });

  it("offers other times that are held, and the person takes one with no second approval", async () => {
    const { bookings, booking, store, calendar } = await pendingOne();
    const offered = await bookings.suggest(booking.id, member, [{ start: TUE_10 }, { start: TUE_11 }], { message: "Mornings are full", reason: "Van in the shop" });
    expect(offered.status).toBe("suggested");
    expect(offered.suggestions?.map((one) => one.start)).toEqual([new Date(TUE_10).toISOString(), new Date(TUE_11).toISOString()]);
    expect(offered.decision).toMatchObject({ outcome: "suggested", reason: "Van in the shop", message: "Mornings are full" });

    /* The original time is free again; the offered ones are held. */
    expect((await store.holding("sam", TUE_9, TUE_10)).length).toBe(0);
    expect((await store.holding("sam", TUE_10, TUE_11)).length).toBe(1);
    const entries = await calendar.list({ booking: booking.id });
    expect(entries.map((one) => [one.title.split(":")[0], one.status])).toEqual([
      ["Visit · ana", "cancelled"],
      ["Offered", "tentative"],
      ["Offered", "tentative"],
    ]);

    const taken = await bookings.acceptSuggestion(booking.id, "s2", them);
    expect(taken).toMatchObject({ status: "confirmed", start: new Date(TUE_11).toISOString() });
    expect((await calendar.list({ booking: booking.id })).map((one) => one.status)).toEqual(["open"]);
    expect((await store.undelivered(20)).map((one) => one.kind)).toEqual(["requested", "suggested", "suggestion_accepted", "confirmed"]);
  });

  it("turns down a request, and a person declining every time offered cancels it", async () => {
    const { bookings, booking, person } = await pendingOne();
    const denied = await bookings.deny(booking.id, member, { reason: "Outside our area", message: "Sorry, we can't come out that far." });
    expect(denied).toMatchObject({ status: "denied", decision: { outcome: "denied", reason: "Outside our area" } });
    await expect(bookings.confirm(booking.id, member)).rejects.toThrow(/denied now/);

    const ben = await person("ben@example.com");
    const second = await bookings.request({ type: "visit", contact: ben, start: TUE_9, origin: "public_link", by: them });
    await bookings.suggest(second.booking.id, member, [{ start: TUE_10 }]);
    expect((await bookings.declineSuggestions(second.booking.id, them)).status).toBe("cancelled");
  });

  it("refuses to offer a time that isn't open, unless a member offers it anyway", async () => {
    const { bookings, booking } = await pendingOne();
    const saturday = Date.parse("2026-10-17T15:00:00Z");
    await expect(bookings.suggest(booking.id, member, [{ start: saturday }])).rejects.toThrow(/isn't open/);
    expect((await bookings.suggest(booking.id, member, [{ start: saturday }], { allowOutside: true })).suggestions).toHaveLength(1);
  });

  it("lets holds run out, drops stale offers, and completes what has ended", async () => {
    const { bookings, booking, clock, person } = await pendingOne();
    clock.set(START + 25 * HOUR);
    expect(await bookings.settleDue()).toBe(1);
    expect((await bookings.get(booking.id)).status).toBe("expired");

    const ben = await person("ben@example.com");
    const asked = await bookings.request({ type: "visit", contact: ben, start: TUE_9 + 24 * HOUR, origin: "public_link", by: them });
    const approved = await bookings.confirm(asked.booking.id, member);
    clock.set(Date.parse(approved.end) + 1);
    await bookings.settleDue();
    expect((await bookings.get(asked.booking.id)).status).toBe("completed");
    expect((await bookings.mark(asked.booking.id, member, "no_show")).status).toBe("no_show");
  });
});

describe("bookings in the database", () => {
  let db: DashDb;
  beforeAll(async () => {
    db = await openDashDb({ databaseUrl: undefined, inMemory: true });
  });
  afterAll(async () => {
    await db.close();
  });

  it("holds the last place for one, keeps held time beside each booking, and delivers each event once", async () => {
    const store = new DbBookingStore(db, "acme");
    const { bookings, person } = await build(store, db);
    const people = await Promise.all(["a", "b", "c"].map((name) => person(`${name}@example.com`)));
    const results = await Promise.allSettled(people.map((contact) => bookings.request({ type: "visit", contact, start: TUE_9, origin: "public_link", by: them })));
    expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(1);
    const won = (results.find((one) => one.status === "fulfilled") as PromiseFulfilledResult<{ booking: { id: string } }>).value.booking;

    expect((await store.holding("sam", TUE_9, TUE_10)).map((one) => one.id)).toEqual([won.id]);
    expect(await store.list({ contact: (await bookings.get(won.id)).contact })).toHaveLength(1);
    const events = await store.undelivered(10);
    expect(events.map((one) => one.kind)).toEqual(["confirmed"]);
    await store.markDelivered(events[0]!.id);
    expect(await store.undelivered(10)).toEqual([]);

    await bookings.cancel(won.id, member);
    expect(await store.holding("sam", TUE_9, TUE_10)).toEqual([]);
    expect(await new DbBookingStore(db, "other").get(won.id)).toBeNull();
  });
});

describe("booking routes", () => {
  it("lets anyone read bookings, and only calendar.manage book for a contact and decide", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-bookings-"));
    try {
      const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
      const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
      const memberships = new MemoryMembershipStore();
      const add = (userId: string, role: Principal["role"]) => memberships.putMember({ workspaceId: "acme", userId, email: `${userId}@acme.test`, role, grants: [], joinedAt: "2026-10-06T00:00:00.000Z" });
      await add("ed", "editor");
      await add("vi", "viewer");
      const shared = { store, keys, scheduling: new MemorySchedulingStore(), contacts: new MemoryContactStore(), bookings: new MemoryBookingStore(), calendar: new MemoryCalendarStore(), members: async () => (await memberships.members("acme")).map((one) => ({ userId: one.userId, email: one.email, role: one.role })), policy: rolePolicy(memberships) };
      const as = (userId: string, role: Principal["role"]) => ({ resolve: () => ({ userId, workspaceId: "acme", role, kind: "member" as const }) });
      const editor = buildServer({ ...shared, identity: as("ed", "editor") });
      const viewer = buildServer({ ...shared, identity: as("vi", "viewer") });

      /* A weekday two or more days out, mid-morning in Chicago. */
      let day = Date.now() + 2 * 86_400_000;
      while ([0, 6].includes(new Date(day).getUTCDay())) day += 86_400_000;
      const at = new Date(new Date(day).toISOString().slice(0, 10) + "T16:00:00.000Z").toISOString();

      await editor.inject({ method: "PUT", url: "/api/scheduling/profiles/ed", payload: { displayName: "Ed", timezone: CHICAGO, bookable: true } });
      await editor.inject({ method: "PUT", url: "/api/scheduling/types/visit", payload: { name: "Visit", slug: "visit", hosts: { members: ["ed"] }, settings: { length: "60m", slotStep: "60m", minNotice: "0m" } } });
      const contact = (await editor.inject({ method: "POST", url: "/api/contacts", payload: { name: "Ana", emails: ["ana@example.com"] } })).json();

      const refused = await viewer.inject({ method: "POST", url: "/api/scheduling/bookings", payload: { type: "visit", contact: contact.id, start: at } });
      expect(refused.statusCode).toBe(403);
      const made = await editor.inject({ method: "POST", url: "/api/scheduling/bookings", payload: { type: "visit", contact: contact.id, start: at } });
      expect(made.statusCode).toBe(200);
      const booking = made.json().booking;
      expect(booking).toMatchObject({ status: "confirmed", host: "ed", origin: "member" });

      const twice = await editor.inject({ method: "POST", url: "/api/scheduling/bookings", payload: { type: "visit", contact: contact.id, start: at } });
      expect(twice.statusCode).toBe(409);
      expect(Array.isArray(twice.json().detail.slots)).toBe(true);

      expect((await viewer.inject({ method: "GET", url: `/api/scheduling/bookings?contact=${contact.id}` })).json().map((one: { id: string }) => one.id)).toEqual([booking.id]);
      expect((await viewer.inject({ method: "POST", url: `/api/scheduling/bookings/${booking.id}/cancel` })).statusCode).toBe(403);
      expect((await editor.inject({ method: "POST", url: `/api/scheduling/bookings/${booking.id}/mark`, payload: { as: "no_show" } })).json().status).toBe("no_show");
      expect((await editor.inject({ method: "POST", url: `/api/scheduling/bookings/${booking.id}/cancel` })).statusCode).toBe(409);
      expect((await viewer.inject({ method: "GET", url: `/api/scheduling/slots?type=visit&contact=${contact.id}` })).statusCode).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
