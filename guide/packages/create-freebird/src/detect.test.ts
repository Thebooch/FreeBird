import { describe, expect, it } from "vitest";
import { detectFramework, idsDeclaredIn, idsReferencedIn } from "./detect.js";

describe("detectFramework", () => {
  it("detects next over react", () => {
    expect(
      detectFramework({ dependencies: { next: "15", react: "18" } }, false),
    ).toBe("next");
  });
  it("detects vue", () => {
    expect(detectFramework({ dependencies: { vue: "3" } }, false)).toBe("vue");
  });
  it("detects react", () => {
    expect(detectFramework({ devDependencies: { react: "18" } }, false)).toBe("react");
  });
  it("falls back to static for a bare HTML site", () => {
    expect(detectFramework(null, true)).toBe("static");
    expect(detectFramework({ dependencies: {} }, false)).toBe("static");
  });
});

describe("idsReferencedIn / idsDeclaredIn", () => {
  it("parses FREEBIRD_IDS references from a registry file", () => {
    const src = `
      registry.register({ id: FREEBIRD_IDS.heroSection });
      registry.register({ id: FREEBIRD_IDS.pricingTable });
    `;
    expect(idsReferencedIn(src)).toEqual(["heroSection", "pricingTable"]);
  });

  it("parses declared keys from an ids.ts map", () => {
    const src = `
export const FREEBIRD_IDS = {
  heroSection: "heroSection",
  pricingTable: "pricingTable",
} as const;
`;
    expect(idsDeclaredIn(src)).toEqual(["heroSection", "pricingTable"]);
  });

  it("returns empty when no map is present", () => {
    expect(idsDeclaredIn("export const x = 1;")).toEqual([]);
  });
});
