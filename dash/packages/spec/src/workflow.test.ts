import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "./access.js";
import { ACTION_VARIANTS, actionVariant, describeDuration, durationMs, fieldProblems, missingFields, outcomesFor } from "./actions.js";
import { chainEdges, describeCron, describeTrigger, firstNode, nextNode, nodeMode, nodeOutcomes, workflowReads, workflowSchema } from "./workflow.js";
import { passes, predicateProblem, renderText, renderValue, stepRow, templateProblem } from "./workflow-expr.js";

const at = "2026-10-06T00:00:00.000Z";
const base = { id: "w", name: "W", createdAt: at, updatedAt: at };

describe("workflowSchema", () => {
  it("starts off, once per row, with no steps and loop limits", () => {
    const workflow = workflowSchema.parse({ ...base, trigger: { kind: "manual" } });
    expect(workflow).toMatchObject({ enabled: false, once: "per-row", nodes: [], edges: [], trial: 0, limits: { visitsPerStep: 10, stepsPerCase: 200 } });
  });

  it("refuses a schedule that is not five fields, and a time zone nobody knows", () => {
    expect(workflowSchema.safeParse({ ...base, trigger: { kind: "schedule", cron: "0 7 * *" } }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...base, trigger: { kind: "schedule", cron: "0 7 * * 1-5", timezone: "Mars/Olympus" } }).success).toBe(false);
  });

  it("reads what an API trigger watches", () => {
    const workflow = workflowSchema.parse({ ...base, trigger: { kind: "record_created", connection: "pms", record: "work_order" } });
    expect(workflowReads(workflow)).toEqual({ connection: "pms", record: "work_order" });
  });
});

describe("the graph", () => {
  const nodes = [
    { id: "text", action: "outreach.text", settings: {} },
    { id: "wait", action: "wait.for", settings: {} },
    { id: "done", action: "update.record", settings: {} },
    { id: "again", action: "outreach.text", settings: {} },
  ];
  const workflow = workflowSchema.parse({
    ...base,
    trigger: { kind: "manual" },
    nodes,
    edges: [
      ...chainEdges(nodes.slice(0, 2)),
      { id: "a", from: "wait", outcome: "happened", to: "done" },
      { id: "b", from: "wait", outcome: "timed_out", to: "again" },
      { id: "c", from: "again", outcome: "next", to: "wait" },
    ],
  });

  it("starts where the trigger points, and follows each outcome's arrow, loops included", () => {
    expect(firstNode(workflow)).toBe("text");
    expect(nextNode(workflow, "text", "next")).toBe("wait");
    expect(nextNode(workflow, "wait", "happened")).toBe("done");
    expect(nextNode(workflow, "wait", "timed_out")).toBe("again");
    expect(nextNode(workflow, "again", "next")).toBe("wait");
  });

  it("ends a case on a failure or a time-out with no arrow, and falls back to next for anything else", () => {
    expect(nextNode(workflow, "text", "failed")).toBeUndefined();
    expect(nextNode(workflow, "text", "anything")).toBe("wait");
    expect(nextNode(workflow, "done", "next")).toBeUndefined();
  });

  it("asks for approval in trial, and never for a step that stays inside Dash", () => {
    expect(nodeMode({ action: "outreach.text", mode: "auto" }, true)).toBe("approve");
    expect(nodeMode({ action: "outreach.text", mode: "auto" })).toBe("auto");
    expect(nodeMode({ action: "create.calendar", mode: "approve" })).toBe("auto");
  });

  it("gives a classify step one way out per category", () => {
    expect(nodeOutcomes({ action: "think.classify", settings: { categories: ["urgent", "routine"] } })).toEqual(["urgent", "routine", "failed"]);
    expect(nodeOutcomes({ action: "wait.for", settings: {} })).toEqual(["happened", "timed_out"]);
  });
});

describe("the catalog", () => {
  it("has the thirteen base actions, each variant with a unique id", () => {
    expect(new Set(ACTION_VARIANTS.map((one) => one.base)).size).toBe(13);
    expect(new Set(ACTION_VARIANTS.map((one) => one.id)).size).toBe(ACTION_VARIANTS.length);
  });

  it("says what a step still needs, with the question to ask", () => {
    const text = actionVariant("outreach.text")!;
    expect(missingFields(text, { agentId: "maint" }).map((one) => [one.key, one.ask])).toEqual([
      ["to", "Who should it reach? (a field on the record, or an address)"],
      ["purpose", "What should the message say or be for?"],
    ]);
    expect(missingFields(actionVariant("wait.for")!, {}).map((one) => one.key)).toEqual([]);
  });

  it("checks each setting's kind, and refuses settings a variant does not have", () => {
    const wait = actionVariant("wait.for")!;
    expect(fieldProblems(wait, { timeout: "soon", colour: "red" }).map((one) => one.key)).toEqual(["colour", "timeout"]);
    expect(outcomesFor(actionVariant("branch.switch")!, { cases: ["high", ""] })).toEqual(["high", "otherwise"]);
  });

  it("reads and says durations", () => {
    expect(durationMs("2d")).toBe(172_800_000);
    expect(durationMs("-3h")).toBe(-10_800_000);
    expect(durationMs("soon")).toBeNull();
    expect(describeDuration("2d")).toBe("2 days");
    expect(describeDuration("90m")).toBe("90 minutes");
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
    expect(describeCron("*/5 * * * *")).toBe("On the schedule */5 * * * *");
  });

  it("names the record and the connection for an API trigger", () => {
    expect(
      describeTrigger({ kind: "record_created", connection: "rv", record: "work_order", every: "15m" }, { connection: () => "Rentvine", record: () => "Work order" }),
    ).toBe("When a new work order appears on Rentvine");
    expect(describeTrigger({ kind: "agent", inputs: [] }, { agents: ["Maintenance agent"] })).toBe("When Maintenance agent is asked");
  });
});

describe("expressions", () => {
  const row = stepRow({ id: 7, cost: 640, unit: { name: "4B" }, status: "open" }, { date: "2026-10-09" });

  it("checks predicates and templates without running them", () => {
    expect(predicateProblem('cost >= 500 && status == "open"')).toBeNull();
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
