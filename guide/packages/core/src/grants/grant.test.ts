import { describe, it, expect } from "vitest";
import { canonicalize, digest } from "./digest.js";
import {
  actionCapability,
  connectionCapability,
  normalizeDeclaration,
  opCapability,
} from "./declaration.js";
import { addedCapabilities, widens } from "./widen.js";
import { createGrant, evaluateGrant, isGranted, type Grant } from "./grant.js";

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

describe("canonicalize", () => {
  it("is insensitive to key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ x: { d: 1, c: 2 } })).toBe(canonicalize({ x: { c: 2, d: 1 } }));
  });

  it("keeps array order, because order is meaning in a pipeline", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("drops undefined properties the way JSON does", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it("collapses undefined inside an array to null, as JSON does", () => {
    expect(canonicalize([undefined])).toBe("[null]");
  });

  it("has no JSON form for NaN or Infinity, so emits null", () => {
    expect(canonicalize({ n: Number.NaN })).toBe('{"n":null}');
    expect(canonicalize({ n: Number.POSITIVE_INFINITY })).toBe('{"n":null}');
  });

  it("serializes values that define toJSON, including Date", () => {
    const when = new Date("2026-09-02T00:00:00.000Z");
    expect(canonicalize({ when })).toBe('{"when":"2026-09-02T00:00:00.000Z"}');
  });

  it("refuses a value nested past the depth cap rather than hanging", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(/deeper than 100 levels/);
  });
});

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

describe("digest", () => {
  it("is stable across key order", () => {
    expect(digest({ b: 1, a: 2 })).toBe(digest({ a: 2, b: 1 }));
  });

  it("changes when any value changes", () => {
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });

  it("distinguishes a missing key from a null one", () => {
    expect(digest({ a: 1 })).not.toBe(digest({ a: 1, b: null }));
  });
});

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

describe("normalizeDeclaration", () => {
  it("sorts and deduplicates", () => {
    expect(normalizeDeclaration(["b", "a", "b"])).toEqual(["a", "b"]);
  });

  it("spells capabilities the same way for both products", () => {
    expect(connectionCapability("stripe")).toBe("connection:stripe");
    expect(opCapability("stripe", "charges.list")).toBe("op:stripe/charges.list");
    expect(actionCapability("invoice", "send")).toBe("action:invoice/send");
  });
});

describe("widens", () => {
  it("is true when a capability is added", () => {
    expect(widens(["a"], ["a", "b"])).toBe(true);
    expect(addedCapabilities(["a"], ["a", "b"])).toEqual(["b"]);
  });

  it("is false when a capability is dropped", () => {
    expect(widens(["a", "b"], ["a"])).toBe(false);
  });

  it("is false on reorder", () => {
    expect(widens(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("is false for an identical declaration", () => {
    expect(widens(["a", "b"], ["a", "b"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateGrant
// ---------------------------------------------------------------------------

const approved = (over: unknown, declaration: string[]): Grant =>
  createGrant({
    subject: "widget:revenue",
    digest: digest(over),
    declaration,
    now: new Date("2026-09-02T00:00:00.000Z"),
  });

describe("evaluateGrant", () => {
  const spec = { id: "revenue", source: { connection: "stripe", op: "charges.list" } };
  const declaration = [connectionCapability("stripe"), opCapability("stripe", "charges.list")];

  it("is absent when nothing was ever approved", () => {
    expect(
      evaluateGrant({ existing: null, digest: digest(spec), declaration }).verdict,
    ).toBe("absent");
  });

  it("is valid when digest and declaration both hold", () => {
    const grant = approved(spec, declaration);
    expect(evaluateGrant({ existing: grant, digest: digest(spec), declaration }).verdict).toBe(
      "valid",
    );
    expect(isGranted({ existing: grant, digest: digest(spec), declaration })).toBe(true);
  });

  it("is valid when the declaration is reordered", () => {
    const grant = approved(spec, declaration);
    const reordered = [...declaration].reverse();
    expect(
      evaluateGrant({ existing: grant, digest: digest(spec), declaration: reordered }).verdict,
    ).toBe("valid");
  });

  it("is digest-changed when the content is edited", () => {
    const grant = approved(spec, declaration);
    const edited = { ...spec, source: { connection: "stripe", op: "payouts.list" } };
    expect(
      evaluateGrant({ existing: grant, digest: digest(edited), declaration }).verdict,
    ).toBe("digest-changed");
  });

  it("is widened when unchanged content reaches further", () => {
    const grant = approved(spec, declaration);
    expect(
      evaluateGrant({
        existing: grant,
        digest: digest(spec),
        declaration: [...declaration, connectionCapability("hubspot")],
      }),
    ).toEqual({ verdict: "widened", added: ["connection:hubspot"] });
  });

  it("stays valid when the declaration shrinks — shrinking is not widening", () => {
    const grant = approved(spec, declaration);
    expect(
      evaluateGrant({
        existing: grant,
        digest: digest(spec),
        declaration: [connectionCapability("stripe")],
      }).verdict,
    ).toBe("valid");
  });

  it("reports digest-changed ahead of a shrunk declaration", () => {
    // The case the ordering exists for: a spec that quietly changed what it
    // reads has not widened by any set comparison, and is still not the thing
    // that was approved.
    const grant = approved(spec, declaration);
    const edited = { ...spec, id: "revenue-v2" };
    expect(
      evaluateGrant({
        existing: grant,
        digest: digest(edited),
        declaration: [connectionCapability("stripe")],
      }).verdict,
    ).toBe("digest-changed");
  });
});

describe("createGrant", () => {
  it("normalizes the declaration it stores", () => {
    const grant = createGrant({ subject: "s", digest: "d", declaration: ["b", "a", "b"] });
    expect(grant.declaration).toEqual(["a", "b"]);
  });

  it("omits grantedBy rather than storing undefined", () => {
    const grant = createGrant({ subject: "s", digest: "d", declaration: [] });
    expect("grantedBy" in grant).toBe(false);
  });
});
