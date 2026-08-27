// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { configFromScript, chatBaseUrl } from "./config.js";

const script = (attrs: Record<string, string>): HTMLScriptElement => {
  const el = document.createElement("script");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

describe("configFromScript", () => {
  it("reads a managed-backend config from data attributes", () => {
    const config = configFromScript(
      script({
        "data-site-id": "fb_abc123",
        "data-api": "https://api.freebird.cloud/",
        "data-title": "Ask Bella",
        "data-position": "bottom-left",
        "data-accent": "#b4231f",
      }),
    );
    expect(config.siteId).toBe("fb_abc123");
    expect(config.api).toBe("https://api.freebird.cloud"); // trailing slash trimmed
    expect(config.title).toBe("Ask Bella");
    expect(config.position).toBe("bottom-left");
    expect(config.accent).toBe("#b4231f");
    // snapshots default on when a siteId is present
    expect(config.snapshots).toBe(true);
    expect(chatBaseUrl(config)).toBe("https://api.freebird.cloud/freebird");
  });

  it("defaults to self-hosted mode with no siteId", () => {
    const config = configFromScript(script({}));
    expect(config.siteId).toBeUndefined();
    expect(config.api).toBe("");
    expect(config.snapshots).toBe(false);
    expect(config.autoScan).toBe(true);
    expect(chatBaseUrl(config)).toBe("/freebird");
  });

  it("honors scan/snapshots opt-outs", () => {
    const config = configFromScript(
      script({ "data-site-id": "fb_1", "data-scan": "false", "data-snapshots": "off" }),
    );
    expect(config.autoScan).toBe(false);
    expect(config.snapshots).toBe(false);
  });

  it("enables the action overlay for managed sites by default", () => {
    expect(configFromScript(script({ "data-site-id": "fb_1" })).actionOverlay).toBe(true);
    expect(configFromScript(script({ "data-action-overlay": "false", "data-site-id": "fb_1" })).actionOverlay).toBe(
      false,
    );
    expect(configFromScript(script({})).actionOverlay).toBe(false);
  });

  it("accepts the full-height sidebar positions", () => {
    expect(configFromScript(script({ "data-position": "full-right" })).position).toBe(
      "full-right",
    );
    expect(configFromScript(script({ "data-position": "full-left" })).position).toBe(
      "full-left",
    );
  });

  it("falls back to bottom-right for an unrecognized position", () => {
    expect(configFromScript(script({ "data-position": "top-center" })).position).toBe(
      "bottom-right",
    );
  });
});
