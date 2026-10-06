import { workflowInputSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { blankStep, blankTrigger, fromSpec, newStepId, toInput, workflowState } from "./draft.js";

describe("the workflow editor's draft", () => {
  it("names steps by kind, without clashing", () => {
    expect(newStepId("propose_change", [])).toBe("propose-change");
    expect(newStepId("note", ["note", "note-2"])).toBe("note-3");
  });

  it("starts a change at approve, and a calendar entry at auto", () => {
    expect(blankStep("propose_change", []).mode).toBe("approve");
    expect(blankStep("calendar", []).mode).toBe("auto");
  });

  it("keeps where an API trigger looks when its kind changes", () => {
    const created = { kind: "record_created", connection: "pms", record: "work_order", every: "15m" } as const;
    expect(blankTrigger("record_changed", created)).toMatchObject({ connection: "pms", record: "work_order" });
  });

  it("saves only what a person set, which the server accepts", () => {
    const input = toInput({
      ...fromSpec(null),
      name: "  Overdue  ",
      trigger: { kind: "record_created", connection: "pms", record: "work_order", every: "15m" },
      source: { connection: "pms", record: "unit" },
      criteria: " ",
      steps: [{ ...blankStep("note", []), text: "Hi", when: "  " } as never],
    });
    expect(input).not.toHaveProperty("source");
    expect(input).not.toHaveProperty("criteria");
    expect(input.steps?.[0]).not.toHaveProperty("when");
    expect(input.name).toBe("Overdue");
    expect(workflowInputSchema.safeParse(input).success).toBe(true);
  });

  it("says whether it is on, off or paused", () => {
    expect(workflowState({ enabled: true }).label).toBe("On");
    expect(workflowState({ enabled: true, parked: { reason: "x", at: "" } }).tone).toBe("paused");
  });
});
