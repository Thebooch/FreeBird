import { describe, expect, it } from "vitest";
import type { AgentOverview } from "../../api";
import { NO_FILTER, byDay, keepActive, keepCompleted, taskLabel, tasksIn } from "./filter.js";

const overview: AgentOverview = {
  active: [
    { workflow: "wo", name: "New requests", agents: ["maint"], state: "waiting_approval", stage: "2 cases open", waitingFor: "your approval (2)", tasks: ["create", "update"], waiting: 2, cases: [] },
    { workflow: "daily", name: "Morning check", agents: [], state: "waiting_schedule", stage: "Not run yet", waitingFor: "Its schedule", tasks: ["create"], waiting: 0, cases: [] },
  ],
  completed: [
    { id: "t1", at: "2026-10-06T15:00:00.000Z", task: "create", action: "create.calendar", title: "Deadline: 4B", status: "done", workflow: "wo", agent: "maint", reversible: true },
    { id: "t2", at: "2026-10-06T14:00:00.000Z", task: "approval", action: "update.record", title: "Update task 7", status: "done", workflow: "wo", reversible: true },
    { id: "t3", at: "2026-10-05T09:00:00.000Z", task: "notify", action: "notify.team", title: "3 checked", status: "done", workflow: "daily", reversible: true },
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
    expect(overview.completed.filter((one) => keepCompleted(one, byAgent)).map((one) => one.id)).toEqual(["t1"]);
    const approvals = { ...NO_FILTER, task: "approval" };
    expect(overview.active.filter((one) => keepActive(one, approvals)).map((one) => one.workflow)).toEqual(["wo"]);
    expect(overview.completed.filter((one) => keepCompleted(one, approvals)).map((one) => one.id)).toEqual(["t2"]);
    expect(overview.completed.filter((one) => keepCompleted(one, { ...NO_FILTER, workflow: "daily" })).map((one) => one.id)).toEqual(["t3"]);
  });

  it("names tasks by their base action, and offers only those present", () => {
    expect(taskLabel("outreach")).toBe("Outreach");
    expect(taskLabel("approval")).toBe("Approval");
    expect(tasksIn(overview)).toEqual(expect.arrayContaining(["approval", "create", "notify", "update"]));
  });

  it("groups completed tasks by day, newest first", () => {
    const groups = byDay(overview.completed, new Date("2026-10-06T18:00:00.000Z"));
    expect(groups.map((group) => [group.day, group.items.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
  });
});
