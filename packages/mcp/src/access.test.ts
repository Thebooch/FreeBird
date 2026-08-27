import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createComponentRegistry } from "@freebirdai/core";
import {
  actionRequiresMcpConfirmation,
  isActionExposed,
  isComponentReadable,
  listExposedActions,
  resolveToolAccess,
} from "./access.js";

describe("resolveToolAccess", () => {
  it("read-only allows metadata and data reads but not writes", () => {
    expect(resolveToolAccess("read-only")).toEqual({
      metadata: true,
      dataRead: true,
      write: false,
    });
  });

  it("write-only allows metadata and writes but not data reads", () => {
    expect(resolveToolAccess("write-only")).toEqual({
      metadata: true,
      dataRead: false,
      write: true,
    });
  });
});

describe("listExposedActions", () => {
  it("respects mcp.expose:false override", () => {
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "visible",
          description: "visible",
          schema: z.object({ x: z.string() }),
          handler: async () => ({}),
        },
        {
          id: "hidden",
          description: "hidden",
          schema: z.object({ x: z.string() }),
          handler: async () => ({}),
          mcp: { expose: false },
        },
      ],
    });

    const refs = listExposedActions(registry, "read-write").map((a) => a.actionId);
    expect(refs).toContain("visible");
    expect(refs).not.toContain("hidden");
  });
});

describe("isComponentReadable", () => {
  it("returns false when mcp.read is false", () => {
    const registry = createComponentRegistry();
    registry.register({
      id: "chart",
      title: "Chart",
      description: "Chart",
      grid: { minW: 4, minH: 3 },
      dataSource: async () => ({ ok: true }),
      mcp: { read: false },
    });
    expect(isComponentReadable(registry, "read-write", "chart")).toBe(false);
  });
});

describe("actionRequiresMcpConfirmation", () => {
  it("requires token for preview by default", () => {
    expect(
      actionRequiresMcpConfirmation({ requiresConfirmation: "preview" }),
    ).toBe(true);
  });

  it("allows auto execute when none and no override", () => {
    expect(actionRequiresMcpConfirmation({ requiresConfirmation: "none" })).toBe(
      false,
    );
  });

  it("forces confirmation when mcp.requireConfirmation is true", () => {
    expect(
      actionRequiresMcpConfirmation({
        requiresConfirmation: "none",
        mcp: { requireConfirmation: true },
      }),
    ).toBe(true);
  });
});

describe("isActionExposed", () => {
  it("returns false in read-only mode", () => {
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "go",
          description: "go",
          schema: z.object({}),
          handler: async () => ({}),
        },
      ],
    });
    expect(isActionExposed(registry, "read-only", "settings", "go")).toBe(false);
  });
});
