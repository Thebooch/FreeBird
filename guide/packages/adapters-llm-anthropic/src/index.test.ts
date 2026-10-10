import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@freebirdai/core";
import { splitSystem } from "./index.js";

const messages: LlmMessage[] = [
  { role: "system", content: "You help." },
  { role: "system", content: "Everything you can do.", cachePoint: true },
  { role: "system", content: "On screen now: the calendar." },
  { role: "user", content: "hi" },
];

describe("the system prompt as Anthropic takes it", () => {
  it("caches up to the cache point, and sends the same words", () => {
    const { system, messages: rest } = splitSystem(messages);
    expect(system).toEqual([
      { type: "text", text: "You help.\n\nEverything you can do.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "\n\nOn screen now: the calendar." },
    ]);
    expect((system as Array<{ text: string }>).map((block) => block.text).join("")).toBe(
      "You help.\n\nEverything you can do.\n\nOn screen now: the calendar.",
    );
    expect(rest).toEqual([{ role: "user", content: "hi" }]);
  });

  it("is one string with no cache point, or with caching off", () => {
    const plain = messages.map(({ cachePoint: _cachePoint, ...message }) => message);
    expect(splitSystem(plain).system).toBe("You help.\n\nEverything you can do.\n\nOn screen now: the calendar.");
    expect(splitSystem(messages, false).system).toBe("You help.\n\nEverything you can do.\n\nOn screen now: the calendar.");
  });
});
