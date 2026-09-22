import { describe, expect, it } from "vitest";
import {
  CATEGORY_VERSION,
  categorySchema,
  onboardingSchema,
  starterSchema,
} from "./category.js";
import { catalogEntrySchema } from "./dialect.js";
import { connectionSchema } from "./connection.js";
import { contractFor } from "./contracts.js";
import { solveLayout } from "./layout.js";

const brief = { entity: "lease", intent: "records" } as const;

describe("starterSchema", () => {
  it("defaults importance rather than requiring it", () => {
    const parsed = starterSchema.parse({ brief });
    expect(parsed.importance).toBe(3);
    expect(parsed.size).toBeUndefined();
  });

  it("carries a size by name, never a rectangle", () => {
    const parsed = starterSchema.parse({ brief, importance: 5, size: "lg" });
    expect(parsed.size).toBe("lg");
    expect(parsed).not.toHaveProperty("w");
  });

  it("refuses an importance outside 1-5", () => {
    expect(starterSchema.safeParse({ brief, importance: 9 }).success).toBe(false);
  });

  it("refuses a brief that is not one", () => {
    expect(starterSchema.safeParse({ brief: { entity: "lease" } }).success).toBe(false);
  });
});

describe("categorySchema", () => {
  it("round-trips a category with its starter set", () => {
    const parsed = categorySchema.parse({
      id: "leasing",
      title: "Leasing",
      description: "Agreements on units and the people applying for them.",
      entities: ["lease", "applicant"],
      starters: [{ brief, importance: 4 }],
    });
    expect(parsed.entities).toEqual(["lease", "applicant"]);
    expect(parsed.starters).toHaveLength(1);
  });

  it("starts with no starters, so the two passes can run apart", () => {
    const parsed = categorySchema.parse({ id: "leasing", title: "Leasing", entities: ["lease"] });
    expect(parsed.starters).toEqual([]);
  });

  /* A category holding nothing is not a choice — it is a heading with no
   * records behind it, and offering one is offering something unbuildable. */
  it("refuses a category with no record types", () => {
    expect(
      categorySchema.safeParse({ id: "leasing", title: "Leasing", entities: [] }).success,
    ).toBe(false);
  });
});

describe("catalogEntrySchema", () => {
  const entry = {
    id: "buildium",
    title: "Buildium",
    baseUrl: "https://api.buildium.com",
    dialect: {},
  };

  it("carries categories, a profile and its own progress", () => {
    const parsed = catalogEntrySchema.parse({
      ...entry,
      profile: { summary: "Property management software.", domain: "property management" },
      categories: [{ id: "leasing", title: "Leasing", entities: ["lease"] }],
      categoriesAt: "2026-09-21T00:00:00.000Z",
      categoryVersion: CATEGORY_VERSION,
      categoryProgress: { version: CATEGORY_VERSION, batches: ["abc"] },
    });
    expect(parsed.categories).toHaveLength(1);
    expect(parsed.profile?.domain).toBe("property management");
    expect(parsed.categoryProgress?.batches).toEqual(["abc"]);
  });

  /* Every entry written before this pass existed has to keep parsing: the
   * catalog is read on boot and a refusal would take the whole API with it. */
  it("parses an entry that has never been categorised", () => {
    const parsed = catalogEntrySchema.parse(entry);
    expect(parsed.categories).toEqual([]);
    expect(parsed.profile).toBeUndefined();
    expect(parsed.categoryVersion).toBeUndefined();
  });
});

describe("connectionSchema", () => {
  const connection = { id: "buildium", title: "Buildium", kind: "rest" as const };

  it("records what was chosen and the boards it made", () => {
    const parsed = connectionSchema.parse({
      ...connection,
      onboarding: {
        chose: ["leasing", "maintenance"],
        layout: "per-category",
        boards: [
          { category: "leasing", dashboard: "leasing" },
          { category: "maintenance", dashboard: "maintenance" },
        ],
        at: "2026-09-21T00:00:00.000Z",
      },
    });
    expect(parsed.onboarding?.chose).toEqual(["leasing", "maintenance"]);
    expect(parsed.onboarding?.boards).toHaveLength(2);
  });

  it("leaves a combined board belonging to no category", () => {
    const parsed = onboardingSchema.parse({
      chose: ["leasing", "maintenance"],
      layout: "single",
      boards: [{ dashboard: "buildium" }],
    });
    expect(parsed.boards[0]?.category).toBeUndefined();
  });

  it("parses a connection nobody has onboarded", () => {
    expect(connectionSchema.parse(connection).onboarding).toBeUndefined();
  });
});

describe("solveLayout with a requested size", () => {
  it("honours a variant the component declares", () => {
    const { cells } = solveLayout([
      { widgetId: "a", component: "stat", size: "lg" },
      { widgetId: "b", component: "stat" },
    ]);
    const asked = cells.find((cell) => cell.widgetId === "a");
    const lg = contractFor("stat")?.grid.sizes.find((size) => size.name === "lg");
    expect(asked?.sizeVariant).toBe("lg");
    expect([asked?.w, asked?.h]).toEqual([lg?.w, lg?.h]);
  });

  /* An unknown name is a cosmetic miss in a model-written starter set. It must
   * cost the size, never the widget. */
  it("ignores a variant the component does not declare", () => {
    const { cells, dropped } = solveLayout([
      { widgetId: "a", component: "stat", size: "enormous" },
      { widgetId: "b", component: "stat" },
    ]);
    expect(dropped).toEqual([]);
    expect(cells.find((cell) => cell.widgetId === "a")?.sizeVariant).toBe(
      contractFor("stat")?.grid.preferredSize,
    );
  });

  it("still packs inside the grid when everything asks to be large", () => {
    const { cells, dropped } = solveLayout(
      Array.from({ length: 6 }, (_, index) => ({
        widgetId: `w${index}`,
        component: "table" as const,
        size: "lg",
      })),
    );
    expect(dropped).toEqual([]);
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.w).toBeLessThanOrEqual(12);
    }
  });

  it("places the important one first", () => {
    const { cells } = solveLayout([
      { widgetId: "low", component: "stat", importance: 1 },
      { widgetId: "high", component: "stat", importance: 5 },
    ]);
    const high = cells.find((cell) => cell.widgetId === "high")!;
    const low = cells.find((cell) => cell.widgetId === "low")!;
    expect(high.y * 12 + high.x).toBeLessThan(low.y * 12 + low.x);
  });
});
