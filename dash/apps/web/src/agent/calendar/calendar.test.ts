import { calendarEventSchema, type CalendarEvent } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { blankForm, formOf, inputOf } from "./form.js";
import {
  DEFAULT_FILTER,
  addDays,
  addMonths,
  byDay,
  dayKey,
  entryDayKeys,
  keepEntry,
  legendOf,
  memberColor,
  ownerOf,
  periodLabel,
  startOfWeek,
  stepAnchor,
  viewDays,
  viewRange,
} from "./model.js";
import { layDay } from "./WeekView.jsx";

/* Local dates throughout, so these hold in any zone the tests run in. */
const at = (year: number, month: number, day: number, hours = 0, minutes = 0): number => new Date(year, month - 1, day, hours, minutes).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();
const entry = (id: string, over: Partial<CalendarEvent> = {}): CalendarEvent =>
  calendarEventSchema.parse({ id, title: id, at: iso(at(2026, 10, 14, 9)), createdAt: "2026-10-01T00:00:00Z", ...over });

describe("calendar arithmetic", () => {
  it("lays a month out as six Monday-first weeks", () => {
    const days = viewDays("month", at(2026, 10, 14));
    expect(days).toHaveLength(42);
    expect(dayKey(days[0]!)).toBe("2026-09-28");
    expect(new Date(days[0]!).getDay()).toBe(1);
    expect(dayKey(days[41]!)).toBe("2026-11-08");
  });

  it("steps by calendar days and months, keeping the day inside short months", () => {
    expect(dayKey(addDays(at(2026, 10, 31), 1))).toBe("2026-11-01");
    expect(dayKey(addMonths(at(2026, 1, 31), 1))).toBe("2026-02-28");
    expect(dayKey(stepAnchor("week", at(2026, 10, 14), 1))).toBe("2026-10-21");
    expect(dayKey(stepAnchor("agenda", at(2026, 10, 14), -1))).toBe("2026-09-14");
    expect(dayKey(startOfWeek(at(2026, 10, 18)))).toBe("2026-10-12");
  });

  it("reads exactly the days a view shows", () => {
    const range = viewRange("week", at(2026, 10, 14, 15));
    expect(range.from).toBe(iso(at(2026, 10, 12)));
    expect(range.to).toBe(iso(at(2026, 10, 19)));
  });

  it("names the period", () => {
    expect(periodLabel("month", at(2026, 10, 14), "en-GB")).toBe("October 2026");
    /* ICU sets the dash between thin spaces; any space will do. */
    const plain = (text: string) => text.replace(/\s/g, " ");
    expect(plain(periodLabel("week", at(2026, 10, 14), "en-US"))).toBe("Oct 12 – 18, 2026");
    expect(plain(periodLabel("week", at(2026, 9, 30), "en-US"))).toBe("Sep 28 – Oct 4, 2026");
    expect(plain(periodLabel("agenda", at(2026, 12, 20), "en-US"))).toBe("Dec 20, 2026 – Jan 18, 2027");
  });

  it("places entries on every local day they cover, and not the next one at midnight", () => {
    expect(entryDayKeys(entry("one", { at: "2026-10-14", end: "2026-10-16", allDay: true }))).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(entryDayKeys(entry("night", { at: iso(at(2026, 10, 14, 22)), end: iso(at(2026, 10, 15, 2)) }))).toEqual(["2026-10-14", "2026-10-15"]);
    expect(entryDayKeys(entry("midnight", { at: iso(at(2026, 10, 14, 22)), end: iso(at(2026, 10, 15, 0)) }))).toEqual(["2026-10-14"]);
  });

  it("groups by day with whole-day entries first, then by time", () => {
    const grouped = byDay(
      [entry("late", { at: iso(at(2026, 10, 14, 15)) }), entry("whole", { at: "2026-10-14", allDay: true }), entry("early", { at: iso(at(2026, 10, 14, 8)) })],
      [at(2026, 10, 14), at(2026, 10, 15)],
    );
    expect(grouped.get("2026-10-14")!.map((one) => one.id)).toEqual(["whole", "early", "late"]);
    expect(grouped.get("2026-10-15")).toEqual([]);
  });
});

describe("owners and filters", () => {
  const agents = new Map([["maint", { name: "Maintenance", color: 3 }]]);

  it("names and colours an entry's owner", () => {
    expect(ownerOf(entry("a", { owner: { kind: "agent", id: "maint" } }), agents, new Map(), "sam")).toMatchObject({ key: "agent:maint", name: "Maintenance", color: 3 });
    expect(ownerOf(entry("b", { owner: { kind: "member", id: "sam" } }), agents, new Map(), "sam")).toMatchObject({ name: "You", color: memberColor("sam") });
    expect(ownerOf(entry("c", { owner: { kind: "member", id: "ana" } }), agents, new Map([["ana", { name: "Ana", color: 6 }]]))).toMatchObject({ name: "Ana", color: 6 });
    expect(ownerOf(entry("d"), agents, new Map())).toMatchObject({ key: "none", color: 0 });
    expect(memberColor("sam")).toBe(memberColor("sam"));
  });

  it("hides cancelled entries by default, and anything whose owner or kind is switched off", () => {
    const cancelled = entry("x", { status: "cancelled" });
    expect(keepEntry(cancelled, DEFAULT_FILTER)).toBe(false);
    expect(keepEntry(cancelled, { ...DEFAULT_FILTER, showCancelled: true })).toBe(true);
    const agents = entry("y", { owner: { kind: "agent", id: "maint" } });
    expect(keepEntry(agents, { ...DEFAULT_FILTER, hidden: new Set(["agent:maint"]) })).toBe(false);
    expect(keepEntry(entry("z", { kind: "deadline" }), { ...DEFAULT_FILTER, kinds: new Set(["event"]) })).toBe(false);
  });

  it("lists who has entries, agents first, with counts", () => {
    const owners = (one: CalendarEvent) => ownerOf(one, agents, new Map([["ana", { name: "Ana", color: 6 }]]));
    const legend = legendOf(
      [entry("1", { owner: { kind: "member", id: "ana" } }), entry("2", { owner: { kind: "agent", id: "maint" } }), entry("3", { owner: { kind: "agent", id: "maint" } })],
      owners,
    );
    expect(legend.map((one) => [one.name, one.count])).toEqual([
      ["Maintenance", 2],
      ["Ana", 1],
    ]);
  });
});

describe("the entry form", () => {
  it("starts a new entry an hour long, or at nine on a whole day", () => {
    expect(blankForm(at(2026, 10, 14, 14, 30), "member:sam")).toMatchObject({ date: "2026-10-14", start: "14:30", end: "15:30", owner: "member:sam" });
    expect(blankForm(at(2026, 10, 14), "member:sam", true)).toMatchObject({ start: "09:00", end: "10:00" });
  });

  it("sends local times as instants, a whole day as a date, and a deadline with no end", () => {
    const form = { ...blankForm(at(2026, 10, 14, 9), "agent:maint"), title: " Walkthrough " };
    expect(inputOf(form)).toEqual({
      ok: true,
      input: { title: "Walkthrough", kind: "event", owner: { kind: "agent", id: "maint" }, notes: "", at: iso(at(2026, 10, 14, 9)), end: iso(at(2026, 10, 14, 10)), allDay: false },
    });
    expect(inputOf({ ...form, allDay: true, endDate: "2026-10-16" })).toMatchObject({ ok: true, input: { at: "2026-10-14", end: "2026-10-16", allDay: true } });
    expect(inputOf({ ...form, allDay: true, endDate: "2026-10-14" })).toMatchObject({ ok: true, input: { end: "" } });
    expect(inputOf({ ...form, kind: "deadline" })).toMatchObject({ ok: true, input: { at: iso(at(2026, 10, 14, 9)), end: "" } });
  });

  it("says what is wrong instead of sending it", () => {
    const form = { ...blankForm(at(2026, 10, 14, 9), "member:sam"), title: "x" };
    expect(inputOf({ ...form, title: "  " })).toEqual({ ok: false, error: "Give the entry a title." });
    expect(inputOf({ ...form, end: "08:00" })).toMatchObject({ ok: false, error: expect.stringMatching(/ends before it starts/) });
    expect(inputOf({ ...form, allDay: true, endDate: "2026-10-01" })).toMatchObject({ ok: false, error: expect.stringMatching(/before the first/) });
  });

  it("reads an entry back into the form", () => {
    const timed = formOf(entry("t", { at: iso(at(2026, 10, 14, 9)), end: iso(at(2026, 10, 14, 10, 30)), notes: "Gate code 1234" }), "member:sam");
    expect(timed).toMatchObject({ date: "2026-10-14", start: "09:00", end: "10:30", allDay: false, owner: "member:sam", notes: "Gate code 1234" });
    expect(formOf(entry("d", { at: "2026-10-14", end: "2026-10-16", allDay: true, kind: "deadline" }), "member:sam")).toMatchObject({ allDay: true, endDate: "2026-10-16", kind: "deadline" });
  });
});

describe("the week grid", () => {
  it("puts overlapping entries side by side and leaves the rest full width", () => {
    const day = at(2026, 10, 14);
    const placed = layDay(
      [
        entry("a", { at: iso(at(2026, 10, 14, 9)), end: iso(at(2026, 10, 14, 10)) }),
        entry("b", { at: iso(at(2026, 10, 14, 9, 30)), end: iso(at(2026, 10, 14, 11)) }),
        entry("c", { at: iso(at(2026, 10, 14, 13)), end: iso(at(2026, 10, 14, 14)) }),
      ],
      day,
    );
    const by = Object.fromEntries(placed.map((one) => [one.entry.id, one]));
    expect(by["a"]).toMatchObject({ lane: 0, lanes: 2, top: 9 * 48, height: 48 });
    expect(by["b"]).toMatchObject({ lane: 1, lanes: 2 });
    expect(by["c"]).toMatchObject({ lane: 0, lanes: 1, top: 13 * 48 });
  });

  it("clips an entry to the day and gives a moment enough height to click", () => {
    const day = at(2026, 10, 15);
    const [overnight] = layDay([entry("n", { at: iso(at(2026, 10, 14, 22)), end: iso(at(2026, 10, 15, 2)) })], day);
    expect(overnight).toMatchObject({ top: 0, height: 2 * 48 });
    const [moment] = layDay([entry("m", { at: iso(at(2026, 10, 15, 8)) })], day);
    expect(moment!.height).toBeGreaterThanOrEqual(24 * (48 / 60));
  });
});
