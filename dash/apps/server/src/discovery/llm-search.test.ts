import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anthropicSearchResults,
  anthropicWebSearch,
  openAiSearchResults,
  openAiWebSearch,
} from "./llm-search.js";
import { searchFromEnv } from "./search.js";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DASH_SEARCH_PROVIDER",
  "DASH_SEARCH_MODEL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

/** Records every request so the wire shape can be asserted, not assumed. */
const stubFetch = (...responses: Array<{ status?: number; body: unknown }>) => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let index = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses[Math.min(index++, responses.length - 1)];
    const status = next?.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => next?.body,
      text: async () => JSON.stringify(next?.body),
    } as unknown as Response;
  });
  return calls;
};

const searchBlock = (results: unknown) => ({
  content: [
    { type: "text", text: "DONE" },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: results },
  ],
});

describe("anthropic web search", () => {
  it("reads urls out of the search-result blocks, not the model's prose", () => {
    const results = anthropicSearchResults(
      searchBlock([
        {
          type: "web_search_result",
          url: "https://docs.widgets.dev/api",
          title: "Widgets API reference",
          page_age: "March 1, 2026",
          encrypted_content: "opaque",
        },
      ]),
    );
    expect(results).toEqual([
      { title: "Widgets API reference", url: "https://docs.widgets.dev/api", snippet: "" },
    ]);
  });

  it("throws on the error object a failed search returns in place of a list", () => {
    // The request itself is a 200; only the block shape says it failed.
    expect(() =>
      anthropicSearchResults(
        searchBlock({ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }),
      ),
    ).toThrow(/max_uses_exceeded/);
  });

  it("returns nothing rather than throwing when the model never searched", () => {
    expect(anthropicSearchResults({ content: [{ type: "text", text: "I already know." }] })).toEqual(
      [],
    );
  });

  it("declares the dynamic-filtering tool and leaves room for thinking", async () => {
    const calls = stubFetch({ body: searchBlock([]) });
    await anthropicWebSearch("key").search("widgets API", 5);

    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.body.tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 3 },
    ]);
    // 1024 is the silent default, and thinking is billed against it.
    expect(calls[0]?.body.max_tokens).toBe(2048);
  });

  it("retries once on the basic tool when the model is too old for the new one", async () => {
    const calls = stubFetch(
      { status: 400, body: { error: { message: "web_search_20260209 is not supported" } } },
      { body: searchBlock([{ type: "web_search_result", url: "https://a.dev", title: "A" }]) },
    );

    const results = await anthropicWebSearch("key", { model: "claude-sonnet-4-5" }).search("x", 5);

    expect(calls).toHaveLength(2);
    expect((calls[1]?.body.tools as Array<{ type: string }>)[0]?.type).toBe("web_search_20250305");
    expect(results.map((r) => r.url)).toEqual(["https://a.dev"]);
  });

  it("dedupes repeated urls and honours the limit", async () => {
    stubFetch({
      body: searchBlock([
        { type: "web_search_result", url: "https://a.dev", title: "A" },
        { type: "web_search_result", url: "https://a.dev", title: "A again" },
        { type: "web_search_result", url: "https://b.dev", title: "B" },
        { type: "web_search_result", url: "https://c.dev", title: "C" },
      ]),
    });
    const results = await anthropicWebSearch("key").search("x", 2);
    expect(results.map((r) => r.url)).toEqual(["https://a.dev", "https://b.dev"]);
  });
});

describe("openai web search", () => {
  it("reads urls out of url_citation annotations", () => {
    expect(
      openAiSearchResults({
        output: [
          { type: "web_search_call", status: "completed" },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "DONE",
                annotations: [
                  { type: "url_citation", url: "https://docs.widgets.dev", title: "Widgets" },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([{ title: "Widgets", url: "https://docs.widgets.dev", snippet: "" }]);
  });

  it("enables the web search tool", async () => {
    const calls = stubFetch({ body: { output: [] } });
    await openAiWebSearch("key").search("widgets", 5);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]?.body.tools).toEqual([{ type: "web_search" }]);
  });
});

describe("searchFromEnv", () => {
  it("is absent when there is no key at all", () => {
    expect(searchFromEnv()).toBeNull();
  });

  it("runs on the AI key rung 3 already needs, so one key covers both", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    expect(searchFromEnv()?.name).toBe("anthropic");

    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-oai";
    expect(searchFromEnv()?.name).toBe("openai");
  });

  it("honours an explicit provider override when both keys are present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.OPENAI_API_KEY = "sk-oai";
    expect(searchFromEnv()?.name).toBe("anthropic");

    process.env.DASH_SEARCH_PROVIDER = "openai";
    expect(searchFromEnv()?.name).toBe("openai");
  });

  it("does not silently fall back when the forced provider has no key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.DASH_SEARCH_PROVIDER = "openai";
    expect(searchFromEnv()).toBeNull();
  });
});
