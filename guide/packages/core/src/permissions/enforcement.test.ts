import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createComponentRegistry } from "../components/registry.js";
import { buildHarnessTurn } from "../actions/harness.js";
import { runAction } from "../actions/run.js";
import type { ActionState } from "../actions/types.js";

/**
 * The posture has to bite at three places, and they are separate on purpose:
 * the harness decides what the model can *see*, the engine decides what it can
 * *propose*, and `runAction` decides what actually *runs*. Only the last one
 * is reachable from MCP, so a gate that lived in only the first two would be
 * open to exactly the caller it is for.
 */

const makeRegistry = () => {
  const registry = createComponentRegistry();
  registry.register({
    id: "settings",
    title: "Settings",
    description: "Settings",
    grid: { minW: 4, minH: 3 },
    actions: [
      {
        id: "set_theme",
        description: "Set theme",
        // Declared as needing no confirmation — the case `guarded` exists for.
        requiresConfirmation: "none",
        schema: z.object({ theme: z.enum(["light", "dark"]) }),
        handler: async () => ({ ok: true }),
      },
    ],
  });
  return registry;
};

const idle: ActionState = {
  phase: "idle",
  pending: null,
  journal: [],
  workflowStack: [],
};

// ---------------------------------------------------------------------------
// Tool visibility
// ---------------------------------------------------------------------------

describe("harness tool visibility", () => {
  it("offers action tools under full", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: idle,
      activeComponentIds: ["settings"],
      permissionMode: "full",
    });
    expect(Object.keys(turn.tools).length).toBeGreaterThan(0);
  });

  it("offers action tools under guarded", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: idle,
      activeComponentIds: ["settings"],
      permissionMode: "guarded",
    });
    expect(Object.keys(turn.tools).length).toBeGreaterThan(0);
  });

  it("offers none at all under readonly", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: idle,
      activeComponentIds: ["settings"],
      permissionMode: "readonly",
    });
    expect(turn.tools).toEqual({});
    expect(turn.systemMessages).toEqual([]);
  });

  it("withholds the steering tools too, not just the start tools", () => {
    // A session that turns read-only mid-action must not still be able to
    // confirm the action it had already opened.
    const collecting: ActionState = {
      ...idle,
      phase: "collecting",
      pending: {
        recordId: "r1",
        componentId: "settings",
        actionId: "set_theme",
        args: {},
        missing: ["theme"],
        requiresConfirmation: "preview",
        startedAt: new Date(),
      },
    };
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: collecting,
      permissionMode: "readonly",
    });
    expect(turn.tools).toEqual({});
  });

  it("behaves exactly as before when no posture is given", () => {
    const withDefault = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: idle,
      activeComponentIds: ["settings"],
    });
    const explicitFull = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: idle,
      activeComponentIds: ["settings"],
      permissionMode: "full",
    });
    expect(Object.keys(withDefault.tools)).toEqual(Object.keys(explicitFull.tools));
  });
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const base = {
  componentId: "settings",
  actionId: "set_theme",
  args: { theme: "dark" as const },
  auth: { userId: "u1" },
  sessionId: "s1",
  recordId: "r1",
};

describe("runAction under a posture", () => {
  it("executes under full", async () => {
    const outcome = await runAction(makeRegistry(), { ...base, permissionMode: "full" });
    expect(outcome.kind).toBe("executed");
  });

  it("executes under guarded — guarded gates confirmation, not execution", async () => {
    // By the time `runAction` is called the confirmation has happened. The
    // guarded rung raises what needs confirming; it does not block the run.
    const outcome = await runAction(makeRegistry(), { ...base, permissionMode: "guarded" });
    expect(outcome.kind).toBe("executed");
  });

  it("refuses under readonly", async () => {
    const outcome = await runAction(makeRegistry(), { ...base, permissionMode: "readonly" });
    expect(outcome).toMatchObject({ kind: "unauthorized", status: 403 });
    if (outcome.kind !== "unauthorized") return;
    expect(outcome.reason).toContain("read-only");
  });

  it("refuses before running the host preflight hook", async () => {
    // preflight reads real data to decide readiness; a read-only session must
    // not cause that read either.
    const preflight = vi.fn(async () => ({ ok: true as const }));
    const handler = vi.fn(async () => ({}));
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "set_theme",
          description: "Set theme",
          schema: z.object({ theme: z.string() }),
          preflight,
          handler,
        },
      ],
    });

    const outcome = await runAction(registry, { ...base, permissionMode: "readonly" });
    expect(outcome.kind).toBe("unauthorized");
    expect(preflight).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("defaults to full when no posture is supplied", async () => {
    const outcome = await runAction(makeRegistry(), base);
    expect(outcome.kind).toBe("executed");
  });
});
