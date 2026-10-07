import { describe, expect, it } from "vitest";
import { addDays, addMonths, monthGrid, recentDays, sameDayIn } from "./calendar.js";

describe("timeline calendar", () => {
  it("lists the last seven days ending today, across a month border", () => {
    expect(recentDays("2026-10-03")).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
  });

  it("moves by days and months across years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(sameDayIn("2026-01-31", { year: 2026, month: 1 })).toBe("2026-02-28");
  });

  it("lays a month out in whole Sunday-first weeks", () => {
    // October 2026 starts on a Thursday and has 31 days.
    const weeks = monthGrid({ year: 2026, month: 9 });
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0]!.slice(0, 5)).toEqual([null, null, null, null, "2026-10-01"]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
  });
});
