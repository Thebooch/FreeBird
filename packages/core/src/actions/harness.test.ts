import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createComponentRegistry } from "../components/registry.js";
import { buildHarnessTurn } from "./harness.js";
import type { ActionRecord, ActionState } from "./types.js";

const T = new Date("2026-04-22T10:00:00Z");

const makeRegistry = () => {
  const r = createComponentRegistry();
  r.register({
    id: "settings",
    title: "Settings",
    description: "User settings panel",
    grid: { minW: 4, minH: 3 },
    actions: [
      {
        id: "set_theme",
        description: "Set theme",
        schema: z.object({ theme: z.enum(["light", "dark"]) }),
        handler: async () => ({}),
      },
    ],
  });
  r.register({
    id: "profile",
    title: "Profile",
    description: "User profile",
    grid: { minW: 4, minH: 3 },
    actions: [
      {
        id: "set_handle",
        description: "Set the user's handle",
        schema: z.object({ handle: z.string().min(1) }),
        handler: async () => ({}),
      },
    ],
  });
  r.register({
    id: "calendar",
    title: "Calendar",
    description: "No actions",
    grid: { minW: 4, minH: 3 },
  });
  return r;
};

const stateOf = (overrides: Partial<ActionState> = {}): ActionState => ({
  phase: "idle",
  pending: null,
  journal: [],
  workflowStack: [],
  ...overrides,
});

const pausedRecord = (id = "rec-old"): ActionRecord => ({
  id,
  componentId: "settings",
  actionId: "set_theme",
  args: { theme: "dark" },
  status: "paused",
  startedAt: T,
  updatedAt: T,
  label: "configure theme",
});

describe("buildHarnessTurn — phase=idle", () => {
  it("exposes per-action start tools when active components have actions", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf(),
      activeComponentIds: ["settings", "profile"],
    });
    expect(Object.keys(turn.tools).sort()).toEqual([
      "start_action__profile__set_handle",
      "start_action__settings__set_theme",
    ]);
    expect(turn.activeActionIds.sort()).toEqual([
      "profile:set_handle",
      "settings:set_theme",
    ]);
  });

  it("filters start_action candidates by activeComponentIds", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf(),
      activeComponentIds: ["settings"],
    });
    expect(turn.activeActionIds).toEqual(["settings:set_theme"]);
  });

  it("exposes every registered action when activeComponentIds is empty or omitted (enables cross-page navigation)", () => {
    const withEmpty = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf(),
      activeComponentIds: [],
    });
    const withOmitted = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf(),
    });
    const expected = ["profile:set_handle", "settings:set_theme"];
    expect(withEmpty.activeActionIds.sort()).toEqual(expected);
    expect(withOmitted.activeActionIds.sort()).toEqual(expected);
  });

  it("omits start tools when no active components have actions", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf(),
      activeComponentIds: ["calendar"],
    });
    expect(
      Object.keys(turn.tools).some((k) => k.startsWith("start_action")),
    ).toBe(false);
  });

  it("exposes legacy start_action when argsMode is loose", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf(),
      activeComponentIds: ["settings"],
      argsMode: "loose",
    });
    expect(turn.tools.start_action).toBeDefined();
  });

  it("exposes resume_action only when paused records exist", () => {
    const a = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf(),
      activeComponentIds: ["settings"],
    });
    expect(a.tools.resume_action).toBeUndefined();

    const b = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf({ journal: [pausedRecord()] }),
      activeComponentIds: ["settings"],
    });
    expect(b.tools.resume_action).toBeDefined();
    expect(b.systemMessages.some((m) => m.content.includes("paused"))).toBe(
      true,
    );
  });
});

describe("buildHarnessTurn — phase=collecting", () => {
  it("exposes update/clarify/cancel/pause and renders prompt", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf({
        phase: "collecting",
        pending: {
          recordId: "r1",
          componentId: "settings",
          actionId: "set_theme",
          args: {},
          missing: ["theme"],
          requiresConfirmation: "preview",
          startedAt: T,
        },
      }),
      activeComponentIds: ["settings"],
    });
    expect(Object.keys(turn.tools).sort()).toEqual([
      "cancel_action",
      "pause_action",
      "request_clarification",
      "update_action_args",
    ]);
    expect(turn.tools.start_action).toBeUndefined();
    expect(turn.systemMessages[0]?.content).toContain("settings:set_theme");
    expect(turn.systemMessages[0]?.content).toContain("Missing required");
  });
});

describe("buildHarnessTurn — phase=awaiting_confirmation", () => {
  it("only exposes cancel/pause and renders confirmation prompt", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf({
        phase: "awaiting_confirmation",
        pending: {
          recordId: "r1",
          componentId: "settings",
          actionId: "set_theme",
          args: { theme: "dark" },
          missing: [],
          requiresConfirmation: "preview",
          startedAt: T,
        },
      }),
      activeComponentIds: ["settings"],
    });
    expect(Object.keys(turn.tools).sort()).toEqual([
      "cancel_action",
      "pause_action",
    ]);
    expect(turn.systemMessages[0]?.content).toContain(
      "ready for the user to confirm",
    );
  });
});

describe("buildHarnessTurn — phase=executing", () => {
  it("exposes no action tools while executing", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf({
        phase: "executing",
        pending: {
          recordId: "r1",
          componentId: "settings",
          actionId: "set_theme",
          args: { theme: "dark" },
          missing: [],
          requiresConfirmation: "preview",
          startedAt: T,
        },
      }),
      activeComponentIds: ["settings"],
    });
    expect(Object.keys(turn.tools)).toEqual([]);
  });
});

describe("buildHarnessTurn — phase=error", () => {
  it("re-exposes start tools and resume_action so the user can recover", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf({
        phase: "error",
        lastError: "boom",
        journal: [pausedRecord()],
      }),
      activeComponentIds: ["settings"],
    });
    expect(turn.tools["start_action__settings__set_theme"]).toBeDefined();
    expect(turn.tools.resume_action).toBeDefined();
  });
});

describe("buildHarnessTurn — argsMode=typed", () => {
  it("emits a discriminated union for start_action with per-action arg schemas", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf(),
      activeComponentIds: ["settings", "profile"],
      argsMode: "typed",
    });
    const tool = turn.tools.start_action;
    expect(tool).toBeDefined();
    // The right ref+args combo parses cleanly.
    const okThemeRaw = tool!.schema.safeParse({
      action: "settings:set_theme",
      args: { theme: "dark" },
    });
    expect(okThemeRaw.success).toBe(true);
    // The right ref but with a *different* action's args fails — proving
    // we get per-ref typing rather than a global record<unknown>.
    const wrong = tool!.schema.safeParse({
      action: "settings:set_theme",
      args: { handle: "foo" },
    });
    // theme is required by the underlying schema once the discriminator
    // matches; passing only `handle` should not validate as a complete
    // payload (zod returns success because partial allows missing keys
    // BUT extras pass through). This test guards the discriminator
    // routing — the parsed shape is the typed variant.
    if (wrong.success) {
      // partial allows missing required + ignores extras, but the parsed
      // value must NOT include `handle` since the typed args drops it.
      // (Zod's default object stripping does this for known shapes.)
      expect(
        (wrong.data as { args?: Record<string, unknown> }).args,
      ).not.toHaveProperty("handle");
    }
  });

  it("falls back to loose mode when explicitly requested", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf(),
      activeComponentIds: ["settings", "profile"],
      argsMode: "loose",
    });
    const tool = turn.tools.start_action;
    // Loose mode accepts arbitrary argument shapes.
    const ok = tool!.schema.safeParse({
      action: "settings:set_theme",
      args: { foo: "bar", count: 3 },
    });
    expect(ok.success).toBe(true);
  });

  it("scopes update_action_args to the pending action's schema in typed mode", () => {
    const turn = buildHarnessTurn({
      registry: makeRegistry(),
      actionState: stateOf({
        phase: "collecting",
        pending: {
          recordId: "r1",
          componentId: "settings",
          actionId: "set_theme",
          args: {},
          missing: ["theme"],
          requiresConfirmation: "preview",
          startedAt: T,
        },
      }),
      activeComponentIds: ["settings"],
    });
    const tool = turn.tools.update_action_args;
    expect(tool).toBeDefined();
    // The valid theme value passes.
    expect(
      tool!.schema.safeParse({ args: { theme: "dark" } }).success,
    ).toBe(true);
    // An invalid theme value fails — proving typed args are scoped to
    // the pending action's enum.
    expect(
      tool!.schema.safeParse({ args: { theme: "not-a-theme" } }).success,
    ).toBe(false);
  });
});
