import type { FinalReplyContext } from "@freebirdai/core";
import { describe, expect, it } from "vitest";
import {
  RESPONSE_PROMPTS,
  createPromptRotation,
  factsFrom,
  flowOf,
  renderDashReply,
} from "./respond.js";

/**
 * The reply is generated on every turn, so what is asserted here is what the
 * generator is *told* — that it sees what happened, and that it is not handed
 * the same instructions twice in a row.
 */

const ctx = (over: Partial<FinalReplyContext> = {}): FinalReplyContext => ({
  sessionId: "s1",
  userText: "how many active leases?",
  draft: "",
  deterministic: "",
  actionState: { phase: "idle", pending: null, journal: [], workflowStack: [] },
  actionsRun: [],
  executedExtraTools: [],
  clarificationQuestion: "",
  ...over,
});

const assistantToolWithDeep = () => ({
  name: "answer_from_data",
  args: { question: "q", scanRecords: 400 },
  result: {
    outcome: "found",
    findings: [],
    looked: [],
    missing: "",
    requests: 4,
    deep: {
      answer: "38 past leases",
      trends: "two thirds sit on one property",
      caveats: "",
      scanned: 400,
      chunks: 4,
      notRead: 0,
    },
  },
});

const harnessTool = (outcome: string, extra: Record<string, unknown> = {}) => ({
  name: "answer_from_data",
  args: { question: "q" },
  result: { outcome, findings: [], looked: [], missing: "", requests: 0, ...extra },
});

describe("flowOf", () => {
  it("reads the flow off what the harness reported", () => {
    expect(flowOf(ctx(), { harness: { outcome: "found" } })).toBe("answered");
    expect(flowOf(ctx(), { harness: { outcome: "partial" } })).toBe("partial");
    expect(flowOf(ctx(), { harness: { outcome: "exhausted" } })).toBe("exhausted");
    expect(flowOf(ctx(), { harness: { outcome: "not-found" } })).toBe("nothing-found");
  });

  /*
   * A deep read cost several times an ordinary answer and turned up things
   * nobody asked for. Reporting only the number wastes what was paid for.
   */
  it("recognises a deep read as its own flow, whatever the verdict", () => {
    expect(flowOf(ctx(), { harness: { outcome: "found", deep: true } })).toBe("deep");
    expect(flowOf(ctx(), { harness: { outcome: "partial", deep: true } })).toBe("deep");
  });

  it("treats a failed turn as an error whatever else happened", () => {
    expect(flowOf(ctx({ error: "boom" }), { harness: { outcome: "found" } })).toBe("error");
  });

  it("treats a failed tool as an error even without a thrown turn", () => {
    const failed = ctx({
      executedExtraTools: [{ name: "answer_from_data", args: {}, result: { error: "429" } }],
    });
    expect(flowOf(failed)).toBe("error");
  });

  it("recognises a decision the user has to make", () => {
    expect(flowOf(ctx({ clarificationQuestion: "which property?" }))).toBe("deciding");
  });

  /*
   * `start_setup` carries no confirmation step, so it runs and leaves the
   * phase idle. Reading the phase alone said "nothing happened" and the reply
   * announced that it was building a widget the user was already looking at.
   */
  it("knows a widget was built even though the action phase is idle", () => {
    const built = ctx({ actionsRun: [{ componentId: "dashboard", actionId: "start_setup" }] });
    expect(factsFrom(built).builtWidget).toBe(true);
    expect(flowOf(built, factsFrom(built))).toBe("built");
  });

  it("does not call an ordinary action a widget build", () => {
    const other = ctx({ actionsRun: [{ componentId: "dashboard", actionId: "set_time_range" }] });
    expect(factsFrom(other).builtWidget).toBeUndefined();
  });

  it("falls back to plain conversation", () => {
    expect(flowOf(ctx())).toBe("plain");
  });
});

describe("factsFrom", () => {
  it("reads the harness outcome out of the tool result", () => {
    expect(factsFrom(ctx({ executedExtraTools: [harnessTool("found")] })).harness).toEqual({
      outcome: "found",
    });
  });

  it("notices that the read went deep", () => {
    const deep = assistantToolWithDeep();
    expect(factsFrom(ctx({ executedExtraTools: [deep] })).harness).toEqual({
      outcome: "found",
      deep: true,
    });
  });

  it("ignores an unrelated tool", () => {
    const other = { name: "look_up_endpoint", args: {}, result: { fields: [] } };
    expect(factsFrom(ctx({ executedExtraTools: [other] })).harness).toBeUndefined();
  });
});

describe("createPromptRotation", () => {
  it("does not hand out the same instructions twice in a row", () => {
    const rotate = createPromptRotation();
    const first = rotate("answered", "s1");
    const second = rotate("answered", "s1");
    expect(first).not.toBe(second);
  });

  it("comes back round rather than running out", () => {
    const rotate = createPromptRotation();
    const seen = new Set<string>();
    for (let i = 0; i < RESPONSE_PROMPTS.answered.length * 2; i++) {
      seen.add(rotate("answered", "s1"));
    }
    expect(seen.size).toBe(RESPONSE_PROMPTS.answered.length);
  });

  it("keeps two sessions from advancing in step", () => {
    const rotate = createPromptRotation();
    rotate("answered", "s1");
    expect(rotate("answered", "s2")).toBe(RESPONSE_PROMPTS.answered[0]);
  });

  it("rotates each flow independently", () => {
    const rotate = createPromptRotation();
    rotate("answered", "s1");
    expect(rotate("error", "s1")).toBe(RESPONSE_PROMPTS.error[0]);
  });
});

describe("renderDashReply", () => {
  const rotate = createPromptRotation();
  const render = (over: Partial<FinalReplyContext> = {}) =>
    renderDashReply(ctx(over), { sessionId: "s1", rotate });

  it("always carries the honesty rules, whatever the flow", () => {
    for (const over of [{}, { error: "boom" }, { clarificationQuestion: "which?" }]) {
      const prompt = render(over);
      expect(prompt).toContain("Coverage is part of the truth");
      expect(prompt).toContain("[[cite:");
    }
  });

  it("shows the tool results the reply has to be drawn from", () => {
    const prompt = render({
      executedExtraTools: [harnessTool("found", { findings: [{ source: "Leases" }] })],
    });
    expect(prompt).toContain("What was found");
    expect(prompt).toContain("Leases");
  });

  it("hands the draft over as material, not as something to preserve", () => {
    const prompt = render({ draft: "I will look that up" });
    expect(prompt).toContain("I will look that up");
    expect(prompt).toContain("never shown to anyone");
  });

  it("passes the engine's own conclusion in rather than printing it", () => {
    const prompt = render({ deterministic: "I processed your request." });
    expect(prompt).toContain("The system concluded: I processed your request.");
  });

  it("says what failed when the turn failed", () => {
    expect(render({ error: "rate limited" })).toContain("rate limited");
  });

  it("names what is still needed from the user", () => {
    const prompt = render({
      actionState: {
        phase: "collecting",
        pending: {
          recordId: "r",
          componentId: "dashboard",
          actionId: "add_widget",
          label: "add",
          args: {},
          missing: ["widgetId"],
          requiresConfirmation: "preview",
          startedAt: new Date(),
        },
        journal: [],
        workflowStack: [],
      },
    });
    expect(prompt).toContain("Still needed from them: widgetId");
  });

  it("puts the deep read's patterns in front of the writer", () => {
    const prompt = render({ executedExtraTools: [assistantToolWithDeep()] });
    expect(prompt).toContain("two thirds sit on one property");
    expect(prompt).toContain("38 past leases");
  });

  it("tells the writer a preview is already on screen", () => {
    const prompt = renderDashReply(
      ctx({ actionsRun: [{ componentId: "dashboard", actionId: "start_setup" }] }),
      { sessionId: "s-built", rotate },
    );
    expect(prompt).toContain("ALREADY on screen");
    expect(prompt).toContain("start_setup");
  });

  /*
   * The bug this guards: the rows were serialized and cut at a character
   * count, so the model got the summary intact and the records in fragments —
   * and filled the missing fields in. It reported a due date of August 12th
   * for a record that says the 17th.
   */
  it("hands over whole records, never a fragment of one", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      Title: i === 38 ? "Dishwasher" : "Rent Increase Evaluation",
      DueDate: "2026-08-17",
      Noise: "x".repeat(600),
    }));
    const prompt = render({
      executedExtraTools: [
        {
          name: "answer_from_data",
          args: { question: "any dishwasher tasks?" },
          result: {
            outcome: "found",
            findings: [
              {
                source: "All Tasks",
                coverage: "read in full",
                columns: ["Title", "DueDate", "Noise"],
                shows: ["Title", "DueDate"],
                caveats: [],
                rows,
              },
            ],
          },
        },
      ],
    });

    // The record 38 deep survives, and so does its real date.
    expect(prompt).toContain("Dishwasher");
    expect(prompt).toContain("2026-08-17");
    // What was given up to make that fit is stated, not silent.
    expect(prompt).toContain("Noise");
    // And whatever JSON it does contain parses.
    const rowsLine = prompt.split("\n").find((line) => line.trim().startsWith("rows: "));
    expect(() => JSON.parse(rowsLine!.trim().slice("rows: ".length))).not.toThrow();
  });

  it("says so when a non-row tool result had to be cut", () => {
    const prompt = render({
      executedExtraTools: [
        { name: "look_up_endpoint", args: {}, result: { blob: "y".repeat(20_000) } },
      ],
    });
    expect(prompt).toContain("cut here");
  });

  it("forbids tool calls in the final step", () => {
    expect(render()).toContain("Do not call any tools");
  });
});
