import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createComponentRegistry,
  type AuthContext,
  type ComponentRegistry,
  type DbAdapter,
} from "@freebirdai/core";
import {
  handleConfirmAction,
  handleUpdateActionArgs,
  type HandlerDeps,
  type ServerActionEvent,
} from "./handlers.js";

const auth: AuthContext = { userId: "u1" };

const stubDb = (): DbAdapter =>
  ({
    appendMessage: vi.fn(async (input: any) => ({
      id: "m1",
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: new Date(),
    })),
  }) as unknown as DbAdapter;

const buildDeps = (
  overrides: Partial<{
    registry: ComponentRegistry<any, any>;
    onActionEvent: HandlerDeps["onActionEvent"];
  }> = {},
): HandlerDeps => ({
  // Only the bits the handlers under test touch.
  chat: {} as any,
  tabs: {} as any,
  knowledge: {} as any,
  db: stubDb(),
  registry: overrides.registry ?? createComponentRegistry(),
  onActionEvent: overrides.onActionEvent,
});

const baseConfirmReq = {
  body: {
    sessionId: "s1",
    recordId: "r1",
    componentId: "settings",
    actionId: "set_theme",
    args: { theme: "dark" },
  },
  params: {},
  query: {},
  headers: {},
  auth,
};

describe("handleConfirmAction — authorize gate", () => {
  it("runs handler and emits action.executed when authorize returns true", async () => {
    const handler = vi.fn(async () => ({ ok: 1 }));
    const authorize = vi.fn(async () => true);
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings panel",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "set_theme",
          description: "set theme",
          schema: z.object({ theme: z.enum(["light", "dark"]) }),
          authorize,
          handler,
        },
      ],
    });
    const events: ServerActionEvent[] = [];
    const deps = buildDeps({
      registry,
      onActionEvent: (e) => {
        events.push(e);
      },
    });
    const res = await handleConfirmAction(deps, baseConfirmReq);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.kind)).toEqual(["action.executed"]);
  });

  it("returns 403, skips handler, and emits action.unauthorized when authorize returns false", async () => {
    const handler = vi.fn();
    const authorize = vi.fn(async () => false);
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings panel",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "set_theme",
          description: "set theme",
          schema: z.object({ theme: z.enum(["light", "dark"]) }),
          authorize,
          handler,
        },
      ],
    });
    const events: ServerActionEvent[] = [];
    const deps = buildDeps({
      registry,
      onActionEvent: (e) => {
        events.push(e);
      },
    });
    const res = await handleConfirmAction(deps, baseConfirmReq);
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("action.unauthorized");
  });

  it("uses { ok: false, reason, status } shape from authorize", async () => {
    const authorize = vi.fn(async () => ({
      ok: false as const,
      reason: "channel forbidden",
      status: 401,
    }));
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings panel",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "set_theme",
          description: "set theme",
          schema: z.object({ theme: z.enum(["light", "dark"]) }),
          authorize,
          handler: async () => ({}),
        },
      ],
    });
    const events: ServerActionEvent[] = [];
    const deps = buildDeps({
      registry,
      onActionEvent: (e) => {
        events.push(e);
      },
    });
    const res = await handleConfirmAction(deps, baseConfirmReq);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("channel forbidden");
    expect(events[0]?.kind).toBe("action.unauthorized");
    if (events[0]?.kind === "action.unauthorized") {
      expect(events[0].reason).toBe("channel forbidden");
    }
  });

  it("treats a thrown authorize as a 500 denial (fail-closed)", async () => {
    const handler = vi.fn();
    const authorize = vi.fn(async () => {
      throw new Error("boom");
    });
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings panel",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "set_theme",
          description: "set theme",
          schema: z.object({ theme: z.enum(["light", "dark"]) }),
          authorize,
          handler,
        },
      ],
    });
    const events: ServerActionEvent[] = [];
    const deps = buildDeps({
      registry,
      onActionEvent: (e) => {
        events.push(e);
      },
    });
    const res = await handleConfirmAction(deps, baseConfirmReq);
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
    expect(events[0]?.kind).toBe("action.unauthorized");
  });

  it("when no authorize is configured, action proceeds normally", async () => {
    const handler = vi.fn(async () => ({ ok: 1 }));
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings panel",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "set_theme",
          description: "set theme",
          schema: z.object({ theme: z.enum(["light", "dark"]) }),
          handler,
        },
      ],
    });
    const events: ServerActionEvent[] = [];
    const deps = buildDeps({
      registry,
      onActionEvent: (e) => {
        events.push(e);
      },
    });
    const res = await handleConfirmAction(deps, baseConfirmReq);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events[0]?.kind).toBe("action.executed");
  });
});

describe("handleUpdateActionArgs — authorize gate", () => {
  const updateReq = (args: Record<string, unknown>) => ({
    body: {
      sessionId: "s1",
      recordId: "r1",
      componentId: "settings",
      actionId: "set_theme",
      args,
    },
    params: {},
    query: {},
    headers: {},
    auth,
  });

  it("does not call authorize while args are still incomplete", async () => {
    const authorize = vi.fn(async () => true);
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings panel",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "set_theme",
          description: "set theme",
          schema: z.object({ theme: z.enum(["light", "dark"]) }),
          authorize,
          handler: async () => ({}),
        },
      ],
    });
    const deps = buildDeps({ registry });
    const res = await handleUpdateActionArgs(deps, updateReq({}));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.missing).toEqual(["theme"]);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects with 403 once args validate but authorize denies", async () => {
    const authorize = vi.fn(async () => false);
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings panel",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "set_theme",
          description: "set theme",
          schema: z.object({ theme: z.enum(["light", "dark"]) }),
          authorize,
          handler: async () => ({}),
        },
      ],
    });
    const events: ServerActionEvent[] = [];
    const deps = buildDeps({
      registry,
      onActionEvent: (e) => {
        events.push(e);
      },
    });
    const res = await handleUpdateActionArgs(deps, updateReq({ theme: "dark" }));
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(events[0]?.kind).toBe("action.unauthorized");
  });
});

