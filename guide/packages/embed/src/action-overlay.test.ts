// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { FreeBirdStore, createFetchTransport } from "@freebirdai/core-state";
import type { RegistrationManifest } from "@freebirdai/manifest";
import {
  createActionOverlay,
  messageForPending,
  peekOverlayActivity,
  stashOverlayActivity,
  clearOverlayActivity,
  wireActionOverlay,
} from "./action-overlay.js";

const manifest: RegistrationManifest = {
  version: 1,
  components: [
    {
      id: "openingHours",
      title: "Opening hours",
      description: "Hours.",
      kind: "dom-region",
      source: { selector: "#hours" },
      actions: [
        {
          id: "highlight",
          description: "Highlight",
          kind: "local-dom",
          directive: "highlight",
          requiresConfirmation: "none",
        },
      ],
    },
    {
      id: "contactHours",
      title: "Contact hours",
      description: "Hours on contact page.",
      kind: "dom-region",
      source: { selector: "#hours", page: "/contact" },
    },
  ],
};

describe("createActionOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    sessionStorage.clear();
  });

  it("shows and hides with a calm centered card", () => {
    const overlay = createActionOverlay({ accent: "#b4231f" });
    overlay.show("Working on Opening hours…");

    const root = document.getElementById("freebird-action-overlay")!;
    expect(root.hidden).toBe(false);
    expect(root.querySelector(".fb-overlay-message")?.textContent).toBe(
      "Working on Opening hours…",
    );
    expect(root.style.getPropertyValue("--freebird-overlay-accent")).toBe("#b4231f");

    overlay.hide();
    overlay.destroy();
    expect(document.getElementById("freebird-action-overlay")).toBeNull();
  });

  it("shows instantly without fade when restoring a stashed activity", () => {
    stashOverlayActivity({ message: "Taking you to Contact hours…" });
    const overlay = createActionOverlay();
    const stashed = peekOverlayActivity();
    overlay.showInstant(stashed!.message);
    overlay.lock();

    const root = document.getElementById("freebird-action-overlay")!;
    expect(root.getAttribute("data-instant")).toBe("true");
    expect(root.getAttribute("data-visible")).toBe("true");
    expect(root.hidden).toBe(false);

    overlay.unlock();
    overlay.hide();
    clearOverlayActivity();
    overlay.destroy();
  });
});

describe("messageForPending", () => {
  it("uses a navigation message when a page is set", () => {
    expect(messageForPending({ componentId: "contactHours", page: "/contact" }, manifest)).toBe(
      "Taking you to Contact hours…",
    );
  });
});

describe("wireActionOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    sessionStorage.clear();
  });

  it("shows on auto-confirm action.started", () => {
    const transport = createFetchTransport({ baseUrl: "https://example.test/freebird" });
    const store = new FreeBirdStore(transport);
    const wired = wireActionOverlay(store, { getManifest: () => manifest });

    store.applyActionTransition({
      type: "start",
      recordId: "rec_1",
      componentId: "openingHours",
      actionId: "highlight",
      requiresConfirmation: "none",
      at: new Date(),
    });

    const root = document.getElementById("freebird-action-overlay")!;
    expect(root.hidden).toBe(false);
    expect(root.querySelector(".fb-overlay-message")?.textContent).toContain("Opening hours");

    wired.destroy();
  });

  it("does not show while awaiting visitor confirmation", () => {
    const transport = createFetchTransport({ baseUrl: "https://example.test/freebird" });
    const store = new FreeBirdStore(transport);
    const wired = wireActionOverlay(store, { getManifest: () => manifest });

    store.applyActionTransition({
      type: "start",
      recordId: "rec_2",
      componentId: "openingHours",
      actionId: "highlight",
      requiresConfirmation: "preview",
      at: new Date(),
    });

    const root = document.getElementById("freebird-action-overlay");
    expect(root?.hasAttribute("data-visible")).toBe(false);

    wired.destroy();
  });
});
