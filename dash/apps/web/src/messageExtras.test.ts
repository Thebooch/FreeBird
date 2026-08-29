import type { ChatMessage } from "@freebirdai/core";
import { describe, expect, it } from "vitest";
import { citationsOf, coverageLabel, coverageOf, widgetIdOf } from "./MessageExtras.jsx";
import { SESSION_KEY, readStoredSession, writeStoredSession } from "./ChatSession.jsx";

/**
 * The footnotes under a reply, and the session that has to outlive a tab
 * change. Both are read out of shapes produced somewhere else, so what is
 * asserted is that the reading is defensive.
 */

const assistant = (toolPayload: unknown): ChatMessage =>
  ({
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content: "38 active leases.",
    createdAt: new Date(),
    toolPayload,
  }) as ChatMessage;

describe("citationsOf", () => {
  it("reads the chips the server resolved", () => {
    const message = assistant({
      citations: [
        {
          componentId: "leases",
          title: "Leases by status",
          directive: "highlight",
          selector: '[data-widget-id="leases"]',
          page: "#/d/ops",
        },
      ],
    });
    expect(citationsOf(message).map((c) => c.componentId)).toEqual(["leases"]);
  });

  it("is empty for a message that carries nothing", () => {
    expect(citationsOf(assistant(null))).toEqual([]);
    expect(citationsOf(assistant(undefined))).toEqual([]);
    expect(citationsOf(assistant({ extraTools: [] }))).toEqual([]);
  });
});

describe("widgetIdOf", () => {
  it("recovers the widget id from the anchor the server wrote", () => {
    expect(
      widgetIdOf({
        componentId: "leases--ops",
        title: "Leases",
        directive: "highlight",
        selector: '[data-widget-id="leases"]',
      }),
    ).toBe("leases");
  });

  /*
   * The component id and the widget id differ whenever two tabs share a widget
   * id, so the handle can never be used as the DOM id.
   */
  it("does not fall back to the component id", () => {
    expect(
      widgetIdOf({
        componentId: "leases--ops",
        title: "Leases",
        directive: "highlight",
        selector: "#something-else",
      }),
    ).toBeNull();
  });

  it("returns null when there is no selector at all", () => {
    expect(
      widgetIdOf({ componentId: "x", title: "X", directive: "highlight" }),
    ).toBeNull();
  });
});

describe("coverageOf", () => {
  const withCoverage = (payload: unknown) =>
    assistant({ toolPayloads: [{ tool: "answer_from_data", payload }] });

  it("reads what the harness said it looked at", () => {
    const note = coverageOf(
      withCoverage({
        kind: "coverage",
        scanned: 50,
        of: 412,
        orderedBy: "LeaseToDate",
        sources: ["Leases"],
      }),
    );
    expect(note).toEqual({
      scanned: 50,
      of: 412,
      orderedBy: "LeaseToDate",
      sources: ["Leases"],
    });
  });

  it("ignores a payload of another kind", () => {
    expect(coverageOf(withCoverage({ kind: "something-else", scanned: 5 }))).toBeNull();
  });

  it("is absent when the turn read nothing", () => {
    expect(coverageOf(assistant({ citations: [] }))).toBeNull();
    expect(coverageOf(assistant(null))).toBeNull();
  });
});

describe("coverageLabel", () => {
  const note = (over: Partial<ReturnType<typeof coverageOf>> = {}) => ({
    scanned: 50,
    of: 412,
    orderedBy: null,
    sources: [],
    ...over,
  });

  it('says "most recent" only when something really sorted them', () => {
    expect(coverageLabel(note({ orderedBy: "LeaseToDate" }))).toContain("most recent");
  });

  /*
   * With no sort, "the 50 most recent" is a claim about an order nobody
   * imposed — the exact overclaim the coverage note exists to prevent.
   */
  it("says first, not most recent, when nothing sorted them", () => {
    const label = coverageLabel(note());
    expect(label).toContain("first 50");
    expect(label).not.toContain("most recent");
  });
});

describe("the stored session", () => {
  const fake = (): Storage => {
    const map = new Map<string, string>();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  };

  it("round-trips an id so a reload continues the conversation", () => {
    const storage = fake();
    writeStoredSession("sess-1", storage);
    expect(readStoredSession(storage)).toBe("sess-1");
    expect(storage.getItem(SESSION_KEY)).toBe("sess-1");
  });

  it("treats an empty entry as no session rather than an empty one", () => {
    const storage = fake();
    storage.setItem(SESSION_KEY, "");
    expect(readStoredSession(storage)).toBeNull();
  });

  it("clears on null", () => {
    const storage = fake();
    writeStoredSession("sess-1", storage);
    writeStoredSession(null, storage);
    expect(readStoredSession(storage)).toBeNull();
  });

  it("survives storage that throws, rather than taking the chat down", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    } as unknown as Storage;
    expect(readStoredSession(hostile)).toBeNull();
    expect(() => writeStoredSession("x", hostile)).not.toThrow();
  });
});
