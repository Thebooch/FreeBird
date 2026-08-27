// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentCitation } from "../types.js";
import {
  activateCitation,
  readPendingCitation,
  replayPendingCitation,
  safeQuery,
  stashPendingCitation,
  PENDING_CITATION_KEY,
} from "./citation-dom.js";

const knowledgeCitation = (over: Partial<ComponentCitation> = {}): ComponentCitation => ({
  componentId: "kb_ab12cd34ef56",
  title: "Parking",
  directive: "highlight",
  kind: "knowledge",
  selector: "#parking",
  page: "/visit",
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = `
    <section id="parking"><h2>Parking</h2>Free parking behind the building.</section>
    <section id="2024-pricing">New pricing.</section>
  `;
  sessionStorage.clear();
  // happy-dom lacks scrollIntoView by default.
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "/visit");
});

describe("safeQuery", () => {
  it("resolves normal selectors", () => {
    expect(safeQuery(document, "#parking")?.id).toBe("parking");
  });

  it("falls back to getElementById for ids that are invalid CSS identifiers", () => {
    // "#2024-pricing" is not a valid CSS selector (ids can't start with a digit).
    expect(safeQuery(document, "#2024-pricing")?.id).toBe("2024-pricing");
  });

  it("returns null instead of throwing for garbage selectors", () => {
    expect(safeQuery(document, "!!]][[")).toBeNull();
  });
});

describe("activateCitation", () => {
  it("scrolls to and highlights the target on the same page", async () => {
    const outcome = await activateCitation(knowledgeCitation());
    expect(outcome).toEqual({ ok: true });
    const el = document.getElementById("parking")!;
    expect(el.scrollIntoView).toHaveBeenCalled();
  });

  it("treats a missing selector as page-only success", async () => {
    const outcome = await activateCitation(
      knowledgeCitation({ selector: undefined }),
    );
    expect(outcome).toEqual({ ok: true, detail: "page-only" });
  });

  it("degrades to target-missing when the selector resolves nothing", async () => {
    const outcome = await activateCitation(knowledgeCitation({ selector: "#gone" }));
    expect(outcome).toEqual({ ok: true, detail: "target-missing" });
  });

  it("stashes and calls onNavigate for a cross-page citation", async () => {
    window.history.replaceState(null, "", "/");
    const onNavigate = vi.fn();
    const outcome = await activateCitation(knowledgeCitation(), { onNavigate });
    expect(outcome).toEqual({ ok: true, detail: "navigating" });
    expect(onNavigate).toHaveBeenCalledWith("/visit", expect.objectContaining({
      componentId: "kb_ab12cd34ef56",
    }));
    expect(sessionStorage.getItem(PENDING_CITATION_KEY)).toBeTruthy();
  });

  it("hard-navigates when onNavigate returns false", async () => {
    window.history.replaceState(null, "", "/");
    const assign = vi.fn();
    vi.spyOn(window.location, "assign").mockImplementation(assign);
    const outcome = await activateCitation(knowledgeCitation(), {
      onNavigate: () => false,
    });
    expect(outcome).toEqual({ ok: true, detail: "navigating" });
    expect(assign).toHaveBeenCalledWith("/visit");
  });

  it("resolves component citations (no kind) identically", async () => {
    const outcome = await activateCitation({
      componentId: "hours",
      title: "Opening Hours",
      directive: "scroll-to",
      selector: "#parking",
    });
    expect(outcome).toEqual({ ok: true });
  });
});

describe("pending citation stash", () => {
  it("round-trips a citation and pops it on read", () => {
    stashPendingCitation(knowledgeCitation());
    expect(readPendingCitation()?.componentId).toBe("kb_ab12cd34ef56");
    expect(readPendingCitation()).toBeNull();
  });

  it("drops malformed stash entries", () => {
    sessionStorage.setItem(PENDING_CITATION_KEY, "{not json");
    expect(readPendingCitation()).toBeNull();
    sessionStorage.setItem(PENDING_CITATION_KEY, JSON.stringify({ citation: { nope: 1 } }));
    expect(readPendingCitation()).toBeNull();
  });

  it("drops stale stash entries", () => {
    sessionStorage.setItem(
      PENDING_CITATION_KEY,
      JSON.stringify({ citation: knowledgeCitation(), stashedAt: Date.now() - 120_000 }),
    );
    expect(readPendingCitation()).toBeNull();
  });
});

describe("replayPendingCitation", () => {
  it("returns null when nothing is pending", async () => {
    expect(await replayPendingCitation()).toBeNull();
  });

  it("scrolls to the stashed target after navigation", async () => {
    stashPendingCitation(knowledgeCitation());
    const outcome = await replayPendingCitation({ timeoutMs: 200 });
    expect(outcome).toEqual({ ok: true });
    expect(document.getElementById("parking")!.scrollIntoView).toHaveBeenCalled();
  });

  it("waits for late-hydrating targets", async () => {
    stashPendingCitation(knowledgeCitation({ selector: "#late" }));
    const pending = replayPendingCitation({ timeoutMs: 1_000 });
    setTimeout(() => {
      const el = document.createElement("div");
      el.id = "late";
      document.body.appendChild(el);
    }, 100);
    expect(await pending).toEqual({ ok: true });
  });

  it("degrades to target-missing on timeout", async () => {
    stashPendingCitation(knowledgeCitation({ selector: "#never" }));
    const outcome = await replayPendingCitation({ timeoutMs: 150 });
    expect(outcome).toEqual({ ok: true, detail: "target-missing" });
  });

  it("reports wrong-page instead of touching the DOM elsewhere", async () => {
    stashPendingCitation(knowledgeCitation({ page: "/elsewhere" }));
    const outcome = await replayPendingCitation({ timeoutMs: 150 });
    expect(outcome).toEqual({ ok: false, detail: "wrong-page" });
  });
});
