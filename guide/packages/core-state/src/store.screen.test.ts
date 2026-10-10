import type { ChatMessage, ChatStreamEvent } from "@freebirdai/core";
import { describe, expect, it, vi } from "vitest";
import { FreeBirdStore } from "./store.js";

/** A transport that records what each turn was sent and streams the given events. */
const transport = (events: ChatStreamEvent[] = [], confirm: Record<string, unknown> = { ok: true, recordId: "r1" }) => {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    impl: {
      async *streamMessage(input: Record<string, unknown>) {
        sent.push(input);
        for (const event of events) yield event;
      },
      confirmAction: vi.fn(async () => confirm),
    } as never,
  };
};

const outcome: ChatMessage = {
  id: "m9",
  sessionId: "s1",
  role: "assistant",
  content: "Showing now needs approval.",
  references: [],
  toolPayload: { citations: [{ componentId: "types", title: "Showing · Approval", directive: "highlight", page: "#/types" }] },
  createdAt: new Date(),
};

describe("what is on screen, and where the chat takes the person", () => {
  it("sends the focus with each turn, and stops once it is cleared", async () => {
    const t = transport();
    const store = new FreeBirdStore(t.impl, { sessionId: "s1" });
    store.setActiveComponentIds(["types"]);
    store.setFocus({ componentId: "types", itemId: "showing", label: "Showing" });
    await store.send("make this need approval");
    store.setFocus(null);
    await store.send("and the other one");
    expect(t.sent[0]).toMatchObject({ activeComponentIds: ["types"], focus: { componentId: "types", itemId: "showing", label: "Showing" } });
    expect(t.sent[1]?.focus).toBeUndefined();
  });

  it("hands a navigate event to its listeners, and a throwing listener spoils nothing", async () => {
    const target = { componentId: "types", title: "Appointment types", directive: "scroll-to" as const, page: "#/types" };
    const t = transport([{ kind: "navigate", navigation: target }]);
    const store = new FreeBirdStore(t.impl, { sessionId: "s1" });
    const heard: unknown[] = [];
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.onNavigate(() => {
      throw new Error("boom");
    });
    const stop = store.onNavigate((one) => heard.push(one));
    await store.send("take me to types");
    stop();
    await store.send("again");
    expect(heard).toEqual([target]);
    quiet.mockRestore();
  });

  it("shows the outcome message an approved action saved, chip and all", async () => {
    const t = transport([], { ok: true, recordId: "r1", result: {}, outcomeMessage: outcome });
    const store = new FreeBirdStore(t.impl, {
      sessionId: "s1",
      actionState: {
        phase: "awaiting_confirmation",
        pending: { recordId: "r1", componentId: "types", actionId: "update_type", args: {}, missing: [], requiresConfirmation: "preview", startedAt: new Date() },
        journal: [],
        workflowStack: [],
      },
    });
    await store.confirmAction();
    expect(store.getState().messages.map((one) => one.id)).toEqual(["m9"]);
  });
});
