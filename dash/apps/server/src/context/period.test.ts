import { describe, expect, it } from "vitest";
import { describeTurn, periodParams } from "./period.js";

describe("the period a question names", () => {
  it("reads whole days in the reader's own calendar", () => {
    const september = periodParams("2026-09-01", "2026-09-30", "America/Chicago");
    expect(september?.range).toMatchObject({ start: Date.parse("2026-09-01T05:00:00Z"), end: Date.parse("2026-10-01T05:00:00Z") - 1, preset: "custom" });
    expect(periodParams("2026-03-01", "2026-03-01", "UTC")?.range).toMatchObject({ start: Date.parse("2026-03-01T00:00:00Z"), end: Date.parse("2026-03-02T00:00:00Z") - 1 });
  });

  it("is no period when the days are missing, malformed, backwards or absurd", () => {
    expect(periodParams(undefined, "2026-09-30", "UTC")).toBeNull();
    expect(periodParams("Sept 1", "2026-09-30", "UTC")).toBeNull();
    expect(periodParams("2026-09-30", "2026-09-01", "UTC")).toBeNull();
    expect(periodParams("1900-01-01", "2026-09-01", "UTC")).toBeNull();
  });
});

describe("the turn's note", () => {
  it("says today in the reader's zone and the window the tab shows", () => {
    const note = describeTurn({
      now: Date.parse("2026-10-11T15:00:00Z"),
      zone: "America/Chicago",
      window: { start: Date.parse("2026-10-04T05:00:00Z"), end: Date.parse("2026-10-11T15:00:00Z") },
    });
    expect(note).toContain("TODAY — Sunday, 11 October 2026 (2026-10-11, America/Chicago).");
    expect(note).toContain("THE OPEN TAB SHOWS — 4 Oct 2026 to 11 Oct 2026.");
    expect(note).toContain("`from` and `to`");
  });
});
