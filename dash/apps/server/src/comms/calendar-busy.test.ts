import { describe, expect, it } from "vitest";
import { SchedulingService } from "../scheduling/service.js";
import { MemorySchedulingStore } from "../scheduling/store.js";
import { MemoryCalendarStore } from "../workflows/store.js";

describe("a member's own calendar in booking", () => {
  it("counts its busy times as taken, and a calendar that cannot be read as nothing", async () => {
    const make = (external: (member: string) => Promise<{ start: number; end: number }[]>) =>
      new SchedulingService({ store: new MemorySchedulingStore(), calendar: new MemoryCalendarStore(), members: async () => [], external, now: () => 0 });
    const busy = await make(async () => [{ start: 1_000, end: 2_000 }]).busyFor("local", 0, 10_000);
    expect(busy).toEqual([{ start: 1_000, end: 2_000, kind: "entry" }]);
    expect(await make(async () => Promise.reject(new Error("no access"))).busyFor("local", 0, 10_000)).toEqual([]);
  });
});
