// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@freebirdai/core";
import { ChatPanel } from "./ChatPanel.js";

const assistantMessage = (toolPayload: unknown): ChatMessage => ({
  id: "m1",
  sessionId: "s1",
  role: "assistant",
  content: "We're open weekdays.",
  references: [],
  toolPayload,
  createdAt: new Date(),
});

const knowledgePayload = {
  citations: [
    {
      componentId: "kb_ab12cd34ef56",
      title: "Opening hours",
      directive: "highlight",
      kind: "knowledge",
      selector: "#hours",
      page: "/about",
    },
    // Component citation without `kind` — absent must be treated as "component".
    {
      componentId: "contactForm",
      title: "Contact Form",
      directive: "highlight",
      selector: "#contact",
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "/about");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (el: React.ReactElement): void => {
  act(() => {
    root.render(el);
  });
};

describe("ChatPanel.Citations", () => {
  it("renders one chip per citation, tolerating payloads without kind", () => {
    render(<ChatPanel.Citations message={assistantMessage(knowledgePayload)} />);
    const chips = container.querySelectorAll("[data-freebird-chat-citation]");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toBe("Opening hours");
    expect(chips[0]!.getAttribute("data-kind")).toBe("knowledge");
    expect(chips[1]!.getAttribute("data-kind")).toBe("component");
  });

  it("renders nothing for non-assistant messages or empty payloads", () => {
    render(
      <ChatPanel.Citations
        message={{ ...assistantMessage(knowledgePayload), role: "user" }}
      />,
    );
    expect(container.querySelector("[data-freebird-chat-citations]")).toBeNull();

    render(<ChatPanel.Citations message={assistantMessage(undefined)} />);
    expect(container.querySelector("[data-freebird-chat-citations]")).toBeNull();

    render(<ChatPanel.Citations message={assistantMessage({ citations: "junk" })} />);
    expect(container.querySelector("[data-freebird-chat-citations]")).toBeNull();
  });

  it("activates a same-page citation on click (scrolls to the target)", async () => {
    const target = document.createElement("section");
    target.id = "hours";
    document.body.appendChild(target);

    render(<ChatPanel.Citations message={assistantMessage(knowledgePayload)} />);
    const chip = container.querySelector<HTMLButtonElement>(
      "[data-freebird-chat-citation]",
    )!;
    await act(async () => {
      chip.click();
    });
    expect(target.scrollIntoView).toHaveBeenCalled();
    target.remove();
  });

  it("routes cross-page citations through onCitationNavigate", async () => {
    window.history.replaceState(null, "", "/");
    const onCitationNavigate = vi.fn();
    render(
      <ChatPanel.Citations
        message={assistantMessage(knowledgePayload)}
        onCitationNavigate={onCitationNavigate}
      />,
    );
    const chip = container.querySelector<HTMLButtonElement>(
      "[data-freebird-chat-citation]",
    )!;
    await act(async () => {
      chip.click();
    });
    expect(onCitationNavigate).toHaveBeenCalledWith(
      "/about",
      expect.objectContaining({ componentId: "kb_ab12cd34ef56" }),
    );
  });
});

describe("ChatPanel.Message", () => {
  it("renders citation chips under the message content", () => {
    render(<ChatPanel.Message message={assistantMessage(knowledgePayload)} />);
    expect(container.textContent).toContain("We're open weekdays.");
    expect(
      container.querySelectorAll("[data-freebird-chat-citation]"),
    ).toHaveLength(2);
  });
});
