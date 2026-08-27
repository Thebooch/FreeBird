import { describe, expect, it } from "vitest";
import { createComponentRegistry } from "../components/registry.js";
import { buildKnowledgePrompt } from "./knowledge-context.js";

const registryWithKnowledge = () => {
  const registry = createComponentRegistry();
  registry.register({
    id: "hours",
    title: "Opening Hours",
    description: "Weekly hours.",
    grid: { minW: 4, minH: 3 },
    knowledge: [{ text: "Open Mon-Fri 9am-5pm." }],
    domAnchor: { selector: "#hours" },
  });
  registry.register({
    id: "policy",
    title: "Return Policy",
    description: "Returns within 30 days.",
    grid: { minW: 4, minH: 3 },
    knowledge: [
      { text: "Returns accepted within 30 days.", category: "Policy" },
      { text: "Receipt required.", category: "Policy" },
    ],
    domAnchor: { selector: "body" },
  });
  registry.register({
    id: "plain",
    title: "Plain",
    description: "No knowledge.",
    grid: { minW: 4, minH: 3 },
  });
  return registry;
};

describe("buildKnowledgePrompt", () => {
  it("lists knowledge grouped by component id", () => {
    const prompt = buildKnowledgePrompt(registryWithKnowledge());
    expect(prompt).toContain("## Site knowledge");
    expect(prompt).toContain("### Opening Hours (id: hours)");
    expect(prompt).toContain("Open Mon-Fri 9am-5pm.");
    expect(prompt).toContain("### Return Policy (id: policy)");
    expect(prompt).toContain("[Policy] Returns accepted within 30 days.");
    expect(prompt).not.toContain("### Plain");
  });

  it("returns empty string when no knowledge exists", () => {
    const registry = createComponentRegistry();
    registry.register({
      id: "x",
      title: "X",
      description: "No knowledge.",
      grid: { minW: 4, minH: 3 },
    });
    expect(buildKnowledgePrompt(registry)).toBe("");
  });

  it("truncates when exceeding maxChars", () => {
    const registry = createComponentRegistry();
    registry.register({
      id: "big",
      title: "Big",
      description: "Lots of text.",
      grid: { minW: 4, minH: 3 },
      knowledge: [{ text: "x".repeat(500) }],
      domAnchor: { selector: "body" },
    });
    // Budget must at least fit the instruction header, or the block is
    // dropped entirely (returns "") — 200 was below the header size.
    const prompt = buildKnowledgePrompt(registry, { maxChars: 400 });
    expect(prompt.length).toBeLessThanOrEqual(400);
    expect(prompt).toContain("## Site knowledge");
  });

  it("renders site knowledge items with bracketed ids and source refs", () => {
    const registry = registryWithKnowledge();
    registry.setKnowledge([
      {
        id: "kb_park01",
        text: "Free parking behind the building.",
        source: { page: "/visit", selector: "#parking", heading: "Parking" },
      },
      { text: "No id, still listed." },
    ]);
    const prompt = buildKnowledgePrompt(registry);
    expect(prompt).toContain("### Site knowledge");
    expect(prompt).toContain('- [kb_park01] Free parking behind the building. (source: /visit#parking "Parking")');
    expect(prompt).toContain("- No id, still listed.");
    // Component sections still present alongside.
    expect(prompt).toContain("### Opening Hours (id: hours)");
  });

  it("is non-empty when only site knowledge exists (no component knowledge)", () => {
    const registry = createComponentRegistry();
    registry.setKnowledge([
      { id: "kb_only", text: "Solo fact.", source: { page: "/" } },
    ]);
    const prompt = buildKnowledgePrompt(registry);
    expect(prompt).toContain("## Site knowledge");
    expect(prompt).toContain("- [kb_only] Solo fact. (source: /)");
  });

  it("respects maxChars across the site knowledge section too", () => {
    const registry = createComponentRegistry();
    registry.setKnowledge(
      Array.from({ length: 50 }, (_, i) => ({
        id: `kb_item${i}`,
        text: "y".repeat(200),
        source: { page: "/p" },
      })),
    );
    const prompt = buildKnowledgePrompt(registry, { maxChars: 600 });
    expect(prompt.length).toBeLessThanOrEqual(600);
  });
});
