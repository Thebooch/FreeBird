import { describe, expect, it } from "vitest";
import type { AgentOverview } from "../../api";
import { NO_FILTER, byDay, keepActive, keepCompleted, taskLabel, tasksIn } from "./filter.js";

const overview: AgentOverview = {
  active: [
    { workflow: "wo", name: "New requests", agents: ["maint"], state: "waiting_approval", stage: "2 items proposed", waitingFor: "Your approval", tasks: ["calendar", "propose_change"], waiting: 2 },
    { workflow: "daily", name: "Morning check", agents: [], state: "waiting_schedule", stage: "Not run yet", waitingFor: "Its schedule", tasks: ["note"], waiting: 0 },
  ],
  completed: [
    { id: "r1:0", at: "2026-10-06T15:00:00.000Z", task: "calendar", title: "Deadline: 4B", workflow: "wo", agent: "maint" },
    { id: "approval:p1", at: "2026-10-06T14:00:00.000Z", task: "approval", title: "Approved: Update task 7", workflow: "wo" },
    { id: "r2:0", at: "2026-10-05T09:00:00.000Z", task: "note", title: "3 checked", workflow: "daily" },
  ],
};

describe("the Overview's filters", () => {
  it("keeps everything with no filter", () => {
    expect(overview.active.filter((one) => keepActive(one, NO_FILTER))).toHaveLength(2);
    expect(overview.completed.filter((one) => keepCompleted(one, NO_FILTER))).toHaveLength(3);
  });

  it("filters both lists by agent, task and workflow alike", () => {
    const byAgent = { ...NO_FILTER, agent: "maint" };
    expect(overview.active.filter((one) => keepActive(one, byAgent)).map((one) => one.workflow)).toEqual(["wo"]);
    expect(overview.completed.filter((one) => keepCompleted(one, byAgent)).map((one) => one.id)).toEqual(["r1:0"]);
    const approvals = { ...NO_FILTER, task: "approval" };
    expect(overview.active.filter((one) => keepActive(one, approvals)).map((one) => one.workflow)).toEqual(["wo"]);
    expect(overview.completed.filter((one) => keepCompleted(one, approvals)).map((one) => one.id)).toEqual(["approval:p1"]);
    const daily = { ...NO_FILTER, workflow: "daily" };
    expect(overview.completed.filter((one) => keepCompleted(one, daily)).map((one) => one.id)).toEqual(["r2:0"]);
  });

  it("names tasks in words and offers only those present", () => {
    expect(taskLabel("propose_change")).toBe("Change a record");
    expect(taskLabel("approval")).toBe("Approval");
    expect(tasksIn(overview)).toEqual(expect.arrayContaining(["approval", "calendar", "note", "propose_change"]));
  });

  it("groups completed tasks by day, newest first", () => {
    const groups = byDay(overview.completed, new Date("2026-10-06T18:00:00.000Z"));
    expect(groups.map((group) => [group.day, group.items.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
  });
});
