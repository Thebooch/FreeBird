/**
 * Rung 4 without a second vendor.
 *
 * Both Anthropic and OpenAI expose web search as a *server tool*: the provider
 * runs the query against a real search index during a model call and hands back
 * structured results. That matters more than the convenience — we read the
 * result blocks, not the model's prose, so what comes out is a list of URLs a
 * search engine actually returned rather than URLs a model believes exist.
 *
 * So this is not "ask the LLM for links". It fills the `SearchProvider` shape,
 * feeds the same deterministic `rankSearchResults`, and every candidate still
 * re-enters rungs 2–3 through the SSRF guard. The cost is a model call per
 * query rather than a plain HTTP GET — worth it, because it means search runs
 * on the AI key rung 3 already needs instead of a second vendor signup.
 *
 * The query text is derived from user input, which means it reaches a prompt.
 * That is safe here by construction: nothing the model *writes* is used, only
 * the URLs the search tool returned, and each of those is fetched under the
 * same guard as a URL the user typed by hand.
 */

import type { SearchProvider, SearchResult } from "./search.js";
import { TIER_MODELS } from "../models.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/**
 * Dynamic-filtering variant, supported on Opus 4.6+ and Sonnet 4.6+. Older
 * models only know the basic tool, so a rejection falls back to it once rather
 * than making the whole rung unavailable to whoever pinned an older model.
 */
const CURRENT_TOOL = "web_search_20260209";
const LEGACY_TOOL = "web_search_20250305";

const prompt = (query: string): string =>
  `Use the web_search tool to search the web for: ${query}\n\n` +
  "Run the search — do not answer from memory. Reply with only the word DONE.";

interface AnthropicBlock {
  type?: string;
  content?: unknown;
}

/**
 * Pull result rows out of the response.
 *
 * A successful search puts an *array* of results in `content`; a failed one
 * puts a single error *object* there, with a 200 on the request either way.
 * Indexing without checking yields `undefined` and looks like "no results",
 * which is exactly the kind of quiet wrong answer this project exists to avoid.
 */
export const anthropicSearchResults = (payload: unknown): SearchResult[] => {
  const blocks = ((payload as { content?: AnthropicBlock[] } | null)?.content ?? []).filter(
    (block) => block?.type === "web_search_tool_result",
  );

  const results: SearchResult[] = [];
  for (const block of blocks) {
    if (!Array.isArray(block.content)) {
      const code = (block.content as { error_code?: string } | null)?.error_code;
      throw new Error(`web search failed${code ? ` (${code})` : ""}`);
    }
    for (const item of block.content as Array<{ type?: string; url?: unknown; title?: unknown }>) {
      if (item?.type !== "web_search_result" || typeof item.url !== "string") continue;
      results.push({
        title: typeof item.title === "string" ? item.title : item.url,
        url: item.url,
        // Deliberately empty: the model's summary would be a snippet, but
        // mixing generated text into the ranker's input makes ranking
        // nondeterministic. The URL carries the signal that matters anyway.
        snippet: "",
      });
    }
  }
  return results;
};

/** Citations on the Responses API carry the URLs the search tool returned. */
export const openAiSearchResults = (payload: unknown): SearchResult[] => {
  const output = ((payload as { output?: unknown[] } | null)?.output ?? []) as Array<{
    type?: string;
    content?: Array<{ annotations?: Array<{ type?: string; url?: unknown; title?: unknown }> }>;
  }>;

  const results: SearchResult[] = [];
  for (const item of output) {
    for (const part of item?.content ?? []) {
      for (const annotation of part?.annotations ?? []) {
        if (annotation?.type !== "url_citation" || typeof annotation.url !== "string") continue;
        results.push({
          title: typeof annotation.title === "string" ? annotation.title : annotation.url,
          url: annotation.url,
          snippet: "",
        });
      }
    }
  }
  return results;
};

const dedupe = (results: SearchResult[], limit: number): SearchResult[] => {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    out.push(result);
    if (out.length >= limit) break;
  }
  return out;
};

export const anthropicWebSearch = (
  apiKey: string,
  options: { model?: string } = {},
): SearchProvider => {
  const model = options.model ?? "claude-sonnet-5";
  let toolType = CURRENT_TOOL;

  const call = async (query: string, limit: number): Promise<Response> =>
    fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        // Thinking counts against this too, and a truncated turn means the
        // search never runs. Leave headroom rather than the 1024 default.
        max_tokens: 2048,
        tools: [
          {
            type: toolType,
            name: "web_search",
            max_uses: Math.max(1, Math.min(limit, 3)),
          },
        ],
        messages: [{ role: "user", content: prompt(query) }],
      }),
    });

  return {
    name: "anthropic",
    async search(query, limit) {
      let response = await call(query, limit);

      if (!response.ok && toolType === CURRENT_TOOL && response.status === 400) {
        // Almost certainly a model too old for the dynamic-filtering variant.
        toolType = LEGACY_TOOL;
        response = await call(query, limit);
      }

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Anthropic web search failed (${response.status}): ${detail.slice(0, 200)}`,
        );
      }

      return dedupe(anthropicSearchResults(await response.json()), limit);
    },
  };
};

export const openAiWebSearch = (
  apiKey: string,
  options: { model?: string } = {},
): SearchProvider => {
  /*
   * The cheap tier, read from the catalogue rather than written down here.
   * Searching is a reading job, and a literal id in this file would go stale
   * silently the next time the model list changes.
   */
  const model = options.model ?? TIER_MODELS.openai.fast;

  return {
    name: "openai",
    async search(query, limit) {
      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          tools: [{ type: "web_search" }],
          input: prompt(query),
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`OpenAI web search failed (${response.status}): ${detail.slice(0, 200)}`);
      }

      return dedupe(openAiSearchResults(await response.json()), limit);
    },
  };
};
