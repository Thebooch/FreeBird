import { DEFAULT_HOURS, type Placement } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { durationWords, factLabel, hoursSummary, placementWords, ruleSummary, slugOf, splitDuration } from "./model.js";

const placement = (over: Partial<Placement>): Placement => ({
  id: "p",
  block: "b",
  target: { kind: "member", id: "local" },
  timezone: "America/Chicago",
  start: "2026-10-12T12:00",
  end: "2026-10-12T13:00",
  except: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("scheduling words", () => {
  it("splits a duration into the largest whole unit", () => {
    expect(splitDuration("90m")).toEqual({ amount: 90, unit: "m" });
    expect(splitDuration("120m")).toEqual({ amount: 2, unit: "h" });
    expect(splitDuration("2d")).toEqual({ amount: 2, unit: "d" });
    expect(durationWords("0m")).toBe("none");
    expect(durationWords("1d")).toBe("1 day");
  });

  it("makes a booking page address from a name", () => {
    expect(slugOf("  Café visit — 1h ")).toBe("cafe-visit-1h");
    expect(slugOf("!!!")).toBe("appointment");
  });

  it("groups working hours by runs of days", () => {
    expect(hoursSummary(DEFAULT_HOURS)).toBe("Mon–Fri 09:00–17:00");
    expect(hoursSummary({ ...DEFAULT_HOURS, fri: [{ from: "08:00", to: "15:00" }] })).toBe("Mon–Thu 09:00–17:00 · Fri 08:00–15:00");
  });

  it("names a field nobody labelled in words", () => {
    expect(factLabel("contact.address.postalCode")).toBe("Contact: postal code");
    expect(factLabel("contact.serviceArea")).toBe("Contact: service area");
    expect(factLabel("request.preferred_window")).toBe("This booking: preferred window");
    expect(ruleSummary({ all: [{ field: "contact.serviceArea", op: "in", values: ["north", "east"] }], any: [] })).toBe("service area is one of north or east");
  });

  it("describes a placement's repeat, with runs of weekdays as a range", () => {
    expect(placementWords(placement({ repeat: { every: "week", interval: 1, weekdays: [1, 2, 3, 4, 5] } }))).toBe("Mon–Fri 12:00–13:00, every week");
    expect(placementWords(placement({ repeat: { every: "week", interval: 2, weekdays: [5, 1, 3] } }))).toBe("Mon, Wed, Fri 12:00–13:00, every 2 weeks");
    expect(placementWords(placement({ start: "2026-10-16T13:00", end: "2026-10-16T15:00", repeat: { every: "month", interval: 1, monthly: { by: "weekday", nth: 3 } } }))).toBe(
      "3rd Fri 13:00–15:00, every month",
    );
  });
});
