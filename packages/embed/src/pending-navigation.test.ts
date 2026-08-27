// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { buildLocalActionResult, type RegistrationManifest } from "@freebirdai/manifest";
import {
  PENDING_ACTION_KEY,
  readPendingNavigation,
  resolveSpeculativeResult,
  stashPendingNavigation,
} from "./pending-navigation.js";

describe("pending-navigation", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stashes crossPageReplay with the full action payload", () => {
    const result = buildLocalActionResult({
      directive: "scroll-to",
      componentId: "hours",
      selector: "#hours",
      page: "/contact",
      args: {},
    });
    stashPendingNavigation(result);
    expect(JSON.parse(sessionStorage.getItem(PENDING_ACTION_KEY)!)).toEqual({
      ...result,
      crossPageReplay: true,
    });
  });

  it("readPendingNavigation consumes the stash", () => {
    const result = buildLocalActionResult({
      directive: "highlight",
      componentId: "hours",
      selector: "#hours",
      args: {},
    });
    stashPendingNavigation(result);
    const pending = readPendingNavigation();
    expect(pending).toMatchObject({ componentId: "hours", crossPageReplay: true });
    expect(sessionStorage.getItem(PENDING_ACTION_KEY)).toBeNull();
  });
});

describe("resolveSpeculativeResult", () => {
  const manifest: RegistrationManifest = {
    version: 1,
    components: [
      {
        id: "contactHours",
        title: "Hours",
        description: "Hours on contact page.",
        kind: "dom-region",
        source: { selector: "#hours", page: "/contact" },
      },
      {
        id: "openingHours",
        title: "Opening hours",
        description: "Hours.",
        kind: "dom-region",
        source: { selector: "#hours" },
        actions: [
          {
            id: "highlight_hours",
            description: "Highlight",
            kind: "local-dom",
            directive: "highlight",
          },
        ],
      },
    ],
  };

  it("defaults cross-page actions to scroll-to when actions are absent client-side", () => {
    const result = resolveSpeculativeResult(manifest, {
      componentId: "contactHours",
      actionId: "show_component",
      args: {},
      currentPath: "/",
    });
    expect(result).toMatchObject({
      directive: "scroll-to",
      componentId: "contactHours",
      selector: "#hours",
      page: "/contact",
    });
  });

  it("uses the manifest action directive on the same page", () => {
    const result = resolveSpeculativeResult(manifest, {
      componentId: "openingHours",
      actionId: "highlight_hours",
      args: {},
      currentPath: "/",
    });
    expect(result?.directive).toBe("highlight");
  });
});
