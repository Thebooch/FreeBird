import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession, ChatStreamEvent, StateNotice } from "@freebirdai/core";
import { buildNoticesPrompt } from "@freebirdai/core";
import { FreeBirdStore } from "../store.js";
import type { FreeBirdTransport } from "../transport/types.js";
import {
  COALESCE_WINDOW_MS,
  MAX_NOTICES,
  MAX_SUMMARY_CHARS,
  MAX_TOTAL_CHARS,
  appendNotice,
  emptyNoticeBuffer,
  flushNotices,
} from "./state.js";

const notice = (over: Partial<StateNotice> = {}): StateNotice => ({
  kind: "filter_changed",
  summary: "Date range changed to Q3",
  at: 1_000,
  ...over,
});

// ---------------------------------------------------------------------------
// The buffer
// ---------------------------------------------------------------------------

describe("appendNotice", () => {
  it("accumulates", () => {
    const b = appendNotice(appendNotice(emptyNoticeBuffer(), notice()), notice({ at: 2_000, summary: "Opened Orders" }));
    expect(b.notices).toHaveLength(2);
    expect(b.overflowed).toBe(false);
  });

  it("coalesces identical emissions inside the window", () => {
    // The flood this defends against: a slider firing on every pixel.
    let b = emptyNoticeBuffer();
    for (let i = 0; i < 20; i += 1) b = appendNotice(b, notice({ at: 1_000 + i * 10 }));
    expect(b.notices).toHaveLength(1);
    // Keeps the newest timestamp: what matters is when it last happened.
    expect(b.notices[0]?.at).toBe(1_190);
  });

  it("does not coalesce past the window", () => {
    const b = appendNotice(
      appendNotice(emptyNoticeBuffer(), notice()),
      notice({ at: 1_000 + COALESCE_WINDOW_MS + 1 }),
    );
    expect(b.notices).toHaveLength(2);
  });

  it("does not coalesce identical events separated by another event", () => {
    // Two real occurrences, not one repeated — collapsing them would lie
    // about the order things happened in.
    let b = appendNotice(emptyNoticeBuffer(), notice({ at: 1_000 }));
    b = appendNotice(b, notice({ at: 1_100, kind: "tab_opened", summary: "Opened Orders" }));
    b = appendNotice(b, notice({ at: 1_200 }));
    expect(b.notices).toHaveLength(3);
  });

  it("treats a differing detail as a different event", () => {
    let b = appendNotice(emptyNoticeBuffer(), notice({ detail: { range: "Q3" } }));
    b = appendNotice(b, notice({ at: 1_010, detail: { range: "Q4" } }));
    expect(b.notices).toHaveLength(2);
  });

  it("trims an oversized summary and flags the trim", () => {
    const b = appendNotice(emptyNoticeBuffer(), notice({ summary: "x".repeat(MAX_SUMMARY_CHARS + 50) }));
    expect(b.notices[0]!.summary).toHaveLength(MAX_SUMMARY_CHARS);
    expect(b.notices[0]!.summary.endsWith("...")).toBe(true);
    expect(b.overflowed).toBe(true);
  });

  it("drops the oldest past the count cap", () => {
    let b = emptyNoticeBuffer();
    for (let i = 0; i < MAX_NOTICES + 10; i += 1) {
      b = appendNotice(b, notice({ at: i * 10_000, summary: `event ${i}` }));
    }
    expect(b.notices).toHaveLength(MAX_NOTICES);
    // The most recent survive — they describe the state the next message
    // will be answered against.
    expect(b.notices[b.notices.length - 1]?.summary).toBe(`event ${MAX_NOTICES + 9}`);
    expect(b.overflowed).toBe(true);
  });

  it("drops the oldest past the character budget", () => {
    let b = emptyNoticeBuffer();
    for (let i = 0; i < 40; i += 1) {
      b = appendNotice(b, notice({ at: i * 10_000, summary: `${i}-${"y".repeat(400)}` }));
    }
    const total = b.notices.reduce((n, x) => n + x.summary.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    expect(b.overflowed).toBe(true);
  });
});

describe("flushNotices", () => {
  it("is empty for an empty buffer", () => {
    expect(flushNotices(emptyNoticeBuffer())).toEqual([]);
  });

  it("returns the notices when nothing was lost", () => {
    const b = appendNotice(emptyNoticeBuffer(), notice());
    expect(flushNotices(b)).toHaveLength(1);
  });

  it("prepends a visible marker when something was dropped", () => {
    // Truncated, never silently short: a model told nothing changed when
    // something did is worse off than one told the list is incomplete.
    let b = emptyNoticeBuffer();
    for (let i = 0; i < MAX_NOTICES + 5; i += 1) {
      b = appendNotice(b, notice({ at: i * 10_000, summary: `event ${i}` }));
    }
    const flushed = flushNotices(b);
    expect(flushed[0]?.kind).toBe("notices_truncated");
    expect(flushed[0]?.summary).toContain("incomplete");
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("buildNoticesPrompt", () => {
  it("is empty with no notices", () => {
    expect(buildNoticesPrompt([])).toBe("");
  });

  it("tells the model not to respond to them", () => {
    const out = buildNoticesPrompt([notice()]);
    expect(out).toContain("Date range changed to Q3");
    expect(out).toContain("do not acknowledge");
  });

  it("orders oldest first", () => {
    const out = buildNoticesPrompt([
      notice({ at: 2_000, summary: "second" }),
      notice({ at: 1_000, summary: "first" }),
    ]);
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
  });

  it("says so when it runs out of room", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      notice({ at: i, summary: `change number ${i} with some length to it` }),
    );
    const out = buildNoticesPrompt(many);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("omitted");
  });
});

// ---------------------------------------------------------------------------
// Through the store
// ---------------------------------------------------------------------------

const session: ChatSession = {
  id: "s1",
  title: "T",
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const assistant: ChatMessage = {
  id: "m1",
  sessionId: "s1",
  role: "assistant",
  content: "ok",
  references: [],
  createdAt: new Date(),
};

/** A transport that records every call and streams one trivial reply. */
const makeTransport = () => {
  const streamMessage = vi.fn((_input: unknown): AsyncIterable<ChatStreamEvent> => ({
    async *[Symbol.asyncIterator]() {
      yield { kind: "assistant_saved", assistantMessage: assistant } as ChatStreamEvent;
    },
  }));
  const transport = {
    createSession: async () => session,
    listMessages: async () => [],
    streamMessage,
  } as unknown as FreeBirdTransport;
  return { transport, streamMessage };
};

const storeWith = (transport: FreeBirdTransport) =>
  new FreeBirdStore(transport, { sessionId: "s1" });

describe("emitState in the store", () => {
  it("issues no request at all", async () => {
    // The property that matters: tier 1 is silent. Spying on the transport
    // rather than on visible effects, because "nothing rendered" would also
    // be true of a request that simply returned nothing.
    const { transport, streamMessage } = makeTransport();
    const store = storeWith(transport);

    store.emitState("filter_changed", "Date range changed to Q3");
    store.emitState("tab_opened", "Opened Orders");

    expect(streamMessage).not.toHaveBeenCalled();
    expect(store.getState().streaming).toBe(false);
    expect(store.pendingNotices()).toHaveLength(2);
  });

  it("carries them on the next turn and empties the buffer", async () => {
    const { transport, streamMessage } = makeTransport();
    const store = storeWith(transport);
    store.emitState("filter_changed", "Date range changed to Q3");

    await store.send("how are sales?");

    const sent = streamMessage.mock.calls[0]![0] as { notices?: StateNotice[] };
    expect(sent.notices?.map((n) => n.summary)).toEqual(["Date range changed to Q3"]);
    expect(store.pendingNotices()).toHaveLength(0);
  });

  it("sends no notices field when the host never emits", async () => {
    const { transport, streamMessage } = makeTransport();
    await storeWith(transport).send("hello");
    const sent = streamMessage.mock.calls[0]![0] as { notices?: StateNotice[] };
    expect(sent.notices).toBeUndefined();
  });

  it("keeps them when the turn fails", async () => {
    // A failed send must cost nothing: the model never saw them, so dropping
    // them would lose the fact that anything changed at all.
    const streamMessage = vi.fn(() => {
      throw new Error("network down");
    });
    const transport = {
      createSession: async () => session,
      listMessages: async () => [],
      streamMessage,
    } as unknown as FreeBirdTransport;

    const store = storeWith(transport);
    store.emitState("filter_changed", "Date range changed to Q3");

    await expect(store.send("hi")).rejects.toThrow("network down");
    expect(store.pendingNotices()).toHaveLength(1);
  });
});
