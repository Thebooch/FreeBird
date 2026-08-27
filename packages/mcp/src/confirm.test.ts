import { describe, expect, it } from "vitest";
import { ConfirmationTokenStore, authFingerprint } from "./confirm.js";

describe("ConfirmationTokenStore", () => {
  it("issues and consumes a matching token once", () => {
    const store = new ConfirmationTokenStore(60_000);
    const args = { theme: "dark" };
    const fp = authFingerprint({ userId: "u1" });

    const token = store.issue({
      componentId: "settings",
      actionId: "set_theme",
      args,
      sessionId: "s1",
      authFingerprint: fp,
    });

    const ok = store.consume(token, {
      componentId: "settings",
      actionId: "set_theme",
      args,
      sessionId: "s1",
      authFingerprint: fp,
    });
    expect(ok).toEqual({ ok: true });

    const again = store.consume(token, {
      componentId: "settings",
      actionId: "set_theme",
      args,
      sessionId: "s1",
      authFingerprint: fp,
    });
    expect(again.ok).toBe(false);
  });

  it("rejects mismatched args", () => {
    const store = new ConfirmationTokenStore(60_000);
    const fp = authFingerprint({ userId: "u1" });
    const token = store.issue({
      componentId: "settings",
      actionId: "set_theme",
      args: { theme: "dark" },
      sessionId: "s1",
      authFingerprint: fp,
    });

    const result = store.consume(token, {
      componentId: "settings",
      actionId: "set_theme",
      args: { theme: "light" },
      sessionId: "s1",
      authFingerprint: fp,
    });
    expect(result.ok).toBe(false);
  });
});
