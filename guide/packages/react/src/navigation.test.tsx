// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createComponentRegistry, type ChatStreamEvent, type ComponentCitation } from "@freebirdai/core";
import { FreeBirdStore } from "@freebirdai/core-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FreeBirdProvider } from "./provider.js";
import { useNavigationRequests } from "./navigation.js";

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
