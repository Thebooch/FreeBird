import { describe, expect, it } from "vitest";
import { TRANSIENT_KEY, transientOf, withTransient, withoutTransient } from "./transient.js";

describe("values shown once", () => {
  it("ride on a result, are read back, and are dropped from what is kept", () => {
    const result = withTransient({ made: true }, { link: "https://x/p/a/book/secret" });
    expect(transientOf(result)).toEqual({ link: "https://x/p/a/book/secret" });
    expect(withoutTransient(result)).toEqual({ made: true });
    expect(JSON.stringify(withoutTransient(result))).not.toContain("secret");
  });

  it("are absent from results without them, and only strings count", () => {
    expect(transientOf({ made: true })).toBeNull();
    expect(transientOf(null)).toBeNull();
    expect(transientOf({ [TRANSIENT_KEY]: { n: 3 } })).toBeNull();
    expect(withoutTransient("text")).toBe("text");
    const plain = { made: true };
    expect(withoutTransient(plain)).toBe(plain);
  });
});
