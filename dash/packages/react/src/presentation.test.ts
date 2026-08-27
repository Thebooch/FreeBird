import { presentationSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { chromePresentationFor, presentationFor, presentationStyle } from "./presentation.js";

const look = (input: unknown) => presentationSchema.parse(input);

describe("presentationFor", () => {
  it("returns the shipped default when nothing overrides it", () => {
    const result = presentationFor(undefined, "table");
    expect(result.density).toBe("cozy");
    expect(result.settings["zebra"]).toBe(false);
  });

  /*
   * A part override replaces the whole part rather than patching it, so a
   * stored object mentioning one field would otherwise take every shipped
   * setting down with it. Layering the compiled-in default underneath is what
   * keeps a one-line override a one-line override.
   */
  it("keeps the shipped settings a partial stored override did not mention", () => {
    const result = presentationFor({ stored: { table: look({ density: "compact" }) } }, "table");
    expect(result.density).toBe("compact");
    expect(result.settings["zebra"]).toBe(false);
  });

  it("lets the board beat the stored part, and the widget beat the board", () => {
    const sources = {
      stored: { table: look({ settings: { zebra: true } }) },
      board: { table: look({ density: "comfortable" }) },
    };

    const boardLevel = presentationFor(sources, "table");
    expect(boardLevel.settings["zebra"]).toBe(true);
    expect(boardLevel.density).toBe("comfortable");

    const widgetLevel = presentationFor(sources, "table", look({ density: "compact" }));
    expect(widgetLevel.density).toBe("compact");
    // The widget said nothing about striping, so the stored answer stands.
    expect(widgetLevel.settings["zebra"]).toBe(true);
  });

  it("does not leak one component's look onto another", () => {
    const sources = { stored: { table: look({ density: "compact" }) } };
    expect(presentationFor(sources, "table").density).toBe("compact");
    expect(presentationFor(sources, "list").density).toBe("cozy");
  });

  it("falls back to an empty look for a component nothing ships a default for", () => {
    const result = presentationFor(undefined, "somethingCustom");
    expect(result.slots).toEqual({});
    expect(result.settings).toEqual({});
  });
});

describe("chromePresentationFor", () => {
  it("reads the frame's own entry, not the component's", () => {
    const sources = {
      stored: {
        widget: look({ settings: { border: false } }),
        table: look({ settings: { zebra: true } }),
      },
    };
    const chrome = chromePresentationFor(sources);
    expect(chrome.settings["border"]).toBe(false);
    expect(chrome.settings["zebra"]).toBeUndefined();
  });

  /*
   * Chrome slots and component slots share one namespace on a widget, because
   * their ids do not collide and asking someone to remember which half of an
   * object a switch belongs to is the worse trade.
   */
  it("applies a widget's own override to the frame as well as the component", () => {
    const widget = look({ slots: { title: { hidden: true } }, settings: { zebra: true } });
    expect(chromePresentationFor(undefined, widget).slots["title"]?.hidden).toBe(true);
    expect(presentationFor(undefined, "table", widget).settings["zebra"]).toBe(true);
  });
});

describe("presentationStyle", () => {
  it("is undefined when there are no tokens, so no style attribute is written", () => {
    expect(presentationStyle(look({}))).toBeUndefined();
  });

  it("emits the tokens as custom properties", () => {
    const style = presentationStyle(look({ tokens: { "--dash-radius": "2px" } }));
    expect(style).toEqual({ "--dash-radius": "2px" });
  });
});
