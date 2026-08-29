import type { LlmTokenUsage } from "@freebirdai/dash-agent";
import { describe, expect, it } from "vitest";
import { RATES, costOf, formatUsd, rateFor } from "./pricing.js";

const usage = (over: Partial<LlmTokenUsage> = {}): LlmTokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  ...over,
});

describe("costOf", () => {
  it("prices a plain call at the model's published rates", () => {
    // Claude Opus 5: $5 per million in, $25 per million out.
    const cost = costOf("claude-opus-5", usage({ promptTokens: 1_000_000, completionTokens: 0 }));
    expect(cost).toEqual({ usd: 5, priced: true });
    expect(costOf("claude-opus-5", usage({ completionTokens: 1_000_000 })).usd).toBe(25);
  });

  it("does not bill cached tokens twice", () => {
    /*
     * The trap this pins: providers report the cached count *within* the
     * prompt total, so charging the whole prompt at the input rate and then
     * adding a cache line again bills the same tokens at both prices.
     */
    const cost = costOf(
      "claude-opus-5",
      usage({ promptTokens: 1_000_000, cachedPromptTokens: 1_000_000 }),
    );
    // A wholly cached prompt costs the cache-read rate — a tenth of input.
    expect(cost.usd).toBeCloseTo(0.5, 10);
  });

  it("charges the write premium on tokens put into the cache", () => {
    const cost = costOf(
      "claude-opus-5",
      usage({ promptTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
    );
    expect(cost.usd).toBeCloseTo(6.25, 10);
  });

  it("splits a mixed prompt across all three rates", () => {
    const cost = costOf(
      "claude-opus-5",
      usage({
        promptTokens: 1_000_000,
        cachedPromptTokens: 600_000,
        cacheWriteTokens: 200_000,
        completionTokens: 100_000,
      }),
    );
    // 200k fresh @ $5 + 600k cached @ $0.50 + 200k written @ $6.25 + 100k out @ $25
    expect(cost.usd).toBeCloseTo(1 + 0.3 + 1.25 + 2.5, 10);
  });

  /*
   * Nothing here asks OpenAI to cache, but OpenAI caches on its own above a
   * prompt length this app is well past, reports the hit, and `llm.ts` reads
   * it. Without a recorded rate those tokens would be billed at full input
   * and every turn would be overstated.
   */
  it("charges an OpenAI cache hit at the recorded cache rate", () => {
    expect(RATES["gpt-5.6-terra"]?.cachedInput).toBe(0.2);
    const cost = costOf(
      "gpt-5.6-terra",
      usage({ promptTokens: 1_000_000, cachedPromptTokens: 1_000_000 }),
    );
    expect(cost.usd).toBeCloseTo(0.2, 10);
  });

  it("records each OpenAI cache rate rather than deriving one", () => {
    // Every model in the current family happens to read at 0.1x input, which
    // is exactly why they are written out: a derived multiplier would look
    // right until one model published a different one.
    for (const id of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.4-mini"]) {
      const rate = RATES[id];
      expect(rate?.cachedInput).toBeDefined();
      expect(rate?.cachedInput).toBeLessThan(rate!.input);
    }
  });

  it("does not charge OpenAI for a cache write", () => {
    // Anthropic bills the write at 1.25x input; OpenAI does not bill it at all.
    expect(RATES["gpt-5.6-terra"]?.cacheWrite).toBeUndefined();
  });

  /*
   * The pro models are dearer than everything else by an order of magnitude,
   * and this table is what the picker offers. Their absence is a decision, so
   * it is asserted rather than left to be undone by a tidy-up.
   */
  it("offers no pro model", () => {
    expect(Object.keys(RATES).filter((id) => id.includes("-pro"))).toEqual([]);
  });

  it("reports an unknown model as unpriced rather than free", () => {
    /*
     * Zero would fold into the running total as "this call cost nothing",
     * which is the one answer guaranteed to be wrong — a model with no rate
     * on file still costs money. The caller counts it separately instead.
     */
    const cost = costOf("some-model-released-tomorrow", usage({ promptTokens: 10_000 }));
    expect(cost).toEqual({ usd: 0, priced: false });
    expect(costOf(undefined, usage({ promptTokens: 10_000 })).priced).toBe(false);
  });

  it("never goes negative when the cache counts exceed the prompt total", () => {
    // A provider that reports cache tokens *in addition to* the prompt count
    // would otherwise drive the fresh-token count below zero and credit money.
    const cost = costOf(
      "claude-opus-5",
      usage({ promptTokens: 100, cachedPromptTokens: 900, cacheWriteTokens: 500 }),
    );
    expect(cost.usd).toBeGreaterThan(0);
  });
});

describe("formatUsd", () => {
  it("keeps enough places that a real cost never reads as free", () => {
    // The failure this guards: a cheap call rounds to $0.00 at two decimals
    // and looks free, which is exactly what the feature exists to disprove.
    expect(formatUsd(0.000_04)).toBe("$0.00004");
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(4.2)).toBe("$4.20");
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("the rate table", () => {
  it("covers every model the picker offers", async () => {
    // A model someone can select but nobody can price reports "unpriced"
    // forever — cheap to catch here, invisible in production.
    const { MODELS } = await import("./models.js");
    const missing = MODELS.filter((model) => !RATES[model.id]).map((model) => model.id);
    expect(missing).toEqual([]);
  });
});

/**
 * The dated ids providers actually answer with.
 *
 * Asking Anthropic for `claude-haiku-4-5` gets a reply stamped
 * `claude-haiku-4-5-20251001`, and an exact match reported every one of those
 * calls as unpriced — so the cheap, frequent calls were precisely the ones
 * missing from a total whose entire job is to account for them.
 */
describe("a dated model id", () => {
  it("prices as the family it is a release of", () => {
    const dated = costOf("claude-haiku-4-5-20251001", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });
    expect(dated).toEqual({ usd: 1, priced: true });
    expect(rateFor("claude-haiku-4-5-20251001")).toEqual(rateFor("claude-haiku-4-5"));
  });

  it("takes the longest matching family, not the first", () => {
    // `gpt-5.4-nano` must not be priced as `gpt-5.4`: the separator is what
    // keeps a cheaper sibling from inheriting its parent's rate.
    expect(rateFor("gpt-5.4-nano")).toEqual(RATES["gpt-5.4-nano"]);
    expect(rateFor("gpt-5.4-nano")).not.toEqual(RATES["gpt-5.4"]);
    // And a dated release of one still finds its own family.
    expect(rateFor("gpt-5.6-terra-2026-08-01")).toEqual(RATES["gpt-5.6-terra"]);
  });

  it("still reports an unrelated model as unpriced rather than free", () => {
    expect(rateFor("llama-3-70b")).toBeUndefined();
    expect(
      costOf("llama-3-70b", { promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000 }),
    ).toEqual({ usd: 0, priced: false });
  });
});
