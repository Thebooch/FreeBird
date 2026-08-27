import { describe, expect, it } from "vitest";
import {
  bucketBy,
  byRecency,
  dayKey,
  daysCovered,
  funnelStages,
  groupByDay,
  instantOf,
  monthGrid,
} from "./collectionModel.js";

const at = (iso: string): number => Date.parse(iso);

describe("bucketBy", () => {
  /*
   * Alphabetical would put "Approved" before "Applied", which is backwards for
   * every workflow anybody has. The pipeline already decided the order.
   */
  it("keeps first-seen order rather than sorting", () => {
    const rows = [{ s: "Applied" }, { s: "Approved" }, { s: "Applied" }];
    expect(bucketBy(rows, "s").map((bucket) => bucket.key)).toEqual(["Applied", "Approved"]);
  });

  it("gives empty values a bucket of their own rather than dropping them", () => {
    const buckets = bucketBy([{ s: null }, { s: "" }, { s: "Open" }], "s");
    expect(buckets.map((bucket) => bucket.key)).toEqual(["—", "Open"]);
    expect(buckets[0]?.rows).toHaveLength(2);
  });
});

describe("instantOf", () => {
  it("reads ISO strings and Date objects", () => {
    expect(instantOf("2026-08-19T10:00:00Z")).toBe(at("2026-08-19T10:00:00Z"));
    expect(instantOf(new Date(1700))).toBe(1700);
  });

  /*
   * Seconds and milliseconds are both common in APIs and a thousand-fold error
   * is not subtle — it puts 2026 in 1970.
   */
  it("promotes a seconds timestamp to milliseconds", () => {
    expect(instantOf(1_780_000_000)).toBe(1_780_000_000_000);
    expect(instantOf(1_780_000_000_000)).toBe(1_780_000_000_000);
  });

  /*
   * `Date.parse("2026-08-19")` is UTC midnight, so anyone west of UTC would
   * see the event fall on the 18th. A bare date is a calendar date, and the
   * day the API wrote is the day it has to land on.
   */
  it("reads a bare date as that calendar day, not as UTC midnight", () => {
    const at = instantOf("2026-08-19");
    expect(at).not.toBeNull();
    const local = new Date(at!);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(7);
    expect(local.getDate()).toBe(19);
    expect(dayKey(at!)).toBe("2026-08-19");
  });

  it("leaves a string that carries a time alone", () => {
    expect(instantOf("2026-08-19T10:00:00Z")).toBe(Date.parse("2026-08-19T10:00:00Z"));
  });

  it("is null for anything it cannot read, never the epoch", () => {
    expect(instantOf("not a date")).toBeNull();
    expect(instantOf(null)).toBeNull();
    expect(instantOf({})).toBeNull();
    expect(instantOf(new Date("nonsense"))).toBeNull();
  });
});

describe("byRecency", () => {
  const rows = [
    { t: "2026-01-01T00:00:00Z", n: "old" },
    { t: "2026-03-01T00:00:00Z", n: "new" },
    { t: "not a date", n: "broken" },
  ];

  it("sorts newest first", () => {
    expect(byRecency(rows, "t").dated.map((entry) => entry.row.n)).toEqual(["new", "old"]);
  });

  /*
   * They happened. A feed that silently omits them is under-reporting without
   * saying so, which is the failure this product exists to avoid.
   */
  it("hands back the undated rows rather than dropping them", () => {
    expect(byRecency(rows, "t").undated.map((row) => row.n)).toEqual(["broken"]);
  });

  it("does not reorder the caller's array", () => {
    const original = [...rows];
    byRecency(rows, "t");
    expect(rows).toEqual(original);
  });
});

describe("groupByDay", () => {
  it("puts one day's entries under one heading, in order", () => {
    const { dated } = byRecency(
      [
        { t: "2026-08-19T22:00:00" },
        { t: "2026-08-19T09:00:00" },
        { t: "2026-08-18T09:00:00" },
      ],
      "t",
    );
    const days = groupByDay(dated);
    expect(days).toHaveLength(2);
    expect(days[0]?.rows).toHaveLength(2);
    expect(days[1]?.rows).toHaveLength(1);
  });

  it("labels each group with that day's midnight", () => {
    const { dated } = byRecency([{ t: "2026-08-19T22:00:00" }], "t");
    const [day] = groupByDay(dated);
    const midnight = new Date(day!.at);
    expect([midnight.getHours(), midnight.getMinutes()]).toEqual([0, 0]);
    expect(day?.key).toBe(dayKey(midnight.getTime()));
  });
});

describe("funnelStages", () => {
  const rows = [
    { s: "Visited", n: 1000 },
    { s: "Signed up", n: 400 },
    { s: "Paid", n: 100 },
  ];

  /*
   * The bar is a share of the intake; the percentage is a share of the step
   * before. Showing one and labelling it the other is the usual way a funnel
   * misleads, so both are computed and each is named.
   */
  it("measures the bar against the first stage and the rate against the previous", () => {
    const stages = funnelStages(rows, "s", "n");
    expect(stages.map((stage) => stage.ofFirst)).toEqual([1, 0.4, 0.1]);
    expect(stages.map((stage) => stage.ofPrevious)).toEqual([null, 0.4, 0.25]);
    expect(stages.map((stage) => stage.dropped)).toEqual([null, 600, 300]);
  });

  /*
   * A stage larger than the one before happens in real data — a record
   * entering late — and hiding it would make the chart lie to protect its own
   * shape.
   */
  it("reports a stage that grew rather than clamping it", () => {
    const stages = funnelStages([{ s: "a", n: 10 }, { s: "b", n: 25 }], "s", "n");
    expect(stages[1]?.ofPrevious).toBe(2.5);
    expect(stages[1]?.dropped).toBe(-15);
  });

  it("survives a first stage of zero without dividing by it", () => {
    const stages = funnelStages([{ s: "a", n: 0 }, { s: "b", n: 0 }], "s", "n");
    expect(stages.every((stage) => Number.isFinite(stage.ofFirst))).toBe(true);
  });
});

describe("monthGrid", () => {
  const august = Date.parse("2026-08-19T12:00:00");

  it("is always six weeks, so the grid never changes height", () => {
    expect(monthGrid(august, august)).toHaveLength(42);
    expect(monthGrid(Date.parse("2026-02-10T12:00:00"), august)).toHaveLength(42);
  });

  it("starts on a Monday and marks the neighbouring months", () => {
    const days = monthGrid(august, august);
    expect(new Date(days[0]!.at).getDay()).toBe(1);
    // The 1st of August 2026 is a Saturday, so the grid opens in July.
    expect(days[0]?.inMonth).toBe(false);
    expect(days.filter((day) => day.inMonth)).toHaveLength(31);
  });

  it("marks today only on today", () => {
    const days = monthGrid(august, august);
    expect(days.filter((day) => day.isToday)).toHaveLength(1);
  });
});

describe("daysCovered", () => {
  it("is one day when there is no end", () => {
    expect(daysCovered({ s: "2026-08-19T09:00:00" }, "s", undefined)).toEqual(["2026-08-19"]);
  });

  /*
   * A five-day booking should be visible on all five days, not only on the one
   * it began.
   */
  it("covers every day a span touches", () => {
    const keys = daysCovered({ s: "2026-08-19T09:00:00", e: "2026-08-22T09:00:00" }, "s", "e");
    expect(keys).toEqual(["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22"]);
  });

  it("ignores an end that precedes the start", () => {
    expect(daysCovered({ s: "2026-08-19", e: "2026-08-01" }, "s", "e")).toEqual(["2026-08-19"]);
  });

  it("caps a runaway span so one bad row cannot fill the month", () => {
    const keys = daysCovered({ s: "2026-01-01", e: "2030-01-01" }, "s", "e");
    expect(keys).toHaveLength(42);
  });

  it("is empty when the start cannot be read", () => {
    expect(daysCovered({ s: "nonsense" }, "s", undefined)).toEqual([]);
  });
});
