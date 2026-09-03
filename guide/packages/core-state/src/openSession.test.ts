import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession, ChatStreamEvent } from "@freebirdai/core";
import { FreeBirdStore } from "./store.js";
import type { FreeBirdTransport } from "./transport/types.js";

/**
 * Switching conversations, which is what "new chat" is a special case of.
 *
 * The distinction that matters: what belonged to the *conversation* goes, what
 * belongs to the *workspace* stays. Someone who asks for a fresh chat has not
 * asked to be moved to a different tab.
 */

const session: ChatSession = {
  id: "s2",
  title: "T",
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const message = (id: string): ChatMessage => ({
  id,
  sessionId: "s1",
  role: "user",
  content: "hello",
  references: [],
  createdAt: new Date(),
});

const makeTransport = () => {
  const createSession = vi.fn(async () => session);
  const listMessages = vi.fn(async () => []);
  const streamMessage = vi.fn((): AsyncIterable<ChatStreamEvent> => ({
    async *[Symbol.asyncIterator]() {
      yield { kind: "assistant_saved" } as ChatStreamEvent;
    },
  }));
  return {
    transport: { createSession, listMessages, streamMessage } as unknown as FreeBirdTransport,
    createSession,
  };
};

describe("openSession", () => {
  it("points the store at another conversation", () => {
    const { transport } = makeTransport();
    const store = new FreeBirdStore(transport, { sessionId: "s1" });
    store.openSession("s2");
    expect(store.getState().sessionId).toBe("s2");
  });

  it("accepts null for no conversation yet", () => {
    const { transport } = makeTransport();
    const store = new FreeBirdStore(transport, { sessionId: "s1" });
    store.openSession(null);
    expect(store.getState().sessionId).toBeNull();
  });

  it("drops what the last conversation put on screen", () => {
    const { transport } = makeTransport();
    const store = new FreeBirdStore(transport, { sessionId: "s1" });
    store.setMessages([message("m1"), message("m2")]);
    store.setStreamingText("half a sentence");
    store.emitState("filter_changed", "Date range changed to Q3");

    store.openSession("s2");

    const state = store.getState();
    expect(state.messages).toEqual([]);
    expect(state.streamingText).toBe("");
    expect(state.streaming).toBe(false);
    expect(state.latestReferences).toEqual([]);
    expect(state.lastChatError).toBeNull();
    expect(state.pendingQuestion).toBeNull();
    expect(state.actionState.phase).toBe("idle");
    expect(state.actionState.journal).toEqual([]);
    // An unsent notice describes the board as the *last* conversation saw it.
    expect(store.pendingNotices()).toHaveLength(0);
  });

  it("leaves the workspace where it is", () => {
    // Asking for a fresh chat is not asking to be moved to another tab.
    const { transport } = makeTransport();
    const store = new FreeBirdStore(transport, { sessionId: "s1" });
    store.setActiveComponentIds(["orders", "profile"]);
    store.setLayout({ gridCols: 12, cells: [] });

    store.openSession("s2");

    expect(store.getState().activeComponentIds).toEqual(["orders", "profile"]);
    expect(store.getState().layout).not.toBeNull();
  });

  it("does not load the new conversation's messages itself", () => {
    // `useChat` refetches on an id change; two owners for one job is how they
    // drift apart.
    const { transport } = makeTransport();
    const store = new FreeBirdStore(transport, { sessionId: "s1" });
    store.openSession("s2");
    expect(transport.listMessages).not.toHaveBeenCalled();
  });

  it("leaves the old session on the server, neither saved nor deleted", () => {
    // The seam a chat history plugs into: nothing lists these yet, and
    // nothing destroys them either.
    const { transport } = makeTransport();
    const store = new FreeBirdStore(transport, { sessionId: "s1" });
    store.openSession("s2");
    expect(transport).not.toHaveProperty("deleteSession.mock");
    expect(transport.createSession).not.toHaveBeenCalled();
  });
});
