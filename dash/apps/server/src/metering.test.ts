import type { LlmAdapter, LlmTokenUsage } from "@freebirdai/dash-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TURN_CEILING_USD,
  TurnBudgetExceededError,
  llmSpend,
  meter,
  resetLlmSpend,
  runWithTurnBudget,
  turnCeilingUsd,
  turnSpendSoFar,
} from "./llm.js";

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

/**
 * The ceiling behind the meter.
 *
 * Every mechanism that reaches for a model is bounded on its own; one request
 * can reach several of them and nothing bounded the total. These are the cases
 * that decide whether the limit is real: that it stops a runaway, that it does
 * not touch an ordinary request, and that switching it off restores exactly
 * the behaviour that existed before it.
 */
describe("the per-request spend ceiling", () => {
  // $5/M in on claude-opus-5, so one call at 1M prompt tokens costs $5.
  const fiveDollarCall = () => meter(fake(usage({ promptTokens: 1_000_000 })), "chat");

  it("refuses the next call once the ceiling is reached", async () => {
    await runWithTurnBudget(6, async () => {
      const adapter = fiveDollarCall();
      // The first call is allowed even though it will take the turn to $5:
      // there is no way to know a call's cost before making it.
      await adapter.generate({ messages: [] });
      await adapter.generate({ messages: [] });
      // Now at $10, past the $6 ceiling — the next one is refused.
      await expect(adapter.generate({ messages: [] })).rejects.toThrow(
        TurnBudgetExceededError,
      );
    });
  });

  it("carries the numbers, so the refusal can say what happened", async () => {
    await runWithTurnBudget(1, async () => {
      const adapter = fiveDollarCall();
      await adapter.generate({ messages: [] });
      const failure = await adapter.generate({ messages: [] }).catch((cause) => cause);
      expect(failure).toBeInstanceOf(TurnBudgetExceededError);
      expect(failure.spentUsd).toBe(5);
      expect(failure.ceilingUsd).toBe(1);
      expect(String(failure.message)).toContain("$5.00");
    });
  });

  /* A stream must fail where `generate` fails — while it is consumed. */
  it("refuses a stream too, on consumption rather than on the call", async () => {
    await runWithTurnBudget(1, async () => {
      const adapter = fiveDollarCall();
      await adapter.generate({ messages: [] });

      const stream = adapter.stream({ messages: [] });
      await expect(
        (async () => {
          for await (const _chunk of stream) void _chunk;
        })(),
      ).rejects.toThrow(TurnBudgetExceededError);
    });
  });

  it("leaves an ordinary request alone", async () => {
    await runWithTurnBudget(100, async () => {
      const adapter = fiveDollarCall();
      await adapter.generate({ messages: [] });
      await adapter.generate({ messages: [] });
      expect(turnSpendSoFar()).toMatchObject({ usd: 10, calls: 2, ceilingUsd: 100 });
    });
  });

  /*
   * The escape hatch, and the state every existing caller is already in.
   * Outside a budget there is no store, no ceiling and no behaviour change.
   */
  it("does nothing at all when switched off", async () => {
    await runWithTurnBudget(0, async () => {
      const adapter = fiveDollarCall();
      for (let i = 0; i < 5; i += 1) await adapter.generate({ messages: [] });
      expect(turnSpendSoFar()).toBeNull();
    });
    const adapter = fiveDollarCall();
    await adapter.generate({ messages: [] });
    expect(turnSpendSoFar()).toBeNull();
  });

  /*
   * Stated as a test because it is a real limitation and the kind that gets
   * forgotten: an unpriced model costs $0 as far as this can tell, so it can
   * never trip the ceiling. The fix is a rate in `pricing.ts`, and the signal
   * that one is needed is the `unpriced` count, not a surprise bill.
   */
  it("cannot bound a model it has no rate for", async () => {
    await runWithTurnBudget(0.01, async () => {
      const adapter = meter(fake(usage({ promptTokens: 5_000_000 }), "future-model"), "chat");
      await adapter.generate({ messages: [] });
      await adapter.generate({ messages: [] });
      expect(turnSpendSoFar()).toMatchObject({ usd: 0 });
      expect(llmSpend().unpriced).toBe(2);
    });
  });

  it("keeps the process-wide totals it always kept", async () => {
    await runWithTurnBudget(100, async () => {
      const adapter = fiveDollarCall();
      await adapter.generate({ messages: [] });
    });
    expect(llmSpend()).toMatchObject({ usd: 5, calls: 1 });
    expect(llmSpend().byTask.chat).toMatchObject({ usd: 5, calls: 1 });
  });
});

describe("reading the ceiling from the environment", () => {
  const original = process.env.DASH_TURN_CEILING_USD;
  afterEach(() => {
    if (original === undefined) delete process.env.DASH_TURN_CEILING_USD;
    else process.env.DASH_TURN_CEILING_USD = original;
  });

  it("uses the default when unset", () => {
    delete process.env.DASH_TURN_CEILING_USD;
    expect(turnCeilingUsd()).toBe(DEFAULT_TURN_CEILING_USD);
  });

  it("takes a number when given one", () => {
    process.env.DASH_TURN_CEILING_USD = "0.5";
    expect(turnCeilingUsd()).toBe(0.5);
  });

  it("accepts 0 as switching it off", () => {
    process.env.DASH_TURN_CEILING_USD = "0";
    expect(turnCeilingUsd()).toBe(0);
  });

  /*
   * The failure worth being loud about: an install running uncapped while its
   * config claims otherwise. Falling back to the default is the safe
   * direction, and saying so is what makes the typo findable.
   */
  it("falls back to the default and says so when the value is not a number", () => {
    process.env.DASH_TURN_CEILING_USD = "two dollars";
    expect(turnCeilingUsd()).toBe(DEFAULT_TURN_CEILING_USD);
    expect(lines.join(" ")).toContain("not a number");
  });
});
