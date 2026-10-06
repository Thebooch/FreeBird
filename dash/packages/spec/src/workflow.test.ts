import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "./access.js";
import { describeCron, describeTrigger, stepMode, workflowReads, workflowSchema } from "./workflow.js";
import { passes, predicateProblem, renderText, renderValue, stepRow, templateProblem } from "./workflow-expr.js";

const at = "2026-10-06T00:00:00.000Z";
const base = { id: "w", name: "W", createdAt: at, updatedAt: at };

describe("workflowSchema", () => {
  it("starts off, once per row, with no steps", () => {
    const workflow = workflowSchema.parse({ ...base, trigger: { kind: "manual" } });
    expect(workflow).toMatchObject({ enabled: false, once: "per-row", steps: [], failures: 0 });
  });

  it("defaults a step that leaves Dash to approve", () => {
    const workflow = workflowSchema.parse({
      ...base,
      trigger: { kind: "manual" },
      steps: [{ id: "s", kind: "propose_change", entity: "work_order", change: "update", values: { vendor: "v1" } }],
    });
    expect(workflow.steps[0]?.mode).toBe("approve");
  });

  it("refuses a schedule that is not five fields, and a time zone nobody knows", () => {
    expect(workflowSchema.safeParse({ ...base, trigger: { kind: "schedule", cron: "0 7 * *" } }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...base, trigger: { kind: "schedule", cron: "0 7 * * 1-5", timezone: "Mars/Olympus" } }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...base, trigger: { kind: "schedule", cron: "0 7 * * 1-5", timezone: "America/Chicago" } }).success).toBe(true);
  });

  it("reads either a record type or an endpoint", () => {
    const both = { ...base, trigger: { kind: "manual" }, source: { connection: "pms", record: "unit", op: "units" } };
    expect(workflowSchema.safeParse(both).success).toBe(false);
  });

  it("reads what an API trigger watches", () => {
    const workflow = workflowSchema.parse({ ...base, trigger: { kind: "record_created", connection: "pms", record: "work_order" } });
    expect(workflowReads(workflow)).toEqual({ connection: "pms", record: "work_order" });
  });
});

describe("modes", () => {
  it("does calendar entries and notes every time, whatever they say", () => {
    expect(stepMode({ kind: "calendar", mode: "approve" })).toBe("auto");
    expect(stepMode({ kind: "note", mode: "approve" })).toBe("auto");
    expect(stepMode({ kind: "propose_change", mode: "auto" })).toBe("auto");
    expect(stepMode({ kind: "message", mode: "approve" })).toBe("approve");
  });

  it("lets editors manage workflows, and viewers not", () => {
    expect(ROLE_PERMISSIONS.editor).toContain("workflows.manage");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("workflows.manage");
  });
});

describe("words", () => {
  it("says common schedules plainly", () => {
    expect(describeCron("0 7 * * 1-5")).toBe("Weekdays at 7:00");
    expect(describeCron("30 9 * * *")).toBe("Every day at 9:30");
    expect(describeCron("0 8 * * 1")).toBe("Every Monday at 8:00");
    expect(describeCron("*/5 * * * *")).toBe("On the schedule */5 * * * *");
  });

  it("names the record and the connection for an API trigger", () => {
    expect(
      describeTrigger({ kind: "record_created", connection: "rv", record: "work_order", every: "15m" }, {
        connection: () => "Rentvine",
        record: () => "Work order",
      }),
    ).toBe("When a new work order appears on Rentvine");
    expect(describeTrigger({ kind: "agent", inputs: [] }, { agents: ["Maintenance agent"] })).toBe("When Maintenance agent is asked");
  });
});

describe("expressions", () => {
  const row = stepRow({ id: 7, cost: 640, unit: { name: "4B" }, status: "open" }, { date: "2026-10-09" });

  it("checks predicates and templates without running them", () => {
    expect(predicateProblem("cost >= 500 && status == \"open\"")).toBeNull();
    expect(predicateProblem("cost >=")).not.toBeNull();
    expect(templateProblem("Inspect {{ unit.name }}")).toBeNull();
    expect(templateProblem("Inspect {{ }}")).not.toBeNull();
  });

  it("routes rows by condition, and refuses rows a predicate cannot read", () => {
    expect(passes("cost >= 500", row, 0)).toBe(true);
    expect(passes("cost < 500", row, 0)).toBe(false);
    expect(passes(undefined, row, 0)).toBe(true);
  });

  it("keeps a lone expression's type, and writes text otherwise", () => {
    expect(renderValue("{{ cost }}", row, 0)).toBe(640);
    expect(renderText("Unit {{ unit.name }} by {{ input.date }}", row, 0)).toBe("Unit 4B by 2026-10-09");
  });
});
