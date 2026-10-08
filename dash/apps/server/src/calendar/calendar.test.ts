import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import { calendarEventSchema, calendarOverlaps, type CalendarEvent, type Principal } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMembershipStore } from "../identity/members.js";
import { rolePolicy } from "../identity/policy.js";
import { openDashDb } from "../platform/db.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { CalendarError, CalendarService, listOptionsOf } from "./service.js";
import { DbCalendarStore, MemoryCalendarStore, type CalendarStore } from "./store.js";

const entry = (id: string, over: Partial<CalendarEvent> = {}): CalendarEvent =>
  calendarEventSchema.parse({ id, title: id, at: "2026-10-14T15:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", ...over });

const principal = (userId: string, role: Principal["role"] = "owner"): Principal => ({ userId, workspaceId: "acme", role, kind: "member" });

describe("calendar entries", () => {
  it("reads an entry stored before kinds and statuses existed", () => {
    const old = calendarEventSchema.parse({ id: "a", title: "Inspect", at: "2026-10-09", deadline: true, createdAt: "2026-10-01T00:00:00Z" });
    expect(old.kind).toBe("deadline");
    expect(old.status).toBe("open");
    expect("deadline" in old).toBe(false);
    expect(calendarEventSchema.parse({ id: "b", title: "Visit", at: "2026-10-09", createdAt: "x" }).kind).toBe("event");
  });

  it("says whether an entry falls in a range, padding all-day entries for the reader's zone", () => {
    const timed = { at: "2026-10-14T15:00:00.000Z", allDay: false };
    expect(calendarOverlaps(timed, "2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z")).toBe(true);
    expect(calendarOverlaps(timed, "2026-10-14T15:00:00.000Z", "2026-10-14T16:00:00.000Z")).toBe(true);
    expect(calendarOverlaps(timed, "2026-10-14T16:00:00.000Z", "2026-10-15T00:00:00.000Z")).toBe(false);
    /* Something running across the range's start is in it. */
    const spanning = { at: "2026-10-13T22:00:00.000Z", end: "2026-10-14T02:00:00.000Z", allDay: false };
    expect(calendarOverlaps(spanning, "2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z")).toBe(true);
    /* A day's entry is kept a day either side: Chicago's 13 October ends at 05:00 UTC on the 14th. */
    const day = { at: "2026-10-14", allDay: true };
    expect(calendarOverlaps(day, "2026-10-13T05:00:00.000Z", "2026-10-14T05:00:00.000Z")).toBe(true);
    expect(calendarOverlaps(day, "2026-10-16T05:00:00.000Z", "2026-10-17T05:00:00.000Z")).toBe(false);
  });

  it("reads list filters from a query string, dropping what it does not know", () => {
    expect(listOptionsOf({ from: "2026-10-01", to: "nope", owner: "agent:a, member:b", kind: "deadline,bogus", status: "open" })).toEqual({
      from: "2026-10-01",
      owners: ["agent:a", "member:b"],
      kinds: ["deadline"],
      statuses: ["open"],
    });
  });
});

const storeCases: Array<[string, () => Promise<{ store: CalendarStore; close: () => Promise<void> }>]> = [
  ["memory", async () => ({ store: new MemoryCalendarStore(), close: async () => undefined })],
  [
    "database",
    async () => {
      const db = await openDashDb({ inMemory: true });
      return { store: new DbCalendarStore(db, "acme"), close: () => db.close() };
    },
  ],
];

describe.each(storeCases)("the %s calendar store", (_name, open) => {
  it("lists what overlaps a range, in time order, with owner, kind and status filters", async () => {
    const { store, close } = await open();
    try {
      await store.put(entry("late", { at: "2026-10-14T18:00:00.000Z", owner: { kind: "agent", id: "maint" } }));
      await store.put(entry("early", { at: "2026-10-14T09:00:00.000Z", kind: "deadline", owner: { kind: "member", id: "sam" } }));
      await store.put(entry("day", { at: "2026-10-14", allDay: true, status: "done" }));
      await store.put(entry("other-week", { at: "2026-10-21T09:00:00.000Z" }));
      await store.put(entry("long", { at: "2026-10-12T09:00:00.000Z", end: "2026-10-15T09:00:00.000Z" }));

      const day = { from: "2026-10-14T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" };
      expect((await store.list(day)).map((one) => one.id)).toEqual(["long", "day", "early", "late"]);
      expect((await store.list({ ...day, owners: ["agent:maint"] })).map((one) => one.id)).toEqual(["late"]);
      expect((await store.list({ ...day, kinds: ["deadline"] })).map((one) => one.id)).toEqual(["early"]);
      expect((await store.list({ ...day, statuses: ["done"] })).map((one) => one.id)).toEqual(["day"]);
      expect(await store.get("early")).toMatchObject({ id: "early", kind: "deadline" });
      await store.delete("early");
      expect(await store.get("early")).toBeNull();
    } finally {
      await close();
    }
  });

  it("moves a workflow's entry in place by its key, keeping its id, and leaves a pinned one alone", async () => {
    const { store, close } = await open();
    try {
      const first = await store.upsertByKey({ ...entry("cal-1", { dedupeKey: "wf:42:cal", workflow: "wf", rowKey: "42" }), dedupeKey: "wf:42:cal" });
      expect(first.id).toBe("cal-1");
      const moved = await store.upsertByKey({
        ...entry("cal-2", { at: "2026-10-20T15:00:00.000Z", dedupeKey: "wf:42:cal", workflow: "wf", rowKey: "42", createdAt: "2026-10-05T00:00:00.000Z" }),
        dedupeKey: "wf:42:cal",
      });
      expect(moved).toMatchObject({ id: "cal-1", at: "2026-10-20T15:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z" });
      expect((await store.list({ workflow: "wf" })).map((one) => one.id)).toEqual(["cal-1"]);
      expect((await store.list({ workflow: "wf", rowKey: "43" })).length).toBe(0);

      await store.put({ ...moved, pinned: true, at: "2026-10-22T15:00:00.000Z" });
      const again = await store.upsertByKey({ ...entry("cal-3", { at: "2026-10-30T15:00:00.000Z", dedupeKey: "wf:42:cal" }), dedupeKey: "wf:42:cal" });
      expect(again).toMatchObject({ id: "cal-1", at: "2026-10-22T15:00:00.000Z", pinned: true });
    } finally {
      await close();
    }
  });
});

describe("CalendarService", () => {
  const service = () => {
    let n = 0;
    const store = new MemoryCalendarStore();
    return { store, calendar: new CalendarService({ store, now: () => Date.parse("2026-10-08T12:00:00.000Z"), newId: () => `n${++n}` }) };
  };

  it("adds an entry as the person's own unless it names an owner", async () => {
    const { calendar } = service();
    const mine = await calendar.create(principal("sam"), { title: "Walkthrough", at: "2026-10-14T15:00:00.000Z", end: "2026-10-14T16:00:00.000Z" });
    expect(mine).toMatchObject({ id: "cal-n1", owner: { kind: "member", id: "sam" }, createdBy: "sam", kind: "event", status: "open", allDay: false });
    const agents = await calendar.create(principal("sam"), { title: "Renewals due", at: "2026-10-31", kind: "deadline", owner: { kind: "agent", id: "maint" } });
    expect(agents).toMatchObject({ owner: { kind: "agent", id: "maint" }, allDay: true, kind: "deadline" });
  });

  it("refuses an entry that ends before it starts, or has no time it can read", async () => {
    const { calendar } = service();
    await expect(calendar.create(principal("sam"), { title: "Backwards", at: "2026-10-14T15:00:00Z", end: "2026-10-14T14:00:00Z" })).rejects.toThrow(/end before it starts/);
    await expect(calendar.create(principal("sam"), { title: "When?", at: "next tuesday" })).rejects.toThrow(/not a date/);
    await expect(calendar.create(principal("sam"), { title: "", at: "2026-10-14" })).rejects.toBeInstanceOf(CalendarError);
  });

  it("pins a workflow's entry when a person changes it, and cancels rather than removes it", async () => {
    const { store, calendar } = service();
    await store.put(entry("wf-entry", { workflow: "wf", owner: { kind: "agent", id: "maint" } }));
    const moved = await calendar.update(principal("sam"), "wf-entry", { at: "2026-10-15T15:00:00.000Z", notes: "Tenant asked for Thursday" });
    expect(moved).toMatchObject({ pinned: true, at: "2026-10-15T15:00:00.000Z", notes: "Tenant asked for Thursday", title: "wf-entry" });
    await expect(calendar.remove(principal("sam"), "wf-entry")).rejects.toThrow(/Cancel it instead/);
    expect((await calendar.setStatus(principal("sam"), "wf-entry", "cancelled")).status).toBe("cancelled");
    /* Sending an empty end clears it. */
    await calendar.update(principal("sam"), "wf-entry", { end: "2026-10-15T16:00:00.000Z" });
    expect((await calendar.update(principal("sam"), "wf-entry", { end: "" })).end).toBeUndefined();
  });

  it("sends appointment changes to their booking", async () => {
    const { store, calendar } = service();
    await store.put(entry("appt", { kind: "appointment", booking: "b1" }));
    await expect(calendar.update(principal("sam"), "appt", { title: "x" })).rejects.toThrow(/booking/);
    await expect(calendar.setStatus(principal("sam"), "appt", "done")).rejects.toThrow(/booking/);
    await expect(calendar.remove(principal("sam"), "appt")).rejects.toThrow(/booking/);
  });
});

describe("calendar routes", () => {
  let dir: string;
  let store: SpecStore;
  let keys: KeyStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-calendar-"));
    store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lets anyone read, and only those with calendar.manage change", async () => {
    const memberships = new MemoryMembershipStore();
    const member = (userId: string, role: Principal["role"]) => ({ workspaceId: "acme", userId, email: `${userId}@acme.test`, role, grants: [], joinedAt: "2026-10-06T00:00:00.000Z" });
    await memberships.putMember(member("ed", "editor"));
    await memberships.putMember(member("vi", "viewer"));
    const calendar = new MemoryCalendarStore();
    const as = (userId: string, role: Principal["role"]) => ({ resolve: () => principal(userId, role) });

    const viewer = buildServer({ store, keys, calendar, policy: rolePolicy(memberships), identity: as("vi", "viewer") });
    const refused = await viewer.inject({ method: "POST", url: "/api/calendar", payload: { title: "x", at: "2026-10-14" } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().permission).toBe("calendar.manage");

    const editor = buildServer({ store, keys, calendar, policy: rolePolicy(memberships), identity: as("ed", "editor") });
    const made = await editor.inject({ method: "POST", url: "/api/calendar", payload: { title: "Walkthrough", at: "2026-10-14T15:00:00.000Z" } });
    expect(made.statusCode).toBe(200);
    const id = made.json().id as string;
    expect(made.json().owner).toEqual({ kind: "member", id: "ed" });

    const listed = await viewer.inject({ method: "GET", url: "/api/calendar?from=2026-10-14T00:00:00.000Z&to=2026-10-15T00:00:00.000Z&owner=member:ed" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((one: CalendarEvent) => one.id)).toEqual([id]);

    expect((await editor.inject({ method: "POST", url: `/api/calendar/${id}/status`, payload: { status: "done" } })).json().status).toBe("done");
    expect((await editor.inject({ method: "POST", url: `/api/calendar/${id}/status`, payload: { status: "gone" } })).statusCode).toBe(400);
    expect((await editor.inject({ method: "GET", url: "/api/calendar/nope" })).statusCode).toBe(404);
    expect((await editor.inject({ method: "DELETE", url: `/api/calendar/${id}` })).json()).toEqual({ removed: true, id });
  });
});
