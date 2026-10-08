import {
  appointmentTypeSchema,
  blockSchema,
  placementSchema,
  poolSchema,
  resolveSettings,
  schedulingProfileSchema,
  type AppointmentType,
  type Block,
  type Placement,
  type SchedulingProfile,
} from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { assignHost } from "./assign.js";
import { expand, toRRule } from "./recurrence.js";
import { evaluateRules, normalizeAddress, type Facts } from "./rules.js";
import { findSlots, placementClash, type Busy, type HostInput } from "./slots.js";
import { instantOn, localDate, toInstant, wallTime } from "./zoned.js";

const CHICAGO = "America/Chicago";
const Z = (iso: string) => Date.parse(iso);
const at = "2026-10-01T00:00:00.000Z";

/* ── wall time ─────────────────────────────────────────────────────────── */

describe("wall time in a zone", () => {
  it("reads and writes ordinary times both ways", () => {
    expect(toInstant({ year: 2026, month: 10, day: 13, hour: 8, minute: 0 }, CHICAGO)).toBe(Z("2026-10-13T13:00:00Z"));
    expect(wallTime(Z("2026-10-13T13:00:00Z"), CHICAGO)).toMatchObject({ year: 2026, month: 10, day: 13, hour: 8, minute: 0 });
    expect(localDate(Z("2026-10-14T04:30:00Z"), CHICAGO)).toBe("2026-10-13");
  });

  it("moves a time in the spring-forward gap on by the jump, and takes the earlier of a time that happens twice", () => {
    /* 8 March 2026: 2:00 becomes 3:00 in Chicago. */
    expect(toInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, CHICAGO)).toBe(Z("2026-03-08T08:30:00Z"));
    expect(wallTime(Z("2026-03-08T08:30:00Z"), CHICAGO)).toMatchObject({ hour: 3, minute: 30 });
    expect(toInstant({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, CHICAGO)).toBe(Z("2026-03-08T07:30:00Z"));
    /* 1 November 2026: 1:30 happens twice; the first is still daylight time. */
    expect(toInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, CHICAGO)).toBe(Z("2026-11-01T06:30:00Z"));
    expect(instantOn("2026-10-13", "24:00", CHICAGO)).toBe(Z("2026-10-14T05:00:00Z"));
  });
});

/* ── recurrence ────────────────────────────────────────────────────────── */

const placement = (fields: Partial<Placement> & Pick<Placement, "start" | "end">): Placement =>
  placementSchema.parse({ id: "p1", block: "north", target: { kind: "member", id: "sam" }, timezone: CHICAGO, createdAt: at, updatedAt: at, ...fields });

describe("repeating placements", () => {
  it("keeps a weekly 8:00 at 8:00 on the clock either side of the change back", () => {
    const weekly = placement({ start: "2026-10-13T08:00", end: "2026-10-13T12:00", repeat: { every: "week", interval: 1 } });
    const found = expand(weekly, "2026-10-26", "2026-11-04");
    expect(found.map((one) => one.date)).toEqual(["2026-10-27", "2026-11-03"]);
    expect(found.map((one) => new Date(one.start).toISOString())).toEqual(["2026-10-27T13:00:00.000Z", "2026-11-03T14:00:00.000Z"]);
    expect(found.every((one) => wallTime(one.start, CHICAGO).hour === 8 && wallTime(one.end, CHICAGO).hour === 12)).toBe(true);
  });

  it("names weekdays and skips weeks for an interval", () => {
    const alternate = placement({ start: "2026-10-13T08:00", end: "2026-10-13T10:00", repeat: { every: "week", interval: 2, weekdays: [2, 4] } });
    expect(expand(alternate, "2026-10-12", "2026-11-08").map((one) => one.date)).toEqual(["2026-10-13", "2026-10-15", "2026-10-27", "2026-10-29"]);
  });

  it("skips months without the date, and finds the nth or last weekday", () => {
    const thirtyFirst = placement({ start: "2026-01-31T09:00", end: "2026-01-31T10:00", repeat: { every: "month", interval: 1 } });
    expect(expand(thirtyFirst, "2026-01-01", "2026-06-30").map((one) => one.date)).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    const secondTuesday = placement({ start: "2026-10-13T09:00", end: "2026-10-13T10:00", repeat: { every: "month", interval: 1, monthly: { by: "weekday", nth: 2 } } });
    expect(expand(secondTuesday, "2026-10-01", "2027-01-31").map((one) => one.date)).toEqual(["2026-10-13", "2026-11-10", "2026-12-08", "2027-01-12"]);
    const lastFriday = placement({ start: "2026-10-30T09:00", end: "2026-10-30T10:00", repeat: { every: "month", interval: 1, monthly: { by: "weekday", nth: -1 } } });
    expect(expand(lastFriday, "2026-10-01", "2026-12-31").map((one) => one.date)).toEqual(["2026-10-30", "2026-11-27", "2026-12-25"]);
    expect(toRRule(lastFriday)).toBe("FREQ=MONTHLY;BYDAY=-1FR");
  });

  it("counts skipped dates toward a count, and stops at until", () => {
    const daily = placement({ start: "2026-10-13T09:00", end: "2026-10-13T10:00", repeat: { every: "day", interval: 1, count: 3 }, except: ["2026-10-14"] });
    expect(expand(daily, "2026-10-01", "2026-10-31").map((one) => one.date)).toEqual(["2026-10-13", "2026-10-15"]);
    const until = placement({ start: "2026-10-13T09:00", end: "2026-10-13T10:00", repeat: { every: "day", interval: 2, until: "2026-10-19" } });
    expect(expand(until, "2026-10-01", "2026-10-31").map((one) => one.date)).toEqual(["2026-10-13", "2026-10-15", "2026-10-17", "2026-10-19"]);
  });

  it("finds occurrences years on without walking every one, and keeps an overnight placement's length", () => {
    const daily = placement({ start: "2026-10-13T09:00", end: "2026-10-13T10:00", repeat: { every: "day", interval: 3 } });
    expect(expand(daily, "2031-01-01", "2031-01-06").map((one) => one.date)).toEqual(["2031-01-02", "2031-01-05"]);
    const overnight = placement({ start: "2026-10-13T22:00", end: "2026-10-14T06:00" });
    const [night] = expand(overnight, "2026-10-14", "2026-10-14");
    expect(night).toMatchObject({ date: "2026-10-13" });
    expect(night!.end - night!.start).toBe(8 * 3_600_000);
  });
});

/* ── rules ─────────────────────────────────────────────────────────────── */

const facts = (contact: Record<string, unknown>, options: { trusted?: string[]; request?: Record<string, unknown> } = {}): Facts => ({
  scope: { contact, request: options.request ?? {}, type: { id: "inspect", name: "Inspection" } },
  trusted: new Set(options.trusted ?? []),
  kinds: new Map([
    ["contact.address", "address"],
    ["contact.phone", "phone"],
  ]),
});

describe("rules over facts", () => {
  const now = Z("2026-10-12T11:00:00Z");

  it("compares addresses written different ways, whole or by part", () => {
    expect(normalizeAddress("123 N. Main St., Apt #4")).toBe("123 north main street unit unit 4");
    const home = facts({ address: { line1: "123 N. Main St.", city: "Austin", postalCode: "78701" } });
    expect(evaluateRules({ all: [{ field: "contact.address", op: "in", values: ["123 north main street", "9 Oak Ave"] }], any: [] }, home, now).verdict).toBe("eligible");
    expect(evaluateRules({ all: [{ field: "contact.address", op: "in", values: ["123 Main Street, 78701"] }], any: [] }, facts({ address: { line1: "123 Main St", postalCode: "78701" } }), now).verdict).toBe("eligible");
    expect(evaluateRules({ all: [{ field: "contact.address.postalCode", op: "starts_with", values: ["787"] }], any: [] }, home, now).verdict).toBe("eligible");
    expect(evaluateRules({ all: [{ field: "contact.address.postalCode", op: "starts_with", values: ["750"] }], any: [] }, home, now).verdict).toBe("ineligible");
  });

  it("is unknown, naming the field, when a value is missing or only self-reported where trust is required", () => {
    const rules = { all: [{ field: "contact.customerType", op: "in" as const, values: ["new", "existing"], trusted: true }], any: [] };
    expect(evaluateRules(rules, facts({}), now)).toEqual({ verdict: "unknown", missing: ["contact.customerType"], untrusted: [] });
    expect(evaluateRules(rules, facts({ customerType: "Existing" }), now)).toEqual({ verdict: "unknown", missing: [], untrusted: ["contact.customerType"] });
    expect(evaluateRules(rules, facts({ customerType: "Existing" }, { trusted: ["contact.customerType"] }), now).verdict).toBe("eligible");
  });

  it("settles three ways: false in all beats unknown, true in any is enough", () => {
    const known = facts({ customerType: "cancelled" });
    expect(evaluateRules({ all: [{ field: "contact.customerType", op: "equals", values: ["new"] }, { field: "contact.region", op: "equals", values: ["x"] }], any: [] }, known, now).verdict).toBe("ineligible");
    expect(evaluateRules({ all: [], any: [{ field: "contact.region", op: "equals", values: ["x"] }, { field: "contact.customerType", op: "equals", values: ["cancelled"] }] }, known, now).verdict).toBe("eligible");
    expect(evaluateRules({ all: [{ field: "contact.region", op: "missing", values: [] }], any: [] }, known, now).verdict).toBe("eligible");
    expect(evaluateRules({ all: [{ field: "contact.stats.noShows", op: "lte", values: [1] }], any: [] }, facts({ stats: { noShows: 2 } }), now).verdict).toBe("ineligible");
    expect(evaluateRules({ all: [], any: [], expression: 'contact.customerType == "cancelled"' }, known, now).verdict).toBe("eligible");
  });
});

/* ── open times ────────────────────────────────────────────────────────── */

const NOW = Z("2026-10-12T11:00:00Z"); // Monday 6:00 in Chicago
const profile = (member: string, fields: Partial<SchedulingProfile> = {}): SchedulingProfile =>
  schedulingProfileSchema.parse({ member, displayName: member, bookable: true, timezone: CHICAGO, updatedAt: at, ...fields });
const type = (fields: Partial<AppointmentType> = {}): AppointmentType =>
  appointmentTypeSchema.parse({ id: "inspect", name: "Inspection", slug: "inspection", hosts: { members: ["sam"] }, settings: { length: "60m", slotStep: "30m", minNotice: "0m" }, createdAt: at, updatedAt: at, ...fields });
const block = (id: string, fields: Partial<Block> = {}): Block => blockSchema.parse({ id, name: id, createdAt: at, updatedAt: at, ...fields });
const north = block("north", { rules: { all: [{ field: "contact.address.postalCode", op: "starts_with", values: ["787"] }], any: [] } });
const south = block("south", { rules: { all: [{ field: "contact.address.postalCode", op: "starts_with", values: ["750"] }], any: [] } });
const blocksOf = (...list: Block[]) => new Map(list.map((one) => [one.id, one]));
const tuesdayMorning = (blockId = "north", extra: Partial<Placement> = {}) =>
  placement({ id: `p-${blockId}`, block: blockId, start: "2026-10-13T08:00", end: "2026-10-13T12:00", repeat: { every: "week", interval: 1 }, ...extra });
const host = (fields: Partial<HostInput> = {}): HostInput => ({ profile: profile("sam"), placements: [], busy: [], ...fields });
const tuesday = { from: Z("2026-10-13T05:00:00Z"), to: Z("2026-10-14T05:00:00Z") };
const clock = (ms: number) => {
  const wall = wallTime(ms, CHICAGO);
  return `${wall.hour}:${String(wall.minute).padStart(2, "0")}`;
};
const booking = (start: string, end: string, values: Record<string, string> = {}, extra: Partial<Busy> = {}): Busy => ({ start: Z(start), end: Z(end), kind: "booking", values, ...extra });
const austin = facts({ address: { line1: "1 Congress Ave", postalCode: "78701" } });
const dallas = facts({ address: { line1: "2 Elm St", postalCode: "75001" } });

describe("open times", () => {
  it("offers working hours at the step, an hour long, ending by close", () => {
    const result = findSlots({ now: NOW, ...tuesday, type: type(), hosts: [host()], blocks: blocksOf(), facts: austin });
    expect(result.slots.map((one) => clock(one.start))).toEqual(["9:00", "9:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00"]);
    expect(result.slots[0]).toMatchObject({ approval: false, consolidated: false, options: [{ host: "sam" }] });
  });

  it("lets only people a set block's rules match book in it", () => {
    const hosts = [host({ placements: [tuesdayMorning()] })];
    const forAustin = findSlots({ now: NOW, ...tuesday, type: type(), hosts, blocks: blocksOf(north), facts: austin });
    expect(forAustin.slots.map((one) => clock(one.start))).toContain("8:00");
    expect(forAustin.slots.find((one) => clock(one.start) === "8:00")!.options[0]!.block).toBe("north");
    const forDallas = findSlots({ now: NOW, ...tuesday, type: type(), hosts, blocks: blocksOf(north), facts: dallas });
    expect(forDallas.slots.map((one) => clock(one.start))[0]).toBe("12:00");
  });

  it("books only through blocks when hours outside them are closed, and never in a closed block", () => {
    const lunch = block("lunch", { kind: "closed" });
    const hosts = [host({ profile: profile("sam", { outsideBlocks: "closed" }), placements: [tuesdayMorning(), placement({ id: "p-lunch", block: "lunch", start: "2026-10-13T10:00", end: "2026-10-13T11:00" })] })];
    const result = findSlots({ now: NOW, ...tuesday, type: type(), hosts, blocks: blocksOf(north, lunch), facts: austin });
    expect(result.slots.map((one) => clock(one.start))).toEqual(["8:00", "8:30", "9:00", "11:00"]);
  });

  it("lets a one-off placement stand in for a repeating one that day", () => {
    const hosts = [host({ placements: [tuesdayMorning(), placement({ id: "p-once", block: "south", start: "2026-10-13T08:00", end: "2026-10-13T12:00" })] })];
    const result = findSlots({ now: NOW, ...tuesday, type: type(), hosts, blocks: blocksOf(north, south), facts: dallas });
    expect(result.slots.map((one) => clock(one.start))[0]).toBe("8:00");
    expect(result.slots[0]!.options[0]!.block).toBe("south");
  });

  it("keeps a buffer from appointments that do not match, and none from one that does, back to back", () => {
    const buffered = type({ settings: { length: "60m", slotStep: "30m", minNotice: "0m", consolidate: { by: ["contact.address.postalCode"], mode: "back_to_back", show: "only" } } });
    const hosts = [host({ busy: [booking("2026-10-13T15:00:00Z", "2026-10-13T16:00:00Z", { "contact.address.postalCode": "78701" }, { buffer: 30 * 60_000 })] })];
    const workspace = { buffer: "30m" };
    const same = findSlots({ now: NOW, ...tuesday, type: buffered, workspace, hosts, blocks: blocksOf(), facts: austin });
    expect(same.slots.map((one) => clock(one.start))).toEqual(["9:00", "11:00"]);
    expect(same).toMatchObject({ consolidatedOnly: true, more: true });
    const all = findSlots({ now: NOW, ...tuesday, type: buffered, workspace, hosts, blocks: blocksOf(), facts: austin, all: true });
    /* Every open time: back to back with the matching one, then the rest of the day. */
    expect(all.slots.map((one) => clock(one.start)).slice(0, 4)).toEqual(["9:00", "11:00", "11:30", "12:00"]);
    const other = findSlots({ now: NOW, ...tuesday, type: buffered, workspace, hosts, blocks: blocksOf(), facts: facts({ address: { postalCode: "78702" } }) });
    expect(other.slots.map((one) => clock(one.start))).not.toContain("9:00");
    expect(other.slots.map((one) => clock(one.start))).not.toContain("11:00");
    expect(other.slots.map((one) => clock(one.start))).toContain("11:30");
    expect(other.consolidatedOnly).toBe(false);
  });

  it("stacks at the same time when capacity allows, offering the matching time first", () => {
    const stacking = type({ settings: { length: "60m", slotStep: "30m", minNotice: "0m", capacity: 2, consolidate: { by: ["contact.address.postalCode"], mode: "stack", show: "only" } } });
    const hosts = [host({ busy: [booking("2026-10-13T15:00:00Z", "2026-10-13T16:00:00Z", { "contact.address.postalCode": "78701" })] })];
    expect(findSlots({ now: NOW, ...tuesday, type: stacking, hosts, blocks: blocksOf(), facts: austin }).slots.map((one) => clock(one.start))).toEqual(["10:00"]);
    /* Stacking only with the same value: somebody else cannot share 10:00. */
    const only = type({ settings: { length: "60m", slotStep: "30m", minNotice: "0m", capacity: 2, stackOnlySame: ["contact.address.postalCode"] } });
    expect(findSlots({ now: NOW, ...tuesday, type: only, hosts, blocks: blocksOf(), facts: dallas }).slots.map((one) => clock(one.start))).not.toContain("10:00");
    expect(findSlots({ now: NOW, ...tuesday, type: only, hosts, blocks: blocksOf(), facts: austin }).slots.map((one) => clock(one.start))).toContain("10:00");
  });

  it("turns a blank occurrence into the block its first booking belongs to", () => {
    const blank = block("open-wed", { kind: "blank", becomes: ["north", "south"] });
    const wednesday = placement({ id: "p-wed", block: "open-wed", start: "2026-10-14T08:00", end: "2026-10-14T12:00" });
    const range = { from: Z("2026-10-14T05:00:00Z"), to: Z("2026-10-15T05:00:00Z") };
    const blocks = blocksOf(blank, north, south);
    const closedOutside = profile("sam", { outsideBlocks: "closed" });
    const empty = [host({ profile: closedOutside, placements: [wednesday] })];
    expect(findSlots({ now: NOW, ...range, type: type(), hosts: empty, blocks, facts: austin }).slots[0]!.options[0]!.block).toBe("north");
    expect(findSlots({ now: NOW, ...range, type: type(), hosts: empty, blocks, facts: dallas }).slots[0]!.options[0]!.block).toBe("south");

    const set = [host({ profile: closedOutside, placements: [wednesday], busy: [booking("2026-10-14T13:00:00Z", "2026-10-14T14:00:00Z", {}, { placement: "p-wed", occurrence: "2026-10-14", block: "north" })] })];
    expect(findSlots({ now: NOW, ...range, type: type(), hosts: set, blocks, facts: dallas }).slots).toEqual([]);
    expect(findSlots({ now: NOW, ...range, type: type(), hosts: set, blocks, facts: austin }).slots.map((one) => clock(one.start))).toEqual(["9:00", "9:30", "10:00", "10:30", "11:00"]);
  });

  it("asks for what it does not know, and lets a block take the unknown pending approval", () => {
    const hosts = (b: Block) => [host({ profile: profile("sam", { outsideBlocks: "closed" }), placements: [tuesdayMorning(b.id)] })];
    const nobody = facts({});
    const excluded = findSlots({ now: NOW, ...tuesday, type: type(), hosts: hosts(north), blocks: blocksOf(north), facts: nobody });
    expect(excluded).toMatchObject({ slots: [], needs: ["contact.address.postalCode"] });
    const pending = block("north", { ...north, whenUnknown: "approval" });
    const asked = findSlots({ now: NOW, ...tuesday, type: type(), hosts: hosts(pending), blocks: blocksOf(pending), facts: nobody });
    expect(asked.slots.length).toBeGreaterThan(0);
    expect(asked.slots.every((one) => one.approval)).toBe(true);
    expect(asked.needs).toEqual(["contact.address.postalCode"]);
  });

  it("needs approval always, or when the rules say, and limits each day and each block occurrence", () => {
    const always = type({ settings: { length: "60m", slotStep: "30m", minNotice: "0m", approval: "always" } });
    expect(findSlots({ now: NOW, ...tuesday, type: always, hosts: [host()], blocks: blocksOf(), facts: austin }).slots.every((one) => one.approval)).toBe(true);
    const newOnes = type({ settings: { length: "60m", slotStep: "30m", minNotice: "0m", approval: "rules", approvalWhen: { all: [{ field: "contact.customerType", op: "equals", values: ["new"] }], any: [] } } });
    expect(findSlots({ now: NOW, ...tuesday, type: newOnes, hosts: [host()], blocks: blocksOf(), facts: facts({ customerType: "new" }) }).slots[0]!.approval).toBe(true);
    expect(findSlots({ now: NOW, ...tuesday, type: newOnes, hosts: [host()], blocks: blocksOf(), facts: facts({ customerType: "existing" }) }).slots[0]!.approval).toBe(false);

    const onePerDay = type({ settings: { length: "60m", slotStep: "30m", minNotice: "0m", maxPerDay: 1 } });
    const busyDay = [host({ busy: [booking("2026-10-13T20:00:00Z", "2026-10-13T21:00:00Z")] })];
    expect(findSlots({ now: NOW, ...tuesday, type: onePerDay, hosts: busyDay, blocks: blocksOf(), facts: austin }).slots).toEqual([]);

    const capped = block("north", { ...north, maxBookings: 1 });
    const filled = [host({ profile: profile("sam", { outsideBlocks: "closed" }), placements: [tuesdayMorning()], busy: [booking("2026-10-13T13:00:00Z", "2026-10-13T14:00:00Z", {}, { placement: "p-north", occurrence: "2026-10-13", block: "north" })] })];
    expect(findSlots({ now: NOW, ...tuesday, type: type(), hosts: filled, blocks: blocksOf(capped), facts: austin }).slots).toEqual([]);
  });

  it("keeps to notice, the horizon, the type's own hours and anything else on the calendar", () => {
    const noticed = type({ settings: { length: "60m", slotStep: "30m", minNotice: "28h" } });
    expect(clock(findSlots({ now: NOW, ...tuesday, type: noticed, hosts: [host()], blocks: blocksOf(), facts: austin }).slots[0]!.start)).toBe("10:00");
    const near = type({ settings: { length: "60m", slotStep: "30m", minNotice: "0m", horizon: "1d" } });
    expect(findSlots({ now: NOW, ...tuesday, type: near, hosts: [host()], blocks: blocksOf(), facts: austin }).slots).toEqual([]);
    const mornings = type({ hours: { mon: [], tue: [{ from: "08:00", to: "11:00" }], wed: [], thu: [], fri: [], sat: [], sun: [] } });
    expect(findSlots({ now: NOW, ...tuesday, type: mornings, hosts: [host()], blocks: blocksOf(), facts: austin }).slots.map((one) => clock(one.start))).toEqual(["9:00", "9:30", "10:00"]);
    const meeting: Busy = { start: Z("2026-10-13T14:00:00Z"), end: Z("2026-10-13T20:00:00Z"), kind: "entry" };
    expect(findSlots({ now: NOW, ...tuesday, type: type(), hosts: [host({ busy: [meeting] })], blocks: blocksOf(), facts: austin }).slots.map((one) => clock(one.start))).toEqual(["15:00", "15:30", "16:00"]);
  });

  it("offers a block's hours on the clock across the change back", () => {
    const hosts = [host({ profile: profile("sam", { outsideBlocks: "closed" }), placements: [tuesdayMorning()] })];
    const nov3 = { from: Z("2026-11-03T06:00:00Z"), to: Z("2026-11-04T06:00:00Z") };
    const result = findSlots({ now: NOW, ...nov3, type: type({ settings: { length: "60m", slotStep: "30m", minNotice: "0m", horizon: "60d" } }), hosts, blocks: blocksOf(north), facts: austin });
    expect(new Date(result.slots[0]!.start).toISOString()).toBe("2026-11-03T14:00:00.000Z");
    expect(clock(result.slots[0]!.start)).toBe("8:00");
  });

  it("joins hosts free at the same time into one slot", () => {
    const result = findSlots({ now: NOW, ...tuesday, type: type(), hosts: [host(), host({ profile: profile("ana") })], blocks: blocksOf(), facts: austin });
    expect(result.slots[0]!.options.map((one) => one.host)).toEqual(["sam", "ana"]);
  });
});

/* ── who takes it ──────────────────────────────────────────────────────── */

describe("assigning a host", () => {
  const settings = resolveSettings([]).settings;
  const slot = (hosts: string[], approvals: boolean[] = hosts.map(() => false)) => ({
    start: 0,
    end: 1,
    approval: approvals.every(Boolean),
    consolidated: false,
    options: hosts.map((host, index) => ({ host, approval: approvals[index]!, consolidated: false, settings })),
  });
  const pool = (assign: "round_robin" | "least_busy" | "priority" | "customer_picks", extra: Record<string, unknown> = {}) =>
    poolSchema.parse({
      id: "techs",
      name: "Techs",
      timezone: CHICAGO,
      assign,
      members: [
        { member: "ana", priority: 2 },
        { member: "ben", priority: 1 },
        { member: "cy", priority: 3 },
      ],
      createdAt: at,
      updatedAt: at,
      ...extra,
    });

  it("takes turns after the last one given, round the pool", () => {
    expect(assignHost(slot(["ana", "ben", "cy"]), { pool: pool("round_robin", { cursor: "ana" }) })!.host).toBe("ben");
    expect(assignHost(slot(["ana", "cy"]), { pool: pool("round_robin", { cursor: "cy" }) })!.host).toBe("ana");
  });

  it("picks the least busy, the best priority, the returning contact's host, or who the person picked", () => {
    expect(assignHost(slot(["ana", "ben"]), { pool: pool("least_busy"), load: new Map([["ana", 4], ["ben", 1]]) })!.host).toBe("ben");
    expect(assignHost(slot(["ana", "cy"]), { pool: pool("priority") })!.host).toBe("ana");
    expect(assignHost(slot(["ana", "ben"]), { pool: pool("priority"), preferred: "ana" })!.host).toBe("ana");
    expect(assignHost(slot(["ana", "ben"]), { pool: pool("customer_picks"), picked: "ben" })!.host).toBe("ben");
    expect(assignHost(slot(["ana"]), { picked: "ben" })).toBeNull();
  });

  it("keeps the terms the slot was offered on", () => {
    expect(assignHost(slot(["ana", "ben"], [true, false]), { pool: pool("priority") })!.host).toBe("ben");
  });
});

describe("placements that would clash", () => {
  const blocks = blocksOf(north, south, block("lunch", { kind: "closed" }));
  it("refuses two bookable repeating placements over the same time, but not an exception or a closed one", () => {
    const tuesdays = tuesdayMorning();
    const alsoTuesdays = placement({ id: "p2", block: "south", start: "2026-10-20T10:00", end: "2026-10-20T11:00", repeat: { every: "week", interval: 1 } });
    expect(placementClash(alsoTuesdays, [tuesdays], blocks, NOW)).toMatchObject({ with: { id: "p-north" }, date: "2026-10-20" });
    const once = placement({ id: "p3", block: "south", start: "2026-10-20T08:00", end: "2026-10-20T12:00" });
    expect(placementClash(once, [tuesdays], blocks, NOW)).toBeNull();
    const lunch = placement({ id: "p4", block: "lunch", start: "2026-10-13T10:00", end: "2026-10-13T11:00", repeat: { every: "day", interval: 1 } });
    expect(placementClash(lunch, [tuesdays], blocks, NOW)).toBeNull();
  });
});
