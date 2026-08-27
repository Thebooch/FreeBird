// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { ComponentCitation } from "@freebirdai/core";
import { FreeBirdStore } from "@freebirdai/core-state";
import type { FreeBirdTransport } from "@freebirdai/core-state";
import { defineChatElement, ELEMENT_TAG, type FreeBirdChatElement } from "./element.js";

const stubTransport = {} as FreeBirdTransport;

const mount = (
  toolPayload: unknown,
  onCiteClick = vi.fn<(citation: ComponentCitation) => void>(),
): { element: FreeBirdChatElement; onCiteClick: typeof onCiteClick } => {
  defineChatElement();
  const store = new FreeBirdStore(stubTransport, {
    sessionId: "s1",
    messages: [
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        content: "Our hours are on the contact page.",
        references: [],
        createdAt: new Date(),
        ...(toolPayload !== undefined ? { toolPayload } : {}),
      },
    ],
  });

  const element = document.createElement(ELEMENT_TAG) as FreeBirdChatElement;
  element.configure({
    store,
    title: "Chat",
    placeholder: "Ask…",
    position: "bottom-right",
    ensureSession: async () => {},
    onCiteClick,
  });
  document.body.appendChild(element);
  return { element, onCiteClick };
};

describe("FreeBirdChatElement — citation chips", () => {
  it("renders a chip per citation on an assistant message", () => {
    const citations: ComponentCitation[] = [
      { componentId: "hours", title: "Opening hours", directive: "highlight", selector: "#hours" },
    ];
    const { element } = mount({ citations });

    const chips = element.shadowRoot!.querySelectorAll(".citation-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toBe("Opening hours");
  });

  it("invokes onCiteClick with the citation when a chip is clicked", () => {
    const citations: ComponentCitation[] = [
      {
        componentId: "hours",
        title: "Opening hours",
        directive: "scroll-to",
        selector: "#hours",
        page: "/contact",
      },
    ];
    const { element, onCiteClick } = mount({ citations });

    const chip = element.shadowRoot!.querySelector<HTMLButtonElement>(".citation-chip")!;
    chip.click();

    expect(onCiteClick).toHaveBeenCalledOnce();
    expect(onCiteClick).toHaveBeenCalledWith(citations[0]);
  });

  it("renders multiple chips in order", () => {
    const citations: ComponentCitation[] = [
      { componentId: "a", title: "A", directive: "highlight", selector: "#a" },
      { componentId: "b", title: "B", directive: "scroll-to", selector: "#b" },
    ];
    const { element } = mount({ citations });

    const chips = [...element.shadowRoot!.querySelectorAll(".citation-chip")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["A", "B"]);
  });

  it("renders no chips when toolPayload has no citations", () => {
    const { element } = mount({ somethingElse: true });
    expect(element.shadowRoot!.querySelectorAll(".citation-chip")).toHaveLength(0);
  });

  it("renders no chips when toolPayload is undefined", () => {
    const { element } = mount(undefined);
    expect(element.shadowRoot!.querySelectorAll(".citation-chip")).toHaveLength(0);
  });

  it("does not throw on a malformed (non-array) citations payload", () => {
    const { element } = mount({ citations: "not-an-array" });
    expect(element.shadowRoot!.querySelectorAll(".citation-chip")).toHaveLength(0);
  });
});
