import type { LlmAdapter, LlmTokenUsage } from "@freebirdai/dash-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmSpend, meter, resetLlmSpend } from "./llm.js";

/**
 * The cost line, and the total behind it.
 *
 * Worth testing rather than eyeballing: the number is the whole feature, and
 * a total that drifts is worse than no total — it reads as authoritative.
 */

const lines: string[] = [];

beforeEach(() => {
  resetLlmSpend();
  lines.length = 0;
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
});

afterEach(() => vi.restoreAllMocks());

const fake = (usage: LlmTokenUsage | undefined, model = "claude-opus-5"): LlmAdapter => ({
  defaultModel: model,
  generate: async () => ({ text: "ok", toolCalls: [], model, ...(usage ? { usage } : {}) }),
  stream: async function* () {
    yield { textDelta: "ok" };
    if (usage) yield { usage, model };
  },
});

const usage = (over: Partial<LlmTokenUsage> = {}): LlmTokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  ...over,
});

describe("metering a model call", () => {
  it("names the action, the model, the tokens and the cost", async () => {
    const adapter = meter(fake(usage({ promptTokens: 200_000, completionTokens: 20_000 })), "chat");
    await adapter.generate({ messages: [] });

    // 200k in @ $5/M + 20k out @ $25/M = $1.00 + $0.50
    expect(lines[0]).toContain("[llm] chat · claude-opus-5");
    expect(lines[0]).toContain("in 200,000");
    expect(lines[0]).toContain("out 20,000");
    expect(lines[0]).toContain("$1.50");
    expect(llmSpend()).toMatchObject({ usd: 1.5, calls: 1, unpriced: 0 });
  });

  it("accumulates across calls so a turn's total is visible", async () => {
    const adapter = meter(fake(usage({ promptTokens: 1_000_000 })), "suggest");
    await adapter.generate({ messages: [] });
    await adapter.generate({ messages: [] });
    expect(llmSpend()).toMatchObject({ usd: 10, calls: 2 });
    expect(lines[1]).toContain("session $10.00 over 2 calls");
  });

  it("shows the cache split only when there is one", async () => {
    const plain = meter(fake(usage({ promptTokens: 100 })), "chat");
    await plain.generate({ messages: [] });
    expect(lines[0]).not.toContain("cached");

    const cached = meter(fake(usage({ promptTokens: 100, cachedPromptTokens: 90 })), "chat");
    await cached.generate({ messages: [] });
    expect(lines[1]).toContain("cached 90");
  });

  it("counts an unpriced model rather than scoring it as free", async () => {
    const adapter = meter(fake(usage({ promptTokens: 1_000 }), "future-model"), "chat");
    await adapter.generate({ messages: [] });
    expect(lines[0]).toContain("unpriced");
    expect(llmSpend()).toMatchObject({ usd: 0, calls: 1, unpriced: 1 });
  });

  it("says so when the provider reported no usage at all", async () => {
    // A silent skip would make the running total quietly too low, which is
    // worse than a visible gap.
    const adapter = meter(fake(undefined), "chat");
    await adapter.generate({ messages: [] });
    expect(lines[0]).toContain("no usage reported");
    expect(llmSpend()).toMatchObject({ calls: 1, unpriced: 1 });
  });

  it("bills a stream once it ends, from its late usage chunk", async () => {
    const adapter = meter(fake(usage({ promptTokens: 1_000_000 })), "chat");
    for await (const _chunk of adapter.stream({ messages: [] })) void _chunk;
    expect(llmSpend()).toMatchObject({ usd: 5, calls: 1 });
  });

  it("still reports a stream the caller abandoned part-way", async () => {
    /*
     * An abandoned stream has already burned prompt tokens. Reporting only on
     * clean completion hides exactly the calls worth seeing.
     */
    const adapter = meter(fake(usage({ promptTokens: 1_000_000 })), "chat");
    for await (const _chunk of adapter.stream({ messages: [] })) break;
    expect(llmSpend().calls).toBe(1);
    expect(lines[0]).toContain("no usage reported");
  });
});

/**
 * The same totals, split by which action spent them.
 *
 * "AI cost $4.10" cannot be acted on and "building widgets cost $3.90 of it"
 * can — which is the whole reason to route the actions separately at all.
 */
describe("spend per task", () => {
  it("keeps a tally under each action's own name", async () => {
    const chat = meter(fake(usage({ promptTokens: 1_000_000 })), "chat");
    const widget = meter(fake(usage({ promptTokens: 2_000_000 })), "widget");
    await chat.generate({ messages: [] });
    await widget.generate({ messages: [] });

    const spend = llmSpend();
    expect(spend).toMatchObject({ usd: 15, calls: 2 });
    expect(spend.byTask.chat).toMatchObject({ usd: 5, calls: 1, unpriced: 0 });
    expect(spend.byTask.widget).toMatchObject({ usd: 10, calls: 1, unpriced: 0 });
  });

  it("counts an unpriced call under its own action rather than losing it", async () => {
    const adapter = meter(fake(usage({ promptTokens: 1_000 }), "some-custom-model"), "narrow");
    await adapter.generate({ messages: [] });

    expect(llmSpend().byTask.narrow).toMatchObject({ usd: 0, calls: 1, unpriced: 1 });
  });

  it("clears with the total, so a test never inherits another's spend", async () => {
    const adapter = meter(fake(usage({ promptTokens: 1_000_000 })), "chat");
    await adapter.generate({ messages: [] });
    resetLlmSpend();
    expect(llmSpend().byTask).toEqual({});
  });
});
