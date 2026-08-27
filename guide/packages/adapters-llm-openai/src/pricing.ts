import type { LlmTokenUsage } from "@freebirdai/core";

/**
 * Snapshot of **approximate** Chat Completions list prices (USD per 1M tokens).
 * OpenAI changes pricing over time — refresh this table when you ship; the
 * helper returns `null` for unknown models so hosts can fall back to their
 * own billing data.
 *
 * @see https://openai.com/api/pricing/
 */
const USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4-turbo-preview": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "o1": { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  "o3-mini": { input: 1.1, output: 4.4 },
};

/**
 * Strip common dated / variant suffixes so `gpt-4o-2024-08-06` maps to `gpt-4o`.
 */
export const normalizeOpenAiModelId = (model: string): string => {
  const base = model.trim().toLowerCase();
  const cut = base.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return cut;
};

/**
 * Best-effort USD estimate for one chat completion from token usage.
 * Returns `null` if the model is not in the bundled table (no guessing).
 */
export const estimateOpenAiChatCostUsd = (
  model: string,
  usage: LlmTokenUsage,
): number | null => {
  const key = normalizeOpenAiModelId(model);
  const row = USD_PER_MILLION[key];
  if (!row) return null;
  return (
    (usage.promptTokens * row.input + usage.completionTokens * row.output) /
    1_000_000
  );
};
