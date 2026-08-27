import { describe, expect, it } from "vitest";
import {
  estimateOpenAiChatCostUsd,
  normalizeOpenAiModelId,
} from "./pricing.js";

describe("estimateOpenAiChatCostUsd", () => {
  it("returns a positive USD estimate for gpt-4o-mini", () => {
    const u = {
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    };
    expect(estimateOpenAiChatCostUsd("gpt-4o-mini", u)).toBeCloseTo(0.15, 5);
  });

  it("normalizes dated model ids", () => {
    const u = {
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    };
    expect(
      estimateOpenAiChatCostUsd("gpt-4o-mini-2024-07-18", u),
    ).toBeCloseTo(0.15, 5);
  });

  it("returns null for unknown models", () => {
    expect(
      estimateOpenAiChatCostUsd("unknown-model", {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      }),
    ).toBeNull();
  });
});

describe("normalizeOpenAiModelId", () => {
  it("strips YYYY-MM-DD suffix", () => {
    expect(normalizeOpenAiModelId("GPT-4o-2024-08-06")).toBe("gpt-4o");
  });
});
