import type { ChatMessage } from "@freebirdai/core";
import { describe, expect, it } from "vitest";
import { buildStream, dayLabel, mergeLive, reachesLatest, UNNAMED_TOPIC, withDay, type StreamDay } from "./stream.js";

const message = (id: string, topic: string, role: ChatMessage["role"] = "user"): ChatMessage => ({
  id,
  sessionId: topic,
  role,
  content: id,
  references: [],
  createdAt: new Date(),
});

const day = (on: string, messages: ChatMessage[], prev: string | null, next: string | null): StreamDay => ({ day: on, messages, prev, next });

describe("the chat stream", () => {
  const read = (items: ReturnType<typeof buildStream>): string[] =>
    items.map((item) =>
      item.kind === "message"
        ? `${item.message.id}${item.topicStart ? `^${item.topicStart}` : ""}`
        : item.kind === "topic"
          ? `#${item.name}`
          : `@${item.day}`,
    );

  it("heads each day, divides named topic changes, and adds live messages once", () => {
    const items = buildStream({
      days: [
        day("2026-10-06", [message("a", "rent"), message("b", "rent", "assistant")], null, "2026-10-07"),
        day("2026-10-07", [message("c", "rent"), message("d", "orders")], "2026-10-06", null),
      ],
      live: [message("d", "orders"), message("e", "orders", "assistant")],
      today: "2026-10-07",
      topics: { rent: "Rent", orders: "Work orders" },
    });
    expect(read(items)).toEqual([
      "@2026-10-06",
      "#Rent",
      "a^rent",
      "b",
      "@2026-10-07",
      // The same topic carrying on into a new day: the date says enough.
      "c^rent",
      "#Work orders",
      "d^orders",
      "e",
    ]);
  });

  it("never divides an unnamed topic, but still marks where it starts", () => {
    const items = buildStream({
      days: [
        day("2026-10-05", [message("a", "old1")], null, "2026-10-06"),
        day("2026-10-06", [message("b", "old2"), message("c", "rent"), message("d", "old3")], "2026-10-05", null),
      ],
      live: [],
      today: "2026-10-07",
      topics: { old1: UNNAMED_TOPIC, old2: UNNAMED_TOPIC, rent: "Rent" },
    });
    expect(read(items)).toEqual(["@2026-10-05", "a^old1", "@2026-10-06", "b^old2", "#Rent", "c^rent", "d^old3"]);
  });

  it("divides a named topic at the top of a day only when it differs from the one before", () => {
    const items = buildStream({
      days: [
        day("2026-10-05", [message("a", "rent")], null, "2026-10-06"),
        day("2026-10-06", [message("b", "orders")], "2026-10-05", null),
      ],
      live: [],
      today: "2026-10-07",
      topics: { rent: "Rent", orders: "Work orders" },
    });
    expect(read(items)).toEqual(["@2026-10-05", "#Rent", "a^rent", "@2026-10-06", "#Work orders", "b^orders"]);
  });

  it("does not repeat a name when another topic carries the same one", () => {
    const items = buildStream({
      days: [
        day("2026-10-05", [message("a", "rent1")], null, "2026-10-06"),
        day("2026-10-06", [message("b", "rent2")], "2026-10-05", null),
      ],
      live: [],
      today: "2026-10-07",
      topics: { rent1: "Rent roll", rent2: "Rent roll" },
    });
    expect(read(items)).toEqual(["@2026-10-05", "#Rent roll", "a^rent1", "@2026-10-06", "b^rent2"]);
  });

  it("leaves live messages off while the view sits on an earlier day", () => {
    const days = [day("2026-10-05", [message("a", "rent")], null, "2026-10-06")];
    expect(reachesLatest(days, "2026-10-07")).toBe(false);
    const items = buildStream({ days, live: [message("z", "now")], today: "2026-10-07", topics: {} });
    expect(items.some((item) => item.kind === "message" && item.message.id === "z")).toBe(false);
    // The latest day with messages is the bottom even when it was not today.
    expect(reachesLatest([day("2026-10-05", [], null, null)], "2026-10-07")).toBe(true);
  });

  it("keeps days in order and replaces a day loaded twice", () => {
    const days = withDay([day("2026-10-07", [], "2026-10-05", null)], day("2026-10-05", [], null, "2026-10-07"));
    expect(days.map((one) => one.day)).toEqual(["2026-10-05", "2026-10-07"]);
    expect(withDay(days, day("2026-10-07", [message("x", "t")], "2026-10-05", null))[1]!.messages).toHaveLength(1);
  });

  it("keeps what was said across a topic switch", () => {
    const kept = mergeLive([], [message("a", "rent")]);
    expect(mergeLive(kept, [message("b", "orders")]).map((one) => one.id)).toEqual(["a", "b"]);
  });

  it("names today and yesterday", () => {
    expect(dayLabel("2026-10-07", "2026-10-07")).toBe("Today");
    expect(dayLabel("2026-10-06", "2026-10-07")).toBe("Yesterday");
    expect(dayLabel("2026-09-30", "2026-10-01")).toBe("Yesterday");
    expect(dayLabel("2026-10-01", "2026-10-07")).not.toBe("Yesterday");
  });
});
