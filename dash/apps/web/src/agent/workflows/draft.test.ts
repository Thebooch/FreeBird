import { chainEdges, workflowInputSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { NODE_H, autoLayout, blankNode, blankTrigger, connect, fromSpec, newNodeId, removeNode, toInput, workflowState } from "./draft.js";

describe("the builder's draft", () => {
  it("names steps by variant, without clashing with each other or the trigger", () => {
    expect(newNodeId("outreach.text", [])).toBe("text");
    expect(newNodeId("wait.for", ["for"])).toBe("for-2");
    expect(newNodeId("branch.if", [])).toBe("branch");
  });

  it("starts a step with its variant's defaults and mode, and fills the agent in", () => {
    const step = blankNode("outreach.text", [], { x: 0, y: 0 }, "maint");
    expect(step).toMatchObject({ mode: "approve", settings: { agentId: "maint", content: "agent" } });
    expect(blankNode("wait.for", [], { x: 0, y: 0 }).settings).toMatchObject({ event: "reply", timeout: "2d" });
  });

  it("keeps one arrow per outcome, and takes a step's arrows with it", () => {
    let edges = connect([], "trigger", "next", "a");
    edges = connect(edges, "a", "next", "b");
    edges = connect(edges, "a", "next", "c");
    expect(edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(["trigger>a", "a>c"]);
    expect(removeNode({ nodes: [blankNode("create.note", [], { x: 0, y: 0 })], edges }, "a").edges).toEqual([]);
  });

  it("lays steps out a row below what leads to them, a loop back not counting", () => {
    const nodes = ["a", "b", "c"].map((id) => ({ ...blankNode("create.note", [], { x: 0, y: 0 }), id }));
    const edges = [...chainEdges(nodes), { id: "loop", from: "c", outcome: "next", to: "a" }];
    const laid = autoLayout(nodes, edges);
    expect(laid.map((one) => one.position.y)).toEqual([laid[0]!.position.y, laid[0]!.position.y + NODE_H + 64, laid[0]!.position.y + 2 * (NODE_H + 64)]);
  });

  it("keeps where an API trigger looks when its kind changes", () => {
    expect(blankTrigger("record_changed", { kind: "record_created", connection: "pms", record: "work_order", every: "15m" })).toMatchObject({ connection: "pms", record: "work_order" });
  });

  it("saves only what a person set, which the server accepts", () => {
    const input = toInput({
      ...fromSpec(null),
      name: "  Overdue  ",
      trigger: { kind: "record_created", connection: "pms", record: "work_order", every: "15m" },
      source: { connection: "pms", record: "unit" },
      nodes: [{ ...blankNode("create.note", [], { x: 0, y: 0 }), when: " " }],
    });
    expect(input).not.toHaveProperty("source");
    expect(input.nodes?.[0]).not.toHaveProperty("when");
    expect(workflowInputSchema.safeParse(input).success).toBe(true);
  });

  it("says whether it is on, in trial, off or paused", () => {
    expect(workflowState({ enabled: true }).label).toBe("On");
    expect(workflowState({ enabled: true, trial: 3 }).label).toBe("Trial (3)");
    expect(workflowState({ enabled: true, parked: { reason: "x", at: "" } }).tone).toBe("paused");
  });
});
