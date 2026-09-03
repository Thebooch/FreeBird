import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createComponentRegistry } from "../components/registry.js";
import { buildHarnessTurn } from "./harness.js";
import {
  DEFAULT_TOOL_BUDGET_BYTES,
  TOOL_DESCRIBE_NAME,
  TOOL_SEARCH_NAME,
  describeActionSchema,
  parseActionRef,
  scoreCandidate,
  searchActions,
  serializedToolBytes,
  type ActionCandidate,
} from "./tool-search.js";
import type { ActionState } from "./types.js";

const idle: ActionState = { phase: "idle", pending: null, journal: [], workflowStack: [] };

/** A registry with `count` components, each carrying one action. */
const makeRegistry = (count: number, fat = false) => {
  const registry = createComponentRegistry();
  for (let i = 0; i < count; i += 1) {
    registry.register({
      id: `component${i}`,
      title: `Component ${i}`,
      description: `Component ${i}`,
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: `action${i}`,
          description: `Do the number ${i} thing to a record`,
          schema: fat
            ? z.object({
                a: z.string().describe("a".repeat(200)),
                b: z.object({ c: z.string(), d: z.number(), e: z.boolean() }),
                f: z.array(z.object({ g: z.string(), h: z.string() })),
              })
            : z.object({ value: z.string() }),
          handler: async () => ({}),
        },
      ],
    });
  }
  return registry;
};

const allComponentIds = (count: number) =>
  Array.from({ length: count }, (_, i) => `component${i}`);

const candidate = (over: Partial<ActionCandidate> = {}): ActionCandidate => ({
  ref: "orders:refund",
  componentId: "orders",
  actionId: "refund",
  description: "Refund an order to the customer",
  ...over,
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe("scoreCandidate", () => {
  it("ranks an exact action id highest", () => {
    expect(scoreCandidate("refund", candidate())).toBeGreaterThan(
      scoreCandidate("customer", candidate()),
    );
  });

  it("scores zero for an unrelated query", () => {
    expect(scoreCandidate("weather", candidate())).toBe(0);
  });

  it("scores zero for an empty query rather than matching everything", () => {
    expect(scoreCandidate("   ", candidate())).toBe(0);
  });
});

describe("searchActions", () => {
  const corpus: ActionCandidate[] = [
    candidate(),
    candidate({
      ref: "orders:cancel",
      actionId: "cancel",
      description: "Cancel an order before it ships",
    }),
    candidate({
      ref: "profile:rename",
      componentId: "profile",
      actionId: "rename",
      description: "Change the display name",
    }),
  ];

  it("finds by action id", () => {
    expect(searchActions(corpus, "refund").map((c) => c.ref)).toEqual(["orders:refund"]);
  });

  it("finds by description wording", () => {
    expect(searchActions(corpus, "display name").map((c) => c.ref)).toEqual(["profile:rename"]);
  });

  it("returns matches for a component name", () => {
    expect(searchActions(corpus, "orders").map((c) => c.ref).sort()).toEqual([
      "orders:cancel",
      "orders:refund",
    ]);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(searchActions(corpus, "spaceship")).toEqual([]);
  });

  it("is deterministic across identical calls", () => {
    // The reason this is substring matching and not embeddings.
    expect(searchActions(corpus, "order")).toEqual(searchActions(corpus, "order"));
  });

  it("honours the limit", () => {
    expect(searchActions(corpus, "orders", 1)).toHaveLength(1);
  });
});

describe("parseActionRef", () => {
  it("splits a well-formed ref", () => {
    expect(parseActionRef("orders:refund")).toEqual({
      componentId: "orders",
      actionId: "refund",
    });
  });

  it("rejects malformed refs", () => {
    for (const bad of ["orders", ":refund", "orders:", "", 42, null]) {
      expect(parseActionRef(bad)).toBeNull();
    }
  });
});

describe("describeActionSchema", () => {
  it("returns the full schema for a known action", () => {
    const out = describeActionSchema(makeRegistry(1), "component0:action0");
    expect(out?.action).toBe("component0:action0");
    expect(out?.description).toContain("number 0 thing");
    expect(JSON.stringify(out?.schema)).toContain("value");
  });

  it("returns null for an unknown ref", () => {
    expect(describeActionSchema(makeRegistry(1), "nope:missing")).toBeNull();
    expect(describeActionSchema(makeRegistry(1), "garbage")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The threshold — asserted on bytes, which is the whole point
// ---------------------------------------------------------------------------

describe("tool budget", () => {
  it("leaves a small registry exactly as it was", () => {
    const registry = makeRegistry(5);
    const ids = allComponentIds(5);
    const withFeature = buildHarnessTurn({ registry, actionState: idle, activeComponentIds: ids });
    const unbounded = buildHarnessTurn({
      registry,
      actionState: idle,
      activeComponentIds: ids,
      toolBudgetBytes: Number.POSITIVE_INFINITY,
    });
    expect(Object.keys(withFeature.tools).sort()).toEqual(Object.keys(unbounded.tools).sort());
    expect(withFeature.tools[TOOL_SEARCH_NAME]).toBeUndefined();
  });

  it("keeps a large registry under budget", () => {
    const registry = makeRegistry(200);
    const turn = buildHarnessTurn({
      registry,
      actionState: idle,
      activeComponentIds: allComponentIds(200),
    });
    // The assertion that matters: bytes, not behaviour.
    expect(serializedToolBytes(turn.tools)).toBeLessThan(DEFAULT_TOOL_BUDGET_BYTES);
    expect(Object.keys(turn.tools).sort()).toEqual([
      "start_action",
      TOOL_DESCRIBE_NAME,
      TOOL_SEARCH_NAME,
    ].sort());
  });

  it("would have blown the budget without deferring", () => {
    // Proves the previous test is measuring something real.
    const registry = makeRegistry(200);
    const unbounded = buildHarnessTurn({
      registry,
      actionState: idle,
      activeComponentIds: allComponentIds(200),
      toolBudgetBytes: Number.POSITIVE_INFINITY,
    });
    expect(serializedToolBytes(unbounded.tools)).toBeGreaterThan(DEFAULT_TOOL_BUDGET_BYTES);
  });

  it("defers on schema size, not action count", () => {
    /*
     * The same twelve actions, differing only in how deep their argument
     * schemas go: ~6.5 KB flat against ~12.9 KB fat. One budget between the
     * two defers the expensive set and leaves the cheap one inline — which a
     * count threshold, seeing twelve either way, could not do.
     */
    const ids = allComponentIds(12);
    const budget = 9000;

    const fat = buildHarnessTurn({
      registry: makeRegistry(12, true),
      actionState: idle,
      activeComponentIds: ids,
      toolBudgetBytes: budget,
    });
    expect(fat.tools[TOOL_SEARCH_NAME]).toBeDefined();

    const flat = buildHarnessTurn({
      registry: makeRegistry(12, false),
      actionState: idle,
      activeComponentIds: ids,
      toolBudgetBytes: budget,
    });
    expect(flat.tools[TOOL_SEARCH_NAME]).toBeUndefined();

    // Pin the premise: same count, different cost, budget genuinely between.
    const measure = (fatSchemas: boolean) =>
      serializedToolBytes(
        buildHarnessTurn({
          registry: makeRegistry(12, fatSchemas),
          actionState: idle,
          activeComponentIds: ids,
          toolBudgetBytes: Number.POSITIVE_INFINITY,
        }).tools,
      );
    expect(measure(false)).toBeLessThan(budget);
    expect(measure(true)).toBeGreaterThan(budget);
  });

  it("drops the per-action summary message along with the tools", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(200),
      actionState: idle,
      activeComponentIds: allComponentIds(200),
    });
    // Listing 200 tool names in a system message would defeat the point.
    expect(turn.systemMessages).toEqual([]);
  });

  it("still yields nothing at all for a read-only session", () => {
    // Posture first, packaging second: deferring is not an authorization
    // decision and must not become one.
    const turn = buildHarnessTurn({
      registry: makeRegistry(200),
      actionState: idle,
      activeComponentIds: allComponentIds(200),
      permissionMode: "readonly",
    });
    expect(turn.tools).toEqual({});
  });
});
