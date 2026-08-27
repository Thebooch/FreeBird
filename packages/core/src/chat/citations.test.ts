import { describe, expect, it } from "vitest";
import { createComponentRegistry } from "../components/registry.js";
import { buildCitationsPrompt, extractCitations, CITE_MARKER_RE } from "./citations.js";

const registryWithHours = () => {
  const registry = createComponentRegistry();
  registry.register({
    id: "hours",
    title: "Opening Hours",
    description: "Weekly opening hours table.",
    grid: { minW: 4, minH: 3 },
    knowledge: [{ text: "Open Mon-Fri 9am-5pm." }],
    domAnchor: { selector: "#hours" },
  });
  registry.register({
    id: "contactForm",
    title: "Contact Form",
    description: "General contact form.",
    grid: { minW: 4, minH: 3 },
    domAnchor: { selector: "#contact-form", page: "/contact" },
  });
  // No domAnchor, no knowledge — should never be citable.
  registry.register({
    id: "internalOnly",
    title: "Internal Only",
    description: "Not locatable, not documented.",
    grid: { minW: 4, minH: 3 },
  });
  return registry;
};

const registryWithSiteKnowledge = () => {
  const registry = registryWithHours();
  registry.setKnowledge([
    {
      id: "kb_ab12cd34ef56",
      title: "Parking",
      text: "Free parking behind the building.",
      source: { page: "/visit", selector: "#parking", heading: "Parking" },
    },
    {
      id: "kb_pageonly0001",
      text: "We ship worldwide within 5 business days.",
      source: { page: "/shipping" },
    },
    // No source — informs the LLM but can never resolve to a citation.
    { id: "kb_nosource0001", text: "Founded in 1998." },
    // No id — not citable at all.
    { text: "The team is fully remote." },
  ]);
  return registry;
};

describe("CITE_MARKER_RE", () => {
  it("matches the [[cite:id]] syntax", () => {
    const matches = [...`Some text [[cite:hours]] more [[cite:contact-form_2]]`.matchAll(
      CITE_MARKER_RE,
    )].map((m) => m[1]);
    expect(matches).toEqual(["hours", "contact-form_2"]);
  });
});

describe("buildCitationsPrompt", () => {
  it("lists only components with a domAnchor or knowledge", () => {
    const prompt = buildCitationsPrompt(registryWithHours());
    expect(prompt).toContain("hours: Opening Hours");
    expect(prompt).toContain("contactForm: Contact Form");
    expect(prompt).not.toContain("internalOnly");
  });

  it("returns an empty string for a registry with nothing citable", () => {
    const registry = createComponentRegistry();
    registry.register({
      id: "plain",
      title: "Plain",
      description: "No anchor, no knowledge.",
      grid: { minW: 4, minH: 3 },
    });
    expect(buildCitationsPrompt(registry)).toBe("");
  });

  it("returns an empty string for an empty registry", () => {
    expect(buildCitationsPrompt(createComponentRegistry())).toBe("");
  });

  it("mentions site knowledge ids when citable knowledge exists", () => {
    const prompt = buildCitationsPrompt(registryWithSiteKnowledge());
    expect(prompt).toContain("Site knowledge items");
    expect(prompt).toContain("hours: Opening Hours");
  });

  it("is non-empty when only site knowledge is citable", () => {
    const registry = createComponentRegistry();
    registry.setKnowledge([
      { id: "kb_x1", text: "Fact.", source: { page: "/" } },
    ]);
    const prompt = buildCitationsPrompt(registry);
    expect(prompt).toContain("Site knowledge items");
    expect(prompt).not.toContain("Citable components:");
  });

  it("ignores id-less site knowledge for citability", () => {
    const registry = createComponentRegistry();
    registry.setKnowledge([{ text: "Fact without id." }]);
    expect(buildCitationsPrompt(registry)).toBe("");
  });
});

describe("extractCitations", () => {
  it("strips markers and resolves them against the registry", () => {
    const registry = registryWithHours();
    const { text, citations } = extractCitations(
      "We're open weekdays. [[cite:hours]]",
      registry,
    );
    expect(text).toBe("We're open weekdays.");
    expect(citations).toEqual([
      { componentId: "hours", title: "Opening Hours", directive: "highlight", selector: "#hours" },
    ]);
  });

  it("includes page when the component's domAnchor has one", () => {
    const registry = registryWithHours();
    const { citations } = extractCitations("Reach us here. [[cite:contactForm]]", registry);
    expect(citations).toEqual([
      {
        componentId: "contactForm",
        title: "Contact Form",
        directive: "highlight",
        selector: "#contact-form",
        page: "/contact",
      },
    ]);
  });

  it("drops citations for unknown component ids", () => {
    const registry = registryWithHours();
    const { text, citations } = extractCitations("Something. [[cite:doesNotExist]]", registry);
    expect(text).toBe("Something.");
    expect(citations).toEqual([]);
  });

  it("drops citations for components with no domAnchor (no selector to resolve)", () => {
    const registry = registryWithHours();
    const { text, citations } = extractCitations("Internal note. [[cite:internalOnly]]", registry);
    expect(text).toBe("Internal note.");
    expect(citations).toEqual([]);
  });

  it("dedupes repeated citations of the same component", () => {
    const registry = registryWithHours();
    const { citations } = extractCitations(
      "Open now. [[cite:hours]] Also see hours. [[cite:hours]]",
      registry,
    );
    expect(citations).toHaveLength(1);
  });

  it("leaves content unchanged and returns no citations when there are no markers", () => {
    const registry = registryWithHours();
    const { text, citations } = extractCitations("Just a plain reply.", registry);
    expect(text).toBe("Just a plain reply.");
    expect(citations).toEqual([]);
  });

  it("cleans up extra whitespace left behind after stripping trailing markers", () => {
    const registry = registryWithHours();
    const { text } = extractCitations(
      "Line one.\n\n[[cite:hours]]\n[[cite:contactForm]]",
      registry,
    );
    expect(text).toBe("Line one.");
  });

  it("resolves site knowledge ids into knowledge citations", () => {
    const registry = registryWithSiteKnowledge();
    const { text, citations } = extractCitations(
      "Park out back. [[cite:kb_ab12cd34ef56]]",
      registry,
    );
    expect(text).toBe("Park out back.");
    expect(citations).toEqual([
      {
        componentId: "kb_ab12cd34ef56",
        title: "Parking",
        directive: "highlight",
        kind: "knowledge",
        selector: "#parking",
        page: "/visit",
      },
    ]);
  });

  it("resolves page-only knowledge items (no selector)", () => {
    const registry = registryWithSiteKnowledge();
    const { citations } = extractCitations("Ships fast. [[cite:kb_pageonly0001]]", registry);
    expect(citations).toEqual([
      {
        componentId: "kb_pageonly0001",
        title: "We ship worldwide within 5 business days.",
        directive: "highlight",
        kind: "knowledge",
        page: "/shipping",
      },
    ]);
  });

  it("uses the source heading as the title fallback before text", () => {
    const registry = createComponentRegistry();
    registry.setKnowledge([
      {
        id: "kb_headed",
        text: "Long fact text here.",
        source: { page: "/a", selector: "#s", heading: "The Section" },
      },
    ]);
    const { citations } = extractCitations("Fact. [[cite:kb_headed]]", registry);
    expect(citations[0]!.title).toBe("The Section");
  });

  it("drops knowledge citations for items without a source", () => {
    const registry = registryWithSiteKnowledge();
    const { text, citations } = extractCitations("Old firm. [[cite:kb_nosource0001]]", registry);
    expect(text).toBe("Old firm.");
    expect(citations).toEqual([]);
  });

  it("prefers a component over a knowledge item when ids collide", () => {
    const registry = registryWithHours();
    // setKnowledge skips colliding ids, so even a forced collision resolves
    // to the component.
    registry.setKnowledge([
      { id: "hours", text: "Shadowed fact.", source: { page: "/x" } },
    ]);
    const { citations } = extractCitations("Open now. [[cite:hours]]", registry);
    expect(citations).toHaveLength(1);
    expect(citations[0]!.kind).toBeUndefined();
    expect(citations[0]!.title).toBe("Opening Hours");
  });
});
