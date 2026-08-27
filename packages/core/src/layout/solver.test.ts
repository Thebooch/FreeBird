import { describe, it, expect } from "vitest";
import { createComponentRegistry } from "../components/registry.js";
import { solveLayout, pickSize } from "./solver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRegistry = () => {
  const r = createComponentRegistry();
  r.register({
    id: "a",
    title: "A",
    description: "component a",
    grid: { minW: 4, minH: 3, maxW: 12, defaultAspect: "wide" },
  });
  r.register({
    id: "b",
    title: "B",
    description: "component b",
    grid: { minW: 3, minH: 3, maxW: 6 },
  });
  r.register({
    id: "c",
    title: "C",
    description: "component c",
    grid: { minW: 3, minH: 2, maxW: 4, defaultAspect: "tall" },
  });
  return r;
};

/** Registry whose components use explicit size variants. */
const makeVariantRegistry = () => {
  const r = createComponentRegistry();
  r.register({
    id: "card",
    title: "Card",
    description: "a card with three size options",
    grid: {
      sizes: [
        { name: "compact",  w: 3,  h: 2, aspect: "wide"   },
        { name: "normal",   w: 6,  h: 4, aspect: "wide"   },
        { name: "expanded", w: 12, h: 6, aspect: "wide"   },
      ],
      preferredSize: "normal",
      minSize: "compact",
    },
  });
  r.register({
    id: "chart",
    title: "Chart",
    description: "a chart with two size options",
    grid: {
      sizes: [
        { name: "small",   w: 4,  h: 4, aspect: "square" },
        { name: "large",   w: 12, h: 6, aspect: "wide"   },
      ],
      // No preferredSize → defaults to largest ("large")
      minSize: "small",
    },
  });
  return r;
};

function assertNoOverlap(cells: { x: number; y: number; w: number; h: number }[]) {
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i]!;
      const b = cells[j]!;
      const overlap =
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      if (overlap) throw new Error(`cells ${i} and ${j} overlap`);
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy pickSize tests
// ---------------------------------------------------------------------------

describe("pickSize (legacy range path)", () => {
  it("returns square when requested", () => {
    const s = pickSize({ minW: 3, minH: 3, maxW: 8, maxH: 8 }, "square", 12);
    expect(s.w).toBe(s.h);
  });

  it("biases wide when hinted wide", () => {
    const s = pickSize({ minW: 3, minH: 3, maxW: 12 }, "wide", 12);
    expect(s.w).toBeGreaterThan(s.h);
  });

  it("respects maxW clamp", () => {
    const s = pickSize({ minW: 3, minH: 3, maxW: 6 }, "wide", 12);
    expect(s.w).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Legacy solveLayout tests (range path)
// ---------------------------------------------------------------------------

describe("solveLayout (legacy range path)", () => {
  it("places items without overlap", () => {
    const r = makeRegistry();
    const { plan, dropped } = solveLayout(r, {
      items: [
        { componentId: "a", importance: 5 },
        { componentId: "b", importance: 4 },
        { componentId: "c", importance: 3 },
      ],
    });
    expect(dropped).toHaveLength(0);
    expect(plan.cells).toHaveLength(3);
    assertNoOverlap(plan.cells);
  });

  it("drops unknown components with a reason", () => {
    const r = makeRegistry();
    const { dropped, plan } = solveLayout(r, {
      items: [{ componentId: "a" }, { componentId: "nope" }],
    });
    expect(dropped.map((d) => d.componentId)).toContain("nope");
    expect(plan.cells.map((c) => c.componentId)).toEqual(["a"]);
  });

  it("keeps locked cells in place and packs around them", () => {
    const r = makeRegistry();
    const locked = [
      {
        instanceId: "locked-1",
        componentId: "a",
        props: {},
        x: 0,
        y: 0,
        w: 6,
        h: 3,
        locked: true,
        importance: 5,
        orientation: "wide" as const,
      },
    ];
    const { plan, dropped } = solveLayout(
      r,
      { items: [{ componentId: "b" }, { componentId: "c" }] },
      { locked },
    );
    expect(dropped).toHaveLength(0);
    const lockedCell = plan.cells.find((c) => c.instanceId === "locked-1")!;
    expect(lockedCell.x).toBe(0);
    expect(lockedCell.y).toBe(0);
    expect(lockedCell.locked).toBe(true);
    assertNoOverlap(plan.cells);
  });

  it("sorts by importance", () => {
    const r = makeRegistry();
    const { plan } = solveLayout(r, {
      items: [
        { componentId: "c", importance: 1 },
        { componentId: "a", importance: 5 },
      ],
    });
    const aIdx = plan.cells.findIndex((c) => c.componentId === "a");
    const cIdx = plan.cells.findIndex((c) => c.componentId === "c");
    expect(aIdx).toBeLessThan(cIdx);
  });

  it("is deterministic", () => {
    const r = makeRegistry();
    const intent = {
      items: [
        { componentId: "a", importance: 3 },
        { componentId: "b", importance: 3 },
        { componentId: "c", importance: 3 },
      ],
    };
    const a = solveLayout(r, intent);
    const b = solveLayout(r, intent);
    const stripInstanceIds = (p: typeof a.plan) =>
      p.cells.map(({ instanceId, ...rest }) => rest);
    expect(stripInstanceIds(a.plan)).toEqual(stripInstanceIds(b.plan));
  });
});

// ---------------------------------------------------------------------------
// Explicit size-variant tests
// ---------------------------------------------------------------------------

describe("solveLayout (explicit sizes path)", () => {
  it("solo component gets the largest variant (fill dead space)", () => {
    const r = makeVariantRegistry();
    const { plan, dropped } = solveLayout(r, {
      items: [{ componentId: "card", importance: 3 }],
    });
    expect(dropped).toHaveLength(0);
    expect(plan.cells).toHaveLength(1);
    const cell = plan.cells[0]!;
    expect(cell.sizeVariant).toBe("expanded"); // largest
    expect(cell.w).toBe(12);
    expect(cell.h).toBe(6);
  });

  it("multi-component layout starts from preferredSize", () => {
    const r = makeVariantRegistry();
    const { plan, dropped } = solveLayout(r, {
      items: [
        { componentId: "card", importance: 5 },
        { componentId: "chart", importance: 3 },
      ],
    });
    expect(dropped).toHaveLength(0);
    expect(plan.cells).toHaveLength(2);
    assertNoOverlap(plan.cells);

    const cardCell = plan.cells.find((c) => c.componentId === "card")!;
    // "normal" (6×4) should fit alongside chart
    expect(cardCell.sizeVariant).toBe("normal");
  });

  it("falls back to a smaller variant when preferred does not fit", () => {
    const r = createComponentRegistry();
    // Component that spans the full width at "normal" size
    r.register({
      id: "wide",
      title: "Wide",
      description: "wide widget",
      grid: {
        sizes: [
          { name: "compact",  w: 3,  h: 2 },
          { name: "normal",   w: 12, h: 4 },
        ],
        preferredSize: "normal",
        minSize: "compact",
      },
    });
    // Burn the top row so "normal" (12×4) can't fit there
    const locked = [
      {
        instanceId: "blocker",
        componentId: "wide",
        props: {},
        x: 0, y: 0, w: 12, h: 4,
        locked: true,
        importance: 5,
        orientation: "wide" as const,
        sizeVariant: "normal",
      },
    ];
    const { plan, dropped } = solveLayout(
      r,
      { items: [{ componentId: "wide" }] },
      { locked, maxRows: 6 },
    );
    // The only remaining space is rows 4-5 (h=2) which fits "compact" (3×2)
    expect(dropped).toHaveLength(0);
    const cell = plan.cells.find((c) => !c.locked)!;
    expect(cell.sizeVariant).toBe("compact");
  });

  it("drops a component that cannot fit even at minSize", () => {
    const r = createComponentRegistry();
    r.register({
      id: "tiny",
      title: "Tiny",
      description: "tiny widget",
      grid: {
        sizes: [
          { name: "only", w: 12, h: 10 },
        ],
        minSize: "only",
      },
    });
    const { plan, dropped } = solveLayout(
      r,
      { items: [{ componentId: "tiny" }] },
      { maxRows: 4 }, // grid too short for w12×h10
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.componentId).toBe("tiny");
    expect(plan.cells).toHaveLength(0);
  });

  it("records the sizeVariant name on the GridCell", () => {
    const r = makeVariantRegistry();
    const { plan } = solveLayout(r, { items: [{ componentId: "chart" }] });
    const cell = plan.cells[0]!;
    expect(cell.sizeVariant).toBeDefined();
    expect(["small", "large"]).toContain(cell.sizeVariant);
  });

  it("places multiple variant components without overlap", () => {
    const r = makeVariantRegistry();
    const { plan, dropped } = solveLayout(r, {
      items: [
        { componentId: "card",  importance: 4 },
        { componentId: "chart", importance: 4 },
        { componentId: "card",  importance: 2 },
      ],
    });
    expect(dropped).toHaveLength(0);
    expect(plan.cells).toHaveLength(3);
    assertNoOverlap(plan.cells);
  });

  it("is deterministic with size variants", () => {
    const r = makeVariantRegistry();
    const intent = {
      items: [
        { componentId: "card",  importance: 3 },
        { componentId: "chart", importance: 3 },
      ],
    };
    const run1 = solveLayout(r, intent);
    const run2 = solveLayout(r, intent);
    const strip = (p: typeof run1.plan) =>
      p.cells.map(({ instanceId, ...rest }) => rest);
    expect(strip(run1.plan)).toEqual(strip(run2.plan));
  });
});

// ---------------------------------------------------------------------------
// Mixed registry (some with sizes, some without)
// ---------------------------------------------------------------------------

describe("solveLayout (mixed registry)", () => {
  it("handles a layout mixing legacy and variant components", () => {
    const r = createComponentRegistry();
    r.register({
      id: "legacy",
      title: "Legacy",
      description: "old-style",
      grid: { minW: 4, minH: 3, maxW: 8 },
    });
    r.register({
      id: "modern",
      title: "Modern",
      description: "new-style",
      grid: {
        sizes: [
          { name: "sm", w: 3, h: 3 },
          { name: "lg", w: 6, h: 4 },
        ],
        preferredSize: "sm",
      },
    });

    const { plan, dropped } = solveLayout(r, {
      items: [
        { componentId: "legacy", importance: 5 },
        { componentId: "modern", importance: 3 },
      ],
    });
    expect(dropped).toHaveLength(0);
    expect(plan.cells).toHaveLength(2);
    assertNoOverlap(plan.cells);

    const modernCell = plan.cells.find((c) => c.componentId === "modern")!;
    expect(modernCell.sizeVariant).toBeDefined();
    const legacyCell = plan.cells.find((c) => c.componentId === "legacy")!;
    expect(legacyCell.sizeVariant).toBeUndefined(); // legacy path sets no sizeVariant
  });
});
