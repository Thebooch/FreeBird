import { describe, expect, it } from "vitest";
import {
  PRESENTATION_DEFAULTS,
  PRESENTATION_MANIFESTS,
  manifestFor,
  orderedSlots,
  presentationSchema,
  resolvePresentation,
  settingBool,
  settingNumber,
  slotLabel,
} from "./presentation.js";
import { COMPONENT_CONTRACTS } from "./contracts.js";
import { dashboardSchema, widgetSchema } from "./dashboard.js";

const parse = (input: unknown) => presentationSchema.parse(input);

describe("presentationSchema", () => {
  it("fills the containers so consumers never branch on undefined", () => {
    const result = parse({});
    expect(result.slots).toEqual({});
    expect(result.tokens).toEqual({});
    expect(result.settings).toEqual({});
  });

  it("refuses a token that is not one of ours", () => {
    expect(() => parse({ tokens: { "--other-accent": "#fff" } })).toThrow();
    expect(() => parse({ tokens: { color: "#fff" } })).toThrow();
    expect(parse({ tokens: { "--dash-radius": "4px" } }).tokens["--dash-radius"]).toBe("4px");
  });

  /*
   * The guard exists because these same objects are emitted into a <style>
   * element for board-level theming. A value carrying a semicolon or a brace
   * would end the declaration and begin writing rules of its own.
   */
  it("refuses a token value that could break out of a declaration", () => {
    expect(() => parse({ tokens: { "--dash-accent": "red; background: blue" } })).toThrow();
    expect(() => parse({ tokens: { "--dash-accent": "red} body {display:none" } })).toThrow();
    expect(() => parse({ tokens: { "--dash-accent": 'url("x")' } })).toThrow();
  });

  it("refuses map keys that would walk the prototype", () => {
    expect(() => parse({ slots: { __proto__: { hidden: true } } })).toThrow();
    expect(() => parse({ settings: { constructor: true } })).toThrow();
  });

  it("rides on a widget and on a dashboard", () => {
    const widget = widgetSchema.parse({
      id: "w1",
      title: "Rows",
      component: "table",
      source: { connection: "c", op: "o" },
      presentation: { density: "compact" },
    });
    expect(widget.presentation?.density).toBe("compact");

    const dashboard = dashboardSchema.parse({
      id: "d1",
      title: "Board",
      presentation: { table: { settings: { zebra: true } } },
    });
    expect(dashboard.presentation["table"]?.settings["zebra"]).toBe(true);
  });
});

describe("resolvePresentation", () => {
  it("takes the last layer that spoke, and skips the ones that did not", () => {
    const result = resolvePresentation([
      parse({ density: "cozy", variant: "card" }),
      undefined,
      parse({ density: "compact" }),
    ]);
    expect(result.density).toBe("compact");
    // The later layer said nothing about `variant`, so the earlier one stands.
    expect(result.variant).toBe("card");
  });

  it("merges slots by key rather than replacing the map", () => {
    const result = resolvePresentation([
      parse({ slots: { title: { order: 1 }, badges: { hidden: true } } }),
      parse({ slots: { title: { hidden: true } } }),
    ]);
    expect(result.slots["title"]).toEqual({ order: 1, hidden: true, settings: {} });
    // Untouched by the second layer, and still present.
    expect(result.slots["badges"]?.hidden).toBe(true);
  });

  /*
   * A one-field override must not silently reset the settings beside it — that
   * is the difference between "make this denser" and "reset this slot".
   */
  it("merges a slot's settings instead of overwriting them", () => {
    const result = resolvePresentation([
      parse({ slots: { header: { settings: { sticky: true, wrap: false } } } }),
      parse({ slots: { header: { settings: { wrap: true } } } }),
    ]);
    expect(result.slots["header"]?.settings).toEqual({ sticky: true, wrap: true });
  });

  it("layers tokens and settings independently", () => {
    const result = resolvePresentation([
      parse({ tokens: { "--dash-radius": "10px" }, settings: { zebra: false } }),
      parse({ tokens: { "--dash-gap": "8px" }, settings: { zebra: true } }),
    ]);
    expect(result.tokens).toEqual({ "--dash-radius": "10px", "--dash-gap": "8px" });
    expect(result.settings["zebra"]).toBe(true);
  });

  it("is empty for no layers at all", () => {
    const result = resolvePresentation([]);
    expect(result).toEqual({ slots: {}, tokens: {}, settings: {} });
  });
});

describe("readers", () => {
  it("falls back when a setting is absent or the wrong type", () => {
    const presentation = parse({ settings: { zebra: true, pageSize: "lots" } });
    expect(settingBool(presentation, "zebra", false)).toBe(true);
    expect(settingBool(presentation, "missing", true)).toBe(true);
    // A string where a number belongs is a fallback, not a coercion — silent
    // coercion is the class of wrongness this project exists to avoid.
    expect(settingNumber(presentation, "pageSize", 25)).toBe(25);
    expect(settingBool(undefined, "zebra", false)).toBe(false);
  });

  it("relabels a slot only when a label was given", () => {
    const presentation = parse({ slots: { title: { label: "Heading" } } });
    expect(slotLabel(presentation, "title", "Title")).toBe("Heading");
    expect(slotLabel(presentation, "badges", "Badges")).toBe("Badges");
  });

  it("orders by the declared order and keeps the given order as the tiebreak", () => {
    const presentation = parse({ slots: { actions: { order: -1 } } });
    expect(orderedSlots(presentation, ["title", "badges", "actions"])).toEqual([
      "actions",
      "title",
      "badges",
    ]);
    expect(orderedSlots(undefined, ["title", "badges"])).toEqual(["title", "badges"]);
  });
});

describe("manifests and defaults", () => {
  it("ships a default for every builtin component", () => {
    for (const id of Object.keys(COMPONENT_CONTRACTS)) {
      expect(PRESENTATION_DEFAULTS[id as keyof typeof PRESENTATION_DEFAULTS]).toBeDefined();
    }
  });

  it("parses every shipped default", () => {
    for (const [id, preset] of Object.entries(PRESENTATION_DEFAULTS)) {
      expect(() => presentationSchema.parse(preset), id).not.toThrow();
    }
  });

  /*
   * A manifest advertising a control nothing honours is worse than no
   * manifest: the toggle moves and nothing happens. Every setting a manifest
   * lists must therefore have a shipped default, which is what proves the
   * renderer was taught about it.
   */
  it("only advertises settings that have a shipped default", () => {
    for (const [id, preset] of Object.entries(PRESENTATION_DEFAULTS)) {
      const manifest = manifestFor(id);
      if (!manifest) continue;
      for (const setting of manifest.settings) {
        expect(preset.settings[setting.id], `${id}.${setting.id}`).toBeDefined();
      }
    }
  });

  it("declares enum values wherever it declares an enum setting", () => {
    for (const manifest of Object.values(PRESENTATION_MANIFESTS)) {
      for (const setting of manifest.settings) {
        if (setting.type !== "enum") continue;
        expect(setting.values?.length ?? 0, `${manifest.component}.${setting.id}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it("gives every manifested slot a label and a description", () => {
    for (const manifest of Object.values(PRESENTATION_MANIFESTS)) {
      for (const slot of manifest.slots) {
        expect(slot.label.length, `${manifest.component}.${slot.id}`).toBeGreaterThan(0);
        expect(slot.description.length, `${manifest.component}.${slot.id}`).toBeGreaterThan(0);
      }
    }
  });
});
