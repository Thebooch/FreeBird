import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  AuthContext,
  CustomTab,
  DataSourceContext,
} from "../types.js";
import { createComponentRegistry } from "../components/registry.js";
import { DigestEngine } from "./engine.js";

const tab: CustomTab = {
  id: "tab-1",
  title: "My tab",
  ownerId: "u1",
  layout: {
    gridCols: 12,
    cells: [
      {
        instanceId: "cell-1",
        componentId: "metrics",
        props: {},
        x: 0,
        y: 0,
        w: 6,
        h: 4,
        locked: true,
        importance: 3,
        orientation: "wide",
      },
    ],
  },
  digest: {
    intervalCron: "0 9 * * *",
    email: "u@example.com",
    format: "markdown",
  },
  createdAt: new Date("2026-04-01T00:00:00Z"),
  updatedAt: new Date("2026-04-01T00:00:00Z"),
};

const registry = (() => {
  const r = createComponentRegistry<unknown, AuthContext>();
  r.register({
    id: "metrics",
    title: "Metrics",
    description: "metrics widget",
    grid: { minW: 4, minH: 3 },
    propsSchema: z.object({}),
    dataSource: async (ctx: DataSourceContext<AuthContext>) => ({
      seenAuth: ctx.auth,
    }),
  });
  return r;
})();

const baseDeps = () => ({
  db: {
    updateTab: vi.fn(async () => tab),
    listDueDigests: vi.fn(async () => [tab]),
  } as any,
  email: {
    defaultFrom: "no-reply@example.com",
    send: vi.fn(async () => ({ id: "em-1" })),
  } as any,
  llm: {
    generate: vi.fn(async () => ({ text: "ok" })),
  } as any,
  registry,
});

describe("DigestEngine — refreshAuth", () => {
  it("calls refreshAuth between resolveAuth and dataSource, and uses the returned auth", async () => {
    const refreshAuth = vi.fn(async (saved: AuthContext): Promise<AuthContext> => ({
      ...saved,
      extra: { token: "fresh-token" },
    }));
    const deps = baseDeps();
    const dsSpy = vi.fn(async (ctx: DataSourceContext<AuthContext>) => ({
      seenAuth: ctx.auth,
    }));
    const r = createComponentRegistry<unknown, AuthContext>();
    r.register({
      id: "metrics",
      title: "Metrics",
      description: "metrics widget",
      grid: { minW: 4, minH: 3 },
      propsSchema: z.object({}),
      dataSource: dsSpy,
    });
    const engine = new DigestEngine({
      db: deps.db,
      email: deps.email,
      llm: deps.llm,
      registry: r,
      refreshAuth,
    });
    const result = await engine.runOne(tab);
    expect(result.sent).toBe(true);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    const callArgs = refreshAuth.mock.calls[0] as
      | [AuthContext, CustomTab]
      | undefined;
    expect(callArgs?.[0]).toEqual({ userId: "u1" });
    expect(callArgs?.[1]).toBe(tab);
    expect(dsSpy).toHaveBeenCalledTimes(1);
    expect(dsSpy.mock.calls[0]?.[0]?.auth).toEqual({
      userId: "u1",
      extra: { token: "fresh-token" },
    });
  });

  it("surfaces refreshAuth errors as a failed run (no email sent)", async () => {
    const deps = baseDeps();
    const refreshAuth = vi.fn(async () => {
      throw new Error("token mint failed");
    });
    const engine = new DigestEngine({
      db: deps.db,
      email: deps.email,
      llm: deps.llm,
      registry,
      refreshAuth,
    });
    const result = await engine.runOne(tab);
    expect(result.sent).toBe(false);
    expect(result.error).toContain("token mint failed");
    expect(deps.email.send).not.toHaveBeenCalled();
  });

  it("falls back to resolveAuth's value when no refreshAuth is configured", async () => {
    const deps = baseDeps();
    const dsSpy = vi.fn(async (ctx: DataSourceContext<AuthContext>) => ({
      seenAuth: ctx.auth,
    }));
    const r = createComponentRegistry<unknown, AuthContext>();
    r.register({
      id: "metrics",
      title: "Metrics",
      description: "metrics widget",
      grid: { minW: 4, minH: 3 },
      propsSchema: z.object({}),
      dataSource: dsSpy,
    });
    const engine = new DigestEngine({
      db: deps.db,
      email: deps.email,
      llm: deps.llm,
      registry: r,
      resolveAuth: () => ({ userId: "u1", extra: { source: "resolve" } }),
    });
    const result = await engine.runOne(tab);
    expect(result.sent).toBe(true);
    expect(dsSpy.mock.calls[0]?.[0]?.auth).toEqual({
      userId: "u1",
      extra: { source: "resolve" },
    });
  });
});
