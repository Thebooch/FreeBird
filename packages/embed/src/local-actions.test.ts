// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLocalActionResult, type RegistrationManifest } from "@freebirdai/manifest";
import { createLocalActionExecutor } from "./local-actions.js";
import { PENDING_ACTION_KEY } from "./pending-navigation.js";

const manifest: RegistrationManifest = {
  version: 1,
  components: [
    {
      id: "bookingForm",
      title: "Booking form",
      description: "Reservation form.",
      kind: "dom-region",
      source: { selector: "#book" },
      fields: [
        { name: "guests", selector: '[data-freebird-field="guests"]', description: "Guests" },
      ],
    },
    {
      id: "openingHours",
      title: "Opening hours",
      description: "Hours.",
      kind: "dom-region",
      source: { selector: "#hours" },
    },
    {
      id: "contactHours",
      title: "Contact page hours",
      description: "Hours shown on the contact page.",
      kind: "dom-region",
      source: { selector: "#hours", page: "/contact" },
    },
  ],
};

describe("createLocalActionExecutor", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <section id="hours">Mon-Fri 9-17</section>
      <form id="book">
        <input data-freebird-field="guests" name="guests" />
      </form>
    `;
    // happy-dom lacks scrollIntoView by default.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("fills form fields for a fill-form directive", () => {
    const executor = createLocalActionExecutor(() => manifest);
    const outcome = executor.execute(
      buildLocalActionResult({
        directive: "fill-form",
        componentId: "bookingForm",
        selector: "#book",
        args: { guests: 4 },
      }),
    );
    expect(outcome.ok).toBe(true);
    const input = document.querySelector<HTMLInputElement>('[data-freebird-field="guests"]')!;
    expect(input.value).toBe("4");
  });

  it("emits a card for show-in-chat and calls onCard", () => {
    const onCard = vi.fn();
    const executor = createLocalActionExecutor(() => manifest, { onCard });
    const outcome = executor.execute(
      buildLocalActionResult({
        directive: "show-in-chat",
        componentId: "openingHours",
        selector: "#hours",
        args: {},
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.card).toMatchObject({ componentId: "openingHours", title: "Opening hours" });
    expect(outcome.card?.text).toContain("Mon-Fri");
    expect(onCard).toHaveBeenCalledOnce();
  });

  it("adds a highlight class for a highlight directive", () => {
    const executor = createLocalActionExecutor(() => manifest);
    executor.execute(
      buildLocalActionResult({
        directive: "highlight",
        componentId: "openingHours",
        selector: "#hours",
        args: {},
      }),
    );
    expect(document.querySelector("#hours")!.classList.contains("freebird-highlight")).toBe(true);
  });

  it("fails gracefully when the component is not on the page", () => {
    const executor = createLocalActionExecutor(() => manifest);
    const outcome = executor.execute(
      buildLocalActionResult({
        directive: "scroll-to",
        componentId: "missing",
        args: {},
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("not found");
  });

  describe("cross-page navigation", () => {
    beforeEach(() => {
      sessionStorage.clear();
    });

    it("stashes the result and navigates instead of searching the current page", () => {
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
      const executor = createLocalActionExecutor(() => manifest);
      const result = buildLocalActionResult({
        directive: "scroll-to",
        componentId: "contactHours",
        selector: "#hours",
        page: "/contact",
        args: {},
      });

      const outcome = executor.execute(result);

      expect(outcome).toEqual({ ok: true, detail: "navigating" });
      expect(assign).toHaveBeenCalledWith("/contact");
      expect(JSON.parse(sessionStorage.getItem(PENDING_ACTION_KEY)!)).toEqual({
        ...result,
        crossPageReplay: true,
      });
      // Did NOT try (and fail) to find #hours on the current page — no
      // "not found" outcome, and the element was never touched.
      expect(document.querySelector("#hours")!.classList.contains("freebird-highlight")).toBe(
        false,
      );
    });

    it("does not navigate when the component's page matches the current one", () => {
      // Match whatever happy-dom's default location already is, rather than
      // mutating the global — window.location isn't safely reassignable
      // per-test and a stray mutation would leak into later tests.
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
      const executor = createLocalActionExecutor(() => manifest);

      const outcome = executor.execute(
        buildLocalActionResult({
          directive: "scroll-to",
          componentId: "openingHours",
          selector: "#hours",
          page: window.location.pathname,
          args: {},
        }),
      );

      expect(outcome.ok).toBe(true);
      expect(assign).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(PENDING_ACTION_KEY)).toBeNull();
    });

    it("does not navigate when the component has no page set", () => {
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
      const executor = createLocalActionExecutor(() => manifest);

      executor.execute(
        buildLocalActionResult({
          directive: "highlight",
          componentId: "openingHours",
          selector: "#hours",
          args: {},
        }),
      );

      expect(assign).not.toHaveBeenCalled();
    });

    it("uses the navigate hook instead of location.assign when provided", async () => {
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
      const navigate = vi.fn(() => true);
      const executor = createLocalActionExecutor(() => manifest, { navigate });
      const result = buildLocalActionResult({
        directive: "scroll-to",
        componentId: "contactHours",
        selector: "#hours",
        page: "/contact",
        args: {},
      });

      const outcome = await executor.executeAsync(result);

      expect(outcome).toEqual({ ok: true, detail: "navigating" });
      expect(navigate).toHaveBeenCalledWith("/contact");
      expect(assign).not.toHaveBeenCalled();
    });

    it("waits for a late-hydrated selector via executeAsync", async () => {
      document.body.innerHTML = "";
      const executor = createLocalActionExecutor(() => manifest);
      const promise = executor.executeAsync(
        buildLocalActionResult({
          directive: "highlight",
          componentId: "openingHours",
          selector: "#hours",
          args: {},
        }),
      );

      setTimeout(() => {
        document.body.innerHTML = '<section id="hours">Mon-Fri 9-17</section>';
      }, 80);

      const outcome = await promise;
      expect(outcome.ok).toBe(true);
      expect(document.querySelector("#hours")!.classList.contains("freebird-highlight")).toBe(
        true,
      );
    });
  });

  describe("knowledge-citation shapes (unknown componentId, selector/page carried)", () => {
    it("succeeds page-only when the target page matches but the selector is missing", () => {
      const executor = createLocalActionExecutor(() => manifest);
      const outcome = executor.execute(
        buildLocalActionResult({
          directive: "highlight",
          componentId: "kb_notacomponent",
          selector: "#gone-section",
          page: window.location.pathname,
          args: {},
        }),
      );
      expect(outcome).toEqual({ ok: true, detail: "page-only" });
    });

    it("succeeds page-only when the citation carries no selector at all", async () => {
      const executor = createLocalActionExecutor(() => manifest);
      const outcome = await executor.executeAsync(
        buildLocalActionResult({
          directive: "scroll-to",
          componentId: "kb_pageonly",
          page: window.location.pathname,
          args: {},
        }),
        { waitForSelector: false },
      );
      expect(outcome).toEqual({ ok: true, detail: "page-only" });
    });

    it("still fails for non-attention directives when the target is missing", () => {
      const executor = createLocalActionExecutor(() => manifest);
      const outcome = executor.execute(
        buildLocalActionResult({
          directive: "fill-form",
          componentId: "kb_notacomponent",
          selector: "#gone-form",
          page: window.location.pathname,
          args: { guests: 2 },
        }),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("not found");
    });

    it("resolves fragment ids that are invalid CSS selectors via safeQuery", () => {
      document.body.innerHTML += '<section id="2024-pricing">New pricing.</section>';
      const executor = createLocalActionExecutor(() => manifest);
      const outcome = executor.execute(
        buildLocalActionResult({
          directive: "highlight",
          componentId: "kb_pricing",
          selector: "#2024-pricing",
          args: {},
        }),
      );
      expect(outcome.ok).toBe(true);
      expect(
        document.getElementById("2024-pricing")!.classList.contains("freebird-highlight"),
      ).toBe(true);
    });

    it("replays cross-page knowledge citations after navigation (stash round-trip)", async () => {
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
      const executor = createLocalActionExecutor(() => manifest);
      const result = buildLocalActionResult({
        directive: "highlight",
        componentId: "kb_remote",
        selector: "#hours",
        page: "/visit",
        args: {},
      });
      const outcome = await executor.executeAsync(result);
      expect(outcome).toEqual({ ok: true, detail: "navigating" });
      expect(assign).toHaveBeenCalledWith("/visit");
      expect(JSON.parse(sessionStorage.getItem(PENDING_ACTION_KEY)!)).toEqual({
        ...result,
        crossPageReplay: true,
      });
    });
  });
});
