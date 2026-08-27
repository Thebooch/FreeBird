/**
 * Rung 4 of the ladder.
 *
 * Search does not produce a dialect — it produces *candidate URLs*, which then
 * re-enter the rungs above it. That keeps the deterministic paths in charge:
 * a spec found via search is still parsed exactly, and a docs page found via
 * search is still read with all the same caveats.
 */

import { anthropicWebSearch, openAiWebSearch } from "./llm-search.js";

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

/**
 * Signals that a result is a reference page rather than a blog post.
 *
 * A direct spec link is weighted far above everything else: it takes the
 * deterministic rung, where nothing is inferred and nothing can be
 * hallucinated. A docs page is second best by a clear margin.
 */
const GOOD_URL: ReadonlyArray<{ pattern: RegExp; weight: number }> = [
  { pattern: /\/(?:openapi|swagger)[^/]*\.(?:json|ya?ml)$/i, weight: 8 },
  { pattern: /\/(?:v\d+\/)?api-docs?\b/i, weight: 5 },
  { pattern: /\bdevelopers?\./i, weight: 3 },
  { pattern: /\bdocs?\./i, weight: 3 },
  { pattern: /\/(?:docs?|reference|api|developer)s?\//i, weight: 3 },
];

const BAD_URL = [
  /(?:stackoverflow|reddit|medium|quora|youtube|twitter|x)\.com/i,
  /\/(?:blog|news|pricing|about|careers|community|forum)\b/i,
  /\.(?:pdf|zip|png|jpg)$/i,
];

/**
 * Rank candidates by how much they look like reference documentation.
 *
 * A blog post explaining an API is worse than useless here — it reads
 * plausibly and describes an old version.
 */
export const rankSearchResults = (results: readonly SearchResult[]): SearchResult[] =>
  results
    .map((result) => {
      let score = 0;
      for (const signal of GOOD_URL) if (signal.pattern.test(result.url)) score += signal.weight;
      for (const pattern of BAD_URL) if (pattern.test(result.url)) score -= 12;
      if (/openapi|swagger/i.test(result.title + result.snippet)) score += 2;
      if (/\bapi\b/i.test(result.title)) score += 1;
      return { result, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.result);

export const buildSearchQueries = (subject: string): string[] => [
  `${subject} API OpenAPI specification`,
  `${subject} REST API documentation endpoints`,
];

/**
 * Build a provider from the environment. Null means the rung is simply absent,
 * and the ladder says so rather than failing obscurely.
 *
 * Search runs on the same AI key rung 3 already requires — there is no second
 * vendor to sign up with, because a key from a search company nobody has heard
 * of is a dead end for the person this product is for. `DASH_SEARCH_PROVIDER`
 * pins the choice when both keys are present.
 */
export const searchFromEnv = (preferred?: string): SearchProvider | null => {
  // Explicit env pin wins; otherwise follow the model the user picked, so
  // search and authoring never end up on two different vendors.
  const forced = process.env.DASH_SEARCH_PROVIDER?.toLowerCase() ?? preferred?.toLowerCase();
  const model = process.env.DASH_SEARCH_MODEL;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  const openai = process.env.OPENAI_API_KEY;

  const build = (name: string): SearchProvider | null => {
    if (name === "anthropic") {
      return anthropic ? anthropicWebSearch(anthropic, { ...(model ? { model } : {}) }) : null;
    }
    if (name === "openai") {
      return openai ? openAiWebSearch(openai, { ...(model ? { model } : {}) }) : null;
    }
    return null;
  };

  if (forced) return build(forced);
  return build("anthropic") ?? build("openai");
};
