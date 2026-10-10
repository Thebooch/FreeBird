// @vitest-environment happy-dom
import type { ComponentCitation, PendingAction } from "@freebirdai/core";
import { revealSelector } from "@freebirdai/core";
import { DASH_SCREENS } from "@freebirdai/dash-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatActionCard, OnceCard, sidesOf } from "./ChatActionCard.jsx";
import { announceScreenChange, isScreenId } from "./agent/chatScreen.js";
import { settingSelectorOf, widgetIdOf } from "./MessageExtras.jsx";
import { showElement } from "./showWidget.js";

/**
 * What the chat puts in the column for a person to act on — the approval
 * card and the shown-once card — and how a citation on an approved change
 * finds the setting it names.
 */

const pending = (over: Partial<PendingAction> = {}): PendingAction =>
  ({
    recordId: "r1",
    componentId: DASH_SCREENS.types.id,
    actionId: "update_type",
    args: {},
    missing: [],
    ...over,
  }) as PendingAction;

const card = (props: Partial<Parameters<typeof ChatActionCard>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(ChatActionCard, {
      pending: pending(),
      executing: false,
      onApprove: () => undefined,
      onCancel: () => undefined,
      ...props,
    }),
  );

describe("sidesOf", () => {
  it("splits one change into its two sides", () => {
    expect(sidesOf("15 minutes → 30 minutes")).toEqual({ before: "15 minutes", after: "30 minutes" });
  });

  it("leaves a plain value, or more than one arrow, as it is", () => {
    expect(sidesOf("Anyone with the link")).toBeNull();
    expect(sidesOf("a → b → c")).toBeNull();
    expect(sidesOf(" → b")).toBeNull();
  });
});

describe("ChatActionCard", () => {
  it("shows the preview: where, what, and each change before and after", () => {
    const html = card({
      pending: pending({
        preview: {
          title: 'Change "Intro call"',
          summary: "Only these change.",
          rows: [
            { label: "Length", value: "15 minutes → 30 minutes" },
            { label: "Who can book", value: "Anyone" },
          ],
        },
      }),
    });
    expect(html).toContain("Needs your approval");
    expect(html).toContain("Appointment types");
    expect(html).toContain("Change &quot;Intro call&quot;");
    expect(html).toContain("Only these change.");
    expect(html).toContain('<span class="dash-action-card__before">15 minutes</span>');
    expect(html).toContain('<span class="dash-action-card__after">30 minutes</span>');
    expect(html).toContain("Anyone");
    expect(html).toContain("Approve");
  });

  it("falls back to the action's name and a given line when there is no preview", () => {
    const html = card({ pending: pending({ componentId: "board", actionId: "add_widget" }), fallbackSummary: 'Add "rent" to this dashboard.' });
    expect(html).toContain("add widget");
    expect(html).toContain("Add &quot;rent&quot; to this dashboard.");
    expect(html).not.toContain("dash-action-card__where");
  });

  it("reads as applying, and takes no second click, while it runs", () => {
    const html = card({ executing: true });
    expect(html).toContain("Applying…");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});

describe("OnceCard", () => {
  it("shows each value with a way to copy it, and says it is not kept", () => {
    const html = renderToStaticMarkup(
      createElement(OnceCard, { title: "Make your calendar feed link", values: { link: "webcal://x/feed", web: "https://x/feed" }, onDismiss: () => undefined }),
    );
    expect(html).toContain("Make your calendar feed link");
    expect(html).toContain("not kept");
    expect(html).toContain('value="webcal://x/feed"');
    expect(html).toContain('value="https://x/feed"');
    expect(html).toContain('data-testid="chat-once-copy-link"');
  });
});

describe("citations on screens", () => {
  const citation = (selector: string): ComponentCitation => ({ componentId: DASH_SCREENS.types.id, title: "Intro call", directive: "scroll-to", selector });

  it("rings a setting on a screen, not the screen as a whole", () => {
    const item = revealSelector({ component: DASH_SCREENS.types.id, item: "t1" });
    expect(settingSelectorOf(citation(item))).toBe(item);
    expect(settingSelectorOf(citation(revealSelector({ component: DASH_SCREENS.types.id })))).toBeNull();
    expect(settingSelectorOf(citation('[data-widget-id="rent"]'))).toBeNull();
    expect(widgetIdOf(citation(item))).toBeNull();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("waits for the setting to appear, then rings it", () => {
    vi.useFakeTimers();
    const selector = revealSelector({ component: DASH_SCREENS.types.id, item: "t1" });
    showElement(selector);
    document.body.innerHTML = `<section data-freebird-component="${DASH_SCREENS.types.id}"><div data-freebird-item="t1"></div></section>`;
    const row = document.querySelector("[data-freebird-item]") as HTMLElement;
    row.scrollIntoView = vi.fn();
    vi.advanceTimersByTime(100);
    expect(row.getAttribute("data-cited")).toBe("true");
    expect(row.scrollIntoView).toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(row.hasAttribute("data-cited")).toBe(false);
  });
});

describe("screen changes", () => {
  it("knows the screens by id", () => {
    expect(isScreenId(DASH_SCREENS.bookings.id)).toBe(true);
    expect(isScreenId("rent-roll")).toBe(false);
  });

  it("tells an open screen its data changed", () => {
    const heard: string[] = [];
    const listen = (event: Event) => heard.push((event as CustomEvent<string>).detail);
    window.addEventListener("dash:screen-changed", listen);
    announceScreenChange(DASH_SCREENS.contacts.id);
    window.removeEventListener("dash:screen-changed", listen);
    expect(heard).toEqual([DASH_SCREENS.contacts.id]);
  });
});
