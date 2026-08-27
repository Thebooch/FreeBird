import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createComponentRegistry, runAction } from "@freebirdai/core";

describe("runAction", () => {
  it("executes handler when args are valid and authorized", async () => {
    const handler = vi.fn(async () => ({ theme: "dark" }));
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings",
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

    const outcome = await runAction(registry, {
      componentId: "settings",
      actionId: "set_theme",
      args: { theme: "dark" },
      auth: { userId: "u1" },
      sessionId: "s1",
      recordId: "r1",
    });

    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed") {
      expect(outcome.result).toEqual({ theme: "dark" });
    }
    expect(handler).toHaveBeenCalledOnce();
  });

  it("returns validation_error with missing fields", async () => {
    const registry = createComponentRegistry();
    registry.register({
      id: "settings",
      title: "Settings",
      description: "Settings",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "set_theme",
          description: "set theme",
          schema: z.object({
            theme: z.enum(["light", "dark"]),
            channel: z.string(),
          }),
          handler: async () => ({}),
        },
      ],
    });

    const outcome = await runAction(registry, {
      componentId: "settings",
      actionId: "set_theme",
      args: { theme: "dark" },
      auth: { userId: "u1" },
      sessionId: "s1",
      recordId: "r1",
    });

    expect(outcome.kind).toBe("validation_error");
    if (outcome.kind === "validation_error") {
      expect(outcome.missing).toContain("channel");
    }
  });
});
