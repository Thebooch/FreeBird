import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODE,
  allowsActions,
  clampConfirmation,
  isAtLeastAsRestrictive,
  isPermissionMode,
  narrowMode,
  resolveMode,
  type PermissionMode,
} from "./mode.js";

describe("permission modes", () => {
  it("orders the rungs by restrictiveness", () => {
    expect(isAtLeastAsRestrictive("readonly", "guarded")).toBe(true);
    expect(isAtLeastAsRestrictive("guarded", "guarded")).toBe(true);
    expect(isAtLeastAsRestrictive("full", "guarded")).toBe(false);
  });

  it("recognises its own values and nothing else", () => {
    expect(isPermissionMode("guarded")).toBe(true);
    expect(isPermissionMode("workspace")).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
  });

  it("defaults to ungated, so nothing changes without opting in", async () => {
    expect(DEFAULT_MODE).toBe("full");
    expect(await resolveMode(undefined, {})).toBe("full");
  });

  it("takes a fixed posture or resolves one per caller", async () => {
    expect(await resolveMode("guarded", {})).toBe("guarded");
    expect(
      await resolveMode((ctx) => (ctx.orgId === "acme" ? "readonly" : "full"), { orgId: "acme" }),
    ).toBe("readonly");
  });

  it("awaits an async resolver", async () => {
    expect(await resolveMode(async (): Promise<PermissionMode> => "guarded", {})).toBe("guarded");
  });
});

describe("narrowMode", () => {
  it("keeps the tenant posture when the session asks for nothing", () => {
    expect(narrowMode("guarded", undefined)).toEqual({ ok: true, mode: "guarded" });
  });

  it("lets a session tighten", () => {
    expect(narrowMode("guarded", "readonly")).toEqual({ ok: true, mode: "readonly" });
    expect(narrowMode("full", "guarded")).toEqual({ ok: true, mode: "guarded" });
  });

  it("allows an equal request", () => {
    expect(narrowMode("guarded", "guarded")).toEqual({ ok: true, mode: "guarded" });
  });

  it("rejects a widening request rather than clamping it", () => {
    const result = narrowMode("guarded", "full");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The message has to name both postures — a caller that got this wrong
    // needs to know what it asked for and what is actually in force.
    expect(result.reason).toContain("full");
    expect(result.reason).toContain("guarded");
  });

  it("rejects widening out of readonly", () => {
    expect(narrowMode("readonly", "guarded").ok).toBe(false);
    expect(narrowMode("readonly", "full").ok).toBe(false);
  });
});

describe("clampConfirmation", () => {
  it("leaves everything alone under full", () => {
    expect(clampConfirmation("full", "none")).toBe("none");
    expect(clampConfirmation("full", "preview")).toBe("preview");
    expect(clampConfirmation("full", "strict")).toBe("strict");
  });

  it("raises none to preview under guarded, and never lowers", () => {
    expect(clampConfirmation("guarded", "none")).toBe("preview");
    expect(clampConfirmation("guarded", "preview")).toBe("preview");
    expect(clampConfirmation("guarded", "strict")).toBe("strict");
  });

  it("is strict under readonly, as a backstop behind allowsActions", () => {
    expect(clampConfirmation("readonly", "none")).toBe("strict");
  });

  it("only ever tightens", () => {
    const rank = { none: 0, preview: 1, strict: 2 } as const;
    for (const mode of ["full", "guarded", "readonly"] as const) {
      for (const declared of ["none", "preview", "strict"] as const) {
        expect(rank[clampConfirmation(mode, declared)]).toBeGreaterThanOrEqual(rank[declared]);
      }
    }
  });
});

describe("allowsActions", () => {
  it("is false only for readonly", () => {
    expect(allowsActions("full")).toBe(true);
    expect(allowsActions("guarded")).toBe(true);
    expect(allowsActions("readonly")).toBe(false);
  });
});
