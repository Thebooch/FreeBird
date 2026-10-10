// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createComponentRegistry, type ChatStreamEvent, type ComponentCitation } from "@freebirdai/core";
import { FreeBirdStore } from "@freebirdai/core-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreeBirdProvider } from "./provider.js";
import { revealElement, useNavigationRequests } from "./navigation.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** A transport whose one turn streams these events. */
const streaming = (events: ChatStreamEvent[]) =>
  ({
    async *streamMessage() {
      for (const event of events) yield event;
    },
  }) as never;

describe("useNavigationRequests", () => {
  it("hands over where the person asked to be taken, and nothing else", async () => {
    const target: ComponentCitation = { componentId: "types", title: "Appointment types", directive: "scroll-to", page: "#/types", selector: "#types" };
    const store = new FreeBirdStore(streaming([{ kind: "navigate", navigation: target }, { kind: "text_delta", textDelta: "Here." }]), { sessionId: "s1" });
    const heard: ComponentCitation[] = [];
    const Listener = () => {
      useNavigationRequests((one) => heard.push(one));
      return null;
    };
    act(() => root.render(<FreeBirdProvider registry={createComponentRegistry()} store={store}><Listener /></FreeBirdProvider>));
    await act(async () => {
      await store.send("take me to appointment types");
    });
    expect(heard).toEqual([target]);
  });
});

describe("revealElement", () => {
  it("waits for an element the page has not drawn yet, then scrolls to it and marks it for a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const shown = revealElement('[data-freebird-field="approval"]', { markMs: 1000 });
    const late = document.createElement("div");
    late.setAttribute("data-freebird-field", "approval");
    late.scrollIntoView = vi.fn();
    document.body.appendChild(late);
    expect(await shown).toBe(true);
    expect(late.scrollIntoView).toHaveBeenCalled();
    expect(late.hasAttribute("data-freebird-revealed")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(late.hasAttribute("data-freebird-revealed")).toBe(false);
    late.remove();
  });

  it("gives up quietly on what never appears, and on a selector that is not one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const missing = revealElement("#never-there", { timeoutMs: 50 });
    vi.advanceTimersByTime(60);
    expect(await missing).toBe(false);
    expect(await revealElement("[[not a selector", { timeoutMs: 10 })).toBe(false);
  });
});
