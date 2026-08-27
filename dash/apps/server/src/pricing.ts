import type { LlmTokenUsage } from "@freebirdai/dash-agent";

/**
 * What a model call costs, so AI spend is a number rather than a feeling.
 *
 * Rates are published per million tokens and are checked in as data rather
 * than fetched: a cost line that silently changes because a vendor edited a
 * page is worse than one that is visibly stale. `RATES_AS_OF` is the date
 * these were read, and it is printed alongside any total — an old date is the
 * signal to re-check, and nothing here pretends to be authoritative after it.
 *
 * Rates read 2026-08-17 from platform.claude.com/docs/en/about-claude/models
 * and developers.openai.com/api/docs/pricing.
 */

export const RATES_AS_OF = "2026-08-17";

export interface ModelRate {
  /** USD per million prompt tokens. */
  readonly input: number;
  /** USD per million completion tokens. */
  readonly output: number;
  /**
   * USD per million prompt tokens served from cache.
   *
   * Anthropic prices this at 0.1x input; OpenAI publishes its own figure per
   * model, which is why this is a rate rather than a multiplier.
   */
  readonly cachedInput: number;
  /**
   * USD per million tokens written to cache. Anthropic only, at 1.25x input
   * for the default five-minute TTL — OpenAI does not charge for the write.
   */
  readonly cacheWrite?: number;
}

const anthropic = (input: number, output: number): ModelRate => ({
  input,
  output,
  // Published as multipliers of the input rate rather than absolute figures,
  // so they are derived here and cannot drift apart from it.
  cachedInput: input * 0.1,
  cacheWrite: input * 1.25,
});

export const RATES: Readonly<Record<string, ModelRate>> = {
  "claude-opus-5": anthropic(5, 25),
  "claude-opus-4-8": anthropic(5, 25),
  /*
   * Standard rate, deliberately, though an introductory $2/$10 applies through
   * 2026-08-31. Billing will come in under what this reports until then —
   * over-reporting is the safe direction for a spend monitor, and it corrects
   * itself when the promotion ends rather than needing a second edit.
   */
  "claude-sonnet-5": anthropic(3, 15),
  "claude-sonnet-4-6": anthropic(3, 15),
  "claude-haiku-4-5": anthropic(1, 5),

  "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
  "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
};

/**
 * The rate for a model id, allowing for the dated ids providers answer with.
 *
 * Asking Anthropic for `claude-haiku-4-5` gets a reply stamped
 * `claude-haiku-4-5-20251001`, and an exact match against the table above then
 * reports every one of those calls as unpriced. The cheap, frequent calls are
 * exactly the ones a cost feature exists to account for, so they were the ones
 * missing from the total.
 *
 * Longest prefix wins, so a future `claude-sonnet-5-1` picks up its own rate
 * the moment one is added rather than quietly inheriting `claude-sonnet-5`'s
 * — and a family only ever lends its price to a dated release of itself,
 * which is a version stamp rather than a different model.
 */
export const rateFor = (model: string): ModelRate | undefined => {
  const exact = RATES[model];
  if (exact) return exact;

  let best: { id: string; rate: ModelRate } | undefined;
  for (const [id, rate] of Object.entries(RATES)) {
    // The separator matters: without it `gpt-4.1` would price `gpt-4.1-mini`.
    if (!model.startsWith(`${id}-`)) continue;
    if (!best || id.length > best.id.length) best = { id, rate };
  }
  return best?.rate;
};

export interface CallCost {
  readonly usd: number;
  /** False when no rate is on file — the tokens are real, the price is not. */
  readonly priced: boolean;
}

const PER_MILLION = 1_000_000;

/**
 * Price one call.
 *
 * An unknown model returns `priced: false` rather than zero. Zero would fold
 * into a running total as "this was free", which is the one answer that is
 * certainly wrong — a model nobody has a rate for still costs money.
 */
export const costOf = (model: string | undefined, usage: LlmTokenUsage): CallCost => {
  const rate = model ? rateFor(model) : undefined;
  if (!rate) return { usd: 0, priced: false };

  const cached = usage.cachedPromptTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  /*
   * Providers report cached and cache-written tokens *alongside* the prompt
   * count rather than inside it, so charging `promptTokens` at the full input
   * rate and then adding the cache lines would bill the same tokens twice.
   */
  const fresh = Math.max(0, usage.promptTokens - cached - written);

  return {
    usd:
      (fresh * rate.input +
        cached * rate.cachedInput +
        written * (rate.cacheWrite ?? rate.input) +
        usage.completionTokens * rate.output) /
      PER_MILLION,
    priced: true,
  };
};

/**
 * Money, at the precision the number actually carries.
 *
 * A single cheap call rounds to $0.00 at two decimals, which reads as free and
 * is the thing this feature exists to disprove. Small amounts get more places.
 */
export const formatUsd = (usd: number): string => {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
};
