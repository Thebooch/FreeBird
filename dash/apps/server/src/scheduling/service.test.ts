import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { Principal } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { MemoryCalendarStore } from "../calendar/store.js";
import { MemoryMembershipStore } from "../identity/members.js";
import { rolePolicy } from "../identity/policy.js";
import { openDashDb } from "../platform/db.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { SchedulingError, SchedulingService } from "./service.js";
import { DbSchedulingStore, MemorySchedulingStore } from "./store.js";
import { wallTime } from "./zoned.js";

const NOW = Date.parse("2026-10-12T11:00:00Z");
const CHICAGO = "America/Chicago";
const owner: Principal = { userId: "sam", workspaceId: "acme", role: "owner", kind: "member" };

const build = () => {
  const calendar = new MemoryCalendarStore();
  const scheduling = new SchedulingService({
    store: new MemorySchedulingStore(),
    calendar,
    members: async () => [
      { userId: "sam", email: "sam@acme.test", role: "owner" },
      { userId: "ana", email: "ana@acme.test", role: "editor" },
    ],
    now: () => NOW,
  });
  return { calendar, scheduling };
};

const settled = async (scheduling: SchedulingService) => {
  await scheduling.putProfile("sam", { displayName: "Sam", bookable: true, timezone: CHICAGO });
  await scheduling.putProfile("ana", { displayName: "Ana", bookable: true, timezone: CHICAGO });
  await scheduling.putBlock("north", { name: "North", rules: { all: [{ field: "contact.address.postalCode", op: "starts_with", values: ["787"] }] } });
  await scheduling.putBlock("south", { name: "South", rules: { all: [{ field: "contact.address.postalCode", op: "starts_with", values: ["750"] }] } });
  await scheduling.putType("inspect", { name: "Inspection", slug: "inspection", hosts: { members: ["sam"] }, settings: { length: "60m", slotStep: "30m", minNotice: "0m" } });
};

describe("scheduling setup", () => {
  it("takes workspace members as hosts, filling in their email, and team members who give one", async () => {
    const { scheduling } = build();
    expect(await scheduling.putProfile("sam", { displayName: "Sam", timezone: CHICAGO })).toMatchObject({ member: "sam", email: "sam@acme.test", bookable: false, revision: 1, outsideBlocks: "open" });
    expect((await scheduling.putProfile("sam", { bookable: true })).revision).toBe(2);
    await expect(scheduling.putProfile("team-joe", { displayName: "Joe", timezone: CHICAGO })).rejects.toThrow(/needs an email/);
    expect(await scheduling.putProfile("team-joe", { displayName: "Joe", email: "joe@acme.test", timezone: CHICAGO })).toMatchObject({ member: "team-joe" });
    await expect(scheduling.putProfile("stranger", { displayName: "X", timezone: CHICAGO })).rejects.toMatchObject({ status: 404 });
    await expect(scheduling.putProfile("sam", { timezone: "Mars/Olympus" })).rejects.toThrow(/time zone/);
  });

  it("checks what a type, a pool and a blank block point at", async () => {
    const { scheduling } = build();
    await settled(scheduling);
    await expect(scheduling.putType("other", { name: "Other", slug: "inspection", hosts: { members: ["sam"] } })).rejects.toMatchObject({ status: 409 });
    await expect(scheduling.putType("other", { name: "Other", slug: "other", hosts: { members: ["ghost"] } })).rejects.toMatchObject({ status: 404 });
    await expect(scheduling.putType("other", { name: "Other", slug: "other", hosts: { pool: "nope" } })).rejects.toMatchObject({ status: 404 });
    await expect(scheduling.putPool("techs", { name: "Techs", timezone: CHICAGO, members: [{ member: "ghost" }] })).rejects.toMatchObject({ status: 404 });
    expect(await scheduling.putPool("techs", { name: "Techs", timezone: CHICAGO, members: [{ member: "sam" }, { member: "ana" }] })).toMatchObject({ assign: "round_robin" });

    await expect(scheduling.putBlock("open", { name: "Open", kind: "blank", becomes: ["nope"] })).rejects.toMatchObject({ status: 404 });
    await scheduling.putBlock("lunch", { name: "Lunch", kind: "closed" });
    await expect(scheduling.putBlock("open", { name: "Open", kind: "blank", becomes: ["lunch"] })).rejects.toThrow(/set blocks/);
    await expect(scheduling.putBlock("open", { name: "Open", kind: "blank" })).rejects.toThrow(/may become/);
    await scheduling.putBlock("open", { name: "Open", kind: "blank", becomes: ["north", "south"] });
    await expect(scheduling.putBlock("north", { kind: "closed" })).rejects.toMatchObject({ status: 409 });
    await expect(scheduling.removeBlock("north")).rejects.toMatchObject({ status: 409 });
    expect((await scheduling.putBlock("north", { name: "North side" })).version).toBe(2);
  });

  it("refuses a placement that overlaps another bookable one on the same host, its pools' included", async () => {
    const { scheduling } = build();
    await settled(scheduling);
    await scheduling.putPool("techs", { name: "Techs", timezone: CHICAGO, members: [{ member: "sam" }] });
    await scheduling.putPlacement(owner, "tue", { block: "north", target: { kind: "member", id: "sam" }, timezone: CHICAGO, start: "2026-10-13T08:00", end: "2026-10-13T12:00", repeat: { every: "week" } });
    await expect(
      scheduling.putPlacement(owner, "pool-tue", { block: "south", target: { kind: "pool", id: "techs" }, timezone: CHICAGO, start: "2026-10-20T11:00", end: "2026-10-20T13:00", repeat: { every: "week" } }),
    ).rejects.toThrow(/overlaps "North" on 2026-10-20/);
    /* A one-off is how a day is made different. */
    expect(await scheduling.putPlacement(owner, "once", { block: "south", target: { kind: "member", id: "sam" }, timezone: CHICAGO, start: "2026-10-20T08:00", end: "2026-10-20T12:00" })).toMatchObject({ createdBy: "sam" });
    await expect(scheduling.removeProfile("sam")).rejects.toMatchObject({ status: 409 });
  });

  it("skips one occurrence, or splits a series into this-and-later", async () => {
    const { scheduling } = build();
    await settled(scheduling);
    await scheduling.putPlacement(owner, "tue", { block: "north", target: { kind: "member", id: "sam" }, timezone: CHICAGO, start: "2026-10-13T08:00", end: "2026-10-13T12:00", repeat: { every: "week" } });
    expect((await scheduling.skipOccurrence("tue", "2026-10-20")).except).toEqual(["2026-10-20"]);
    const { before, after } = await scheduling.splitAt("tue", "2026-11-03", "tue-later");
    expect(before.repeat).toMatchObject({ until: "2026-11-02" });
    expect(after).toMatchObject({ id: "tue-later", start: "2026-11-03T08:00", end: "2026-11-03T12:00", except: [] });
    await expect(scheduling.splitAt("tue", "2026-10-01", "x")).rejects.toBeInstanceOf(SchedulingError);
  });

  it("lists each host's block occurrences, pools' included", async () => {
    const { scheduling } = build();
    await settled(scheduling);
    await scheduling.putPool("techs", { name: "Techs", timezone: CHICAGO, members: [{ member: "sam" }, { member: "ana" }] });
    await scheduling.putPlacement(owner, "wed", { block: "south", target: { kind: "pool", id: "techs" }, timezone: CHICAGO, start: "2026-10-14T08:00", end: "2026-10-14T12:00" });
    const found = await scheduling.occurrences(Date.parse("2026-10-12T05:00:00Z"), Date.parse("2026-10-19T05:00:00Z"));
    expect(found.map((one) => [one.host, one.block, one.date, one.kind])).toEqual([
      ["ana", "south", "2026-10-14", "set"],
      ["sam", "south", "2026-10-14", "set"],
    ]);
  });

  it("previews what a person would be offered, keeping clear of the host's own calendar", async () => {
    const { scheduling, calendar } = build();
    await settled(scheduling);
    await calendar.put({ id: "mtg", title: "Team planning", at: "2026-10-13T14:00:00.000Z", end: "2026-10-13T20:00:00.000Z", allDay: false, kind: "event", status: "open", owner: { kind: "member", id: "sam" }, pinned: false, createdAt: "x" });
    const preview = await scheduling.preview("inspect", { from: "2026-10-13T05:00:00Z", to: "2026-10-14T05:00:00Z", contact: { address: { postalCode: "78701" } } });
    expect(preview.slots.map((one) => wallTime(one.start, CHICAGO).hour)).toEqual([15, 15, 16]);
    await expect(scheduling.preview("nope", {})).rejects.toMatchObject({ status: 404 });
  });

  it("keeps everything in the database too", async () => {
    const db = await openDashDb({ inMemory: true });
    try {
      const store = new DbSchedulingStore(db, "acme");
      const scheduling = new SchedulingService({ store, calendar: new MemoryCalendarStore(), members: async () => [{ userId: "sam", email: "sam@acme.test", role: "owner" }], now: () => NOW });
      await scheduling.putProfile("sam", { displayName: "Sam", bookable: true, timezone: CHICAGO });
      await scheduling.setDefaults({ buffer: "15m" });
      const overview = await scheduling.overview();
      expect(overview.defaults).toEqual({ buffer: "15m" });
      expect(overview.profiles.map((one) => one.member)).toEqual(["sam"]);
      expect(await new DbSchedulingStore(db, "other").list("profile")).toEqual([]);
      await store.delete("profile", "sam");
      expect(await store.get("profile", "sam")).toBeNull();
    } finally {
      await db.close();
    }
  });
});

describe("scheduling routes", () => {
  it("lets anyone read, and only those with calendar.manage change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-scheduling-"));
    try {
      const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
      const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
      const memberships = new MemoryMembershipStore();
      const member = (userId: string, role: Principal["role"]) => ({ workspaceId: "acme", userId, email: `${userId}@acme.test`, role, grants: [], joinedAt: "2026-10-06T00:00:00.000Z" });
      await memberships.putMember(member("ed", "editor"));
      await memberships.putMember(member("vi", "viewer"));
      const scheduling = new MemorySchedulingStore();
      const members = async () => (await memberships.members("acme")).map((one) => ({ userId: one.userId, email: one.email, role: one.role }));
      const as = (userId: string, role: Principal["role"]) => ({ resolve: () => ({ userId, workspaceId: "acme", role, kind: "member" as const }) });

      const viewer = buildServer({ store, keys, scheduling, members, policy: rolePolicy(memberships), identity: as("vi", "viewer") });
      const refused = await viewer.inject({ method: "PUT", url: "/api/scheduling/profiles/vi", payload: { displayName: "Vi", timezone: CHICAGO } });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().permission).toBe("calendar.manage");

      const editor = buildServer({ store, keys, scheduling, members, policy: rolePolicy(memberships), identity: as("ed", "editor") });
      expect((await editor.inject({ method: "PUT", url: "/api/scheduling/profiles/ed", payload: { displayName: "Ed", timezone: CHICAGO, bookable: true } })).statusCode).toBe(200);
      const bad = await editor.inject({ method: "PUT", url: "/api/scheduling/blocks/b1", payload: { name: "Open", kind: "blank" } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/may become/);
      const overview = (await viewer.inject({ method: "GET", url: "/api/scheduling" })).json();
      expect(overview.profiles.map((one: { member: string }) => one.member)).toEqual(["ed"]);
      expect(overview.members.map((one: { userId: string }) => one.userId).sort()).toEqual(["ed", "vi"]);
      expect((await viewer.inject({ method: "GET", url: "/api/scheduling/occurrences?from=2026-10-12T00:00:00Z&to=2026-10-19T00:00:00Z" })).json()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
