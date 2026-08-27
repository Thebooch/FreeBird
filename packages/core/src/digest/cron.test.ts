import { describe, it, expect } from "vitest";
import { nextCronRun, parseCron } from "./cron.js";

describe("parseCron", () => {
  it("rejects invalid expressions", () => {
    expect(() => parseCron("bogus")).toThrow();
    expect(() => parseCron("* * * *")).toThrow();
  });
});

describe("nextCronRun", () => {
  it("every minute", () => {
    const from = new Date("2026-04-22T10:00:00Z");
    const n = nextCronRun("* * * * *", from);
    expect(n.toISOString()).toBe("2026-04-22T10:01:00.000Z");
  });

  it("hourly at :15", () => {
    const from = new Date("2026-04-22T10:00:00Z");
    const n = nextCronRun("15 * * * *", from);
    expect(n.toISOString()).toBe("2026-04-22T10:15:00.000Z");
  });

  it("daily at 09:00 UTC", () => {
    const from = new Date("2026-04-22T12:00:00Z");
    const n = nextCronRun("0 9 * * *", from);
    expect(n.toISOString()).toBe("2026-04-23T09:00:00.000Z");
  });

  it("weekly Mondays at 08:30", () => {
    // 2026-04-22 is a Wednesday (day=3). Next Monday 08:30 UTC.
    const from = new Date("2026-04-22T12:00:00Z");
    const n = nextCronRun("30 8 * * 1", from);
    expect(n.getUTCDay()).toBe(1);
    expect(n.getUTCHours()).toBe(8);
    expect(n.getUTCMinutes()).toBe(30);
  });
});
