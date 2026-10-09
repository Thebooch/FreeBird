import { describe, expect, it } from "vitest";
import { publicRouteOf } from "./route.js";
import { brandCss } from "./styles.js";
import { dayKey, instantIn, monthGrid, rangeOf, whenWords } from "./time.js";

const TOKEN = "Jb4zx75XimR3CDBX5EvkjfsLVuzGUkU1qthdv0j1fLI";

describe("public routes", () => {
  it("reads each page from its path, and nothing else", () => {
    expect(publicRouteOf(`/p/acme/book/${TOKEN}`)).toEqual({ kind: "book", workspace: "acme", token: TOKEN });
    expect(publicRouteOf("/p/acme/t/home-inspection")).toEqual({ kind: "type", workspace: "acme", slug: "home-inspection" });
    expect(publicRouteOf(`/p/acme/approve/${TOKEN}`, "?choice=suggest")).toEqual({ kind: "approve", workspace: "acme", token: TOKEN, choice: "suggest" });
    expect(publicRouteOf(`/p/acme/approve/${TOKEN}`, "?choice=delete")).toMatchObject({ choice: null });
    for (const path of ["/", "/p/acme", `/p/acme/book/short`, "/p/acme/t/Not_A_Slug", `/p/../book/${TOKEN}`, `/p/acme/book/${TOKEN}/extra`, `/x/acme/book/${TOKEN}`]) {
      expect(publicRouteOf(path)).toEqual({ kind: "none" });
    }
  });
});

describe("times on the public pages", () => {
  it("names days and times in the zone shown", () => {
    const start = "2026-10-13T14:00:00.000Z";
    expect(dayKey(start, "America/Chicago")).toBe("2026-10-13");
    expect(dayKey("2026-10-13T03:00:00.000Z", "America/Chicago")).toBe("2026-10-12");
    expect(rangeOf(start, "2026-10-13T15:00:00.000Z", "America/Chicago")).toBe("9:00 – 10:00 AM");
    expect(rangeOf("2026-10-13T16:30:00.000Z", "2026-10-13T17:30:00.000Z", "America/Chicago")).toBe("11:30 AM – 12:30 PM");
    expect(whenWords(start, "2026-10-13T15:00:00.000Z", "America/Chicago")).toBe("Tuesday, October 13 · 9:00 – 10:00 AM CDT");
  });

  it("turns a typed wall-clock time into its instant, either side of a clock change", () => {
    expect(new Date(instantIn("2026-10-14T10:00", "America/Chicago")!).toISOString()).toBe("2026-10-14T15:00:00.000Z");
    expect(new Date(instantIn("2026-11-02T10:00", "America/Chicago")!).toISOString()).toBe("2026-11-02T16:00:00.000Z");
    expect(instantIn("tomorrow", "America/Chicago")).toBeNull();
  });

  it("lays a month out in six weeks from the Sunday before it", () => {
    const grid = monthGrid(2026, 9);
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ key: "2026-09-27", day: 27, inMonth: false });
    expect(grid.filter((one) => one.inMonth)).toHaveLength(31);
  });
});

describe("the brand color", () => {
  it("writes the accent over the theme's, lighter on dark when it would be too dark to read", () => {
    const css = brandCss("#0f4d52");
    expect(css).toContain("--dash-accent: #0f4d52;");
    expect(css).toContain("--dash-accent-ink: #ffffff;");
    expect(css).toMatch(/prefers-color-scheme: dark\) \{ :root \.dash-root\.pub \{\s*--dash-accent: #(?!0f4d52)/);
    /* A light accent gets dark text on it. */
    expect(brandCss("#ffd43b")).toContain("--dash-accent-ink: #111316;");
  });
});
