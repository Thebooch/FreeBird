import { describe, expect, it } from "vitest";
import {
  canonicalIds,
  diffManifestIds,
  mergeManifests,
  parseManifest,
  registrationManifestSchema,
  safeParseManifest,
  type RegistrationManifest,
} from "./index.js";

const valid: RegistrationManifest = {
  version: 1,
  siteId: "fb_test123",
  components: [
    {
      id: "openingHours",
      title: "Opening hours",
      description: "The restaurant's weekly opening hours table.",
      tags: ["hours", "contact"],
      kind: "dom-region",
      source: { selector: "#hours" },
      knowledge: ["Closed on public holidays."],
      fields: [{ name: "monday", selector: "[data-day=mon]", description: "Monday hours" }],
      actions: [
        {
          id: "show_hours",
          description: "Scroll the visitor to the opening hours",
          kind: "local-dom",
          directive: "scroll-to",
        },
      ],
    },
    {
      id: "bookingForm",
      title: "Booking form",
      description: "Table reservation form.",
      kind: "dom-region",
      source: { selector: "form#book" },
      actions: [
        {
          id: "request_booking",
          description: "File a booking request for the owner to review",
          kind: "server",
          server: { type: "file-ticket", ticketType: "feature", tags: ["booking"] },
          args: [
            { name: "partySize", type: "number", description: "Number of guests", required: true },
            { name: "notes", type: "string", description: "Special requests" },
          ],
        },
        {
          id: "notify_kitchen",
          description: "Send the request to the kitchen system",
          kind: "server",
          server: { type: "webhook", webhook: "kitchen" },
        },
      ],
    },
    {
      id: "aboutPage",
      title: "About us",
      description: "The About page content.",
      kind: "wp-content",
      source: { wpType: "page", wpId: 42 },
    },
    {
      id: "heroSection",
      title: "Hero",
      description: "Landing hero component.",
      kind: "framework-component",
      source: { file: "src/components/Hero.vue" },
      grid: {
        sizes: [{ name: "full", w: 12, h: 4, aspect: "wide" }],
        preferredSize: "full",
        minSize: "full",
      },
    },
  ],
};

describe("registrationManifestSchema", () => {
  it("accepts a manifest covering all three kinds", () => {
    expect(() => parseManifest(valid)).not.toThrow();
  });

  it("rejects duplicate component ids", () => {
    const dup = {
      ...valid,
      components: [valid.components[0], valid.components[0]],
    };
    expect(safeParseManifest(dup).success).toBe(false);
  });

  it("rejects a dom-region without a selector", () => {
    const bad = {
      version: 1,
      components: [
        {
          id: "x",
          title: "X",
          description: "d",
          kind: "dom-region",
          source: {},
        },
      ],
    };
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("rejects a framework-component without a file", () => {
    const bad = {
      version: 1,
      components: [
        {
          id: "x",
          title: "X",
          description: "d",
          kind: "framework-component",
          source: { selector: "#x" },
        },
      ],
    };
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("rejects a wp-content component without a wpType", () => {
    const bad = {
      version: 1,
      components: [
        { id: "x", title: "X", description: "d", kind: "wp-content", source: {} },
      ],
    };
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("rejects a local-dom action without a directive", () => {
    const bad = {
      version: 1,
      components: [
        {
          id: "x",
          title: "X",
          description: "d",
          kind: "dom-region",
          source: { selector: "#x" },
          actions: [{ id: "a", description: "d", kind: "local-dom" }],
        },
      ],
    };
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("rejects a server action carrying a directive", () => {
    const bad = {
      version: 1,
      components: [
        {
          id: "x",
          title: "X",
          description: "d",
          kind: "dom-region",
          source: { selector: "#x" },
          actions: [
            {
              id: "a",
              description: "d",
              kind: "server",
              server: { type: "webhook", webhook: "w" },
              directive: "click",
            },
          ],
        },
      ],
    };
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("rejects unknown manifest versions", () => {
    expect(safeParseManifest({ ...valid, version: 2 }).success).toBe(false);
  });

  it("accepts a dom-region with a page set (cross-page highlight/scroll-to)", () => {
    const withPage = {
      version: 1,
      components: [
        {
          id: "x",
          title: "X",
          description: "d",
          kind: "dom-region",
          source: { selector: "#x", page: "/contact" },
        },
      ],
    };
    expect(safeParseManifest(withPage).success).toBe(true);
  });

  it("still accepts a dom-region with no page (backward compatible — current page implied)", () => {
    expect(safeParseManifest(valid).success).toBe(true);
    expect(valid.components[0]!.source.page).toBeUndefined();
  });
});

describe("canonicalIds / diffManifestIds", () => {
  it("returns sorted unique ids", () => {
    expect(canonicalIds(valid)).toEqual([
      "aboutPage",
      "bookingForm",
      "heroSection",
      "openingHours",
    ]);
  });

  it("reports missing and extra ids", () => {
    const drift = diffManifestIds(valid, ["openingHours", "bookingForm", "rogue"]);
    expect(drift.missing).toEqual(["aboutPage", "heroSection"]);
    expect(drift.extra).toEqual(["rogue"]);
  });
});

describe("mergeManifests", () => {
  it("upserts by id with incoming winning", () => {
    const incoming: RegistrationManifest = {
      version: 1,
      components: [
        {
          id: "openingHours",
          title: "Hours (rescanned)",
          description: "Updated description.",
          kind: "dom-region",
          source: { selector: "#hours-v2" },
        },
        {
          id: "menu",
          title: "Menu",
          description: "Dinner menu.",
          kind: "dom-region",
          source: { selector: "#menu" },
        },
      ],
    };
    const merged = mergeManifests(valid, incoming);
    expect(merged.siteId).toBe("fb_test123");
    expect(canonicalIds(merged)).toEqual([
      "aboutPage",
      "bookingForm",
      "heroSection",
      "menu",
      "openingHours",
    ]);
    const hours = merged.components.find((c) => c.id === "openingHours")!;
    expect(hours.title).toBe("Hours (rescanned)");
    expect(hours.source.selector).toBe("#hours-v2");
  });

  it("preserves base knowledge when incoming carries none (embed handshake)", () => {
    const base: RegistrationManifest = {
      version: 1,
      components: [],
      knowledge: [
        { id: "kb_a", text: "Fact A.", source: { page: "/a" }, origin: "ingested" },
        "shorthand string fact",
      ],
    };
    const incoming: RegistrationManifest = {
      version: 1,
      components: [
        {
          id: "scanned",
          title: "Scanned",
          description: "From the embed scanner.",
          kind: "dom-region",
          source: { selector: "#scanned" },
        },
      ],
    };
    const merged = mergeManifests(base, incoming);
    expect(merged.knowledge).toEqual(base.knowledge);
    expect(merged.components).toHaveLength(1);
  });

  it("upserts knowledge by id and appends id-less items", () => {
    const base: RegistrationManifest = {
      version: 1,
      components: [],
      knowledge: [
        { id: "kb_a", text: "Old fact A." },
        { id: "kb_b", text: "Fact B." },
      ],
    };
    const incoming: RegistrationManifest = {
      version: 1,
      components: [],
      knowledge: [{ id: "kb_a", text: "New fact A." }, { text: "Anonymous fact." }],
    };
    const merged = mergeManifests(base, incoming);
    expect(merged.knowledge).toEqual([
      { id: "kb_b", text: "Fact B." },
      { id: "kb_a", text: "New fact A." },
      { text: "Anonymous fact." },
    ]);
  });
});

describe("manifest knowledge schema", () => {
  const withKnowledge = (knowledge: unknown) => ({
    version: 1,
    components: [
      {
        id: "hero",
        title: "Hero",
        description: "Top section.",
        kind: "dom-region",
        source: { selector: "#hero" },
      },
    ],
    knowledge,
  });

  it("accepts mixed string and rich knowledge items", () => {
    const parsed = parseManifest(
      withKnowledge([
        "plain string fact",
        {
          id: "kb_rich01",
          title: "Hours",
          text: "Open 9-5.",
          source: { page: "/about", selector: "#hours", heading: "Opening hours" },
          origin: "ingested",
        },
      ]),
    );
    expect(parsed.knowledge).toHaveLength(2);
  });

  it("accepts component-level rich knowledge items", () => {
    const parsed = parseManifest({
      version: 1,
      components: [
        {
          id: "hero",
          title: "Hero",
          description: "Top section.",
          kind: "dom-region",
          source: { selector: "#hero" },
          knowledge: ["shorthand", { text: "rich", category: "Tips" }],
        },
      ],
    });
    expect(parsed.components[0]!.knowledge).toHaveLength(2);
  });

  it("rejects duplicate knowledge ids", () => {
    const result = registrationManifestSchema.safeParse(
      withKnowledge([
        { id: "kb_dup", text: "One." },
        { id: "kb_dup", text: "Two." },
      ]),
    );
    expect(result.success).toBe(false);
  });

  it("rejects knowledge ids that collide with component ids", () => {
    const result = registrationManifestSchema.safeParse(
      withKnowledge([{ id: "hero", text: "Collides." }]),
    );
    expect(result.success).toBe(false);
  });
});
