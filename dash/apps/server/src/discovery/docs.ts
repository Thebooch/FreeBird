/**
 * Rung 3: reading a documentation page.
 *
 * The honest framing is that docs are a *hypothesis generator*. They go stale,
 * describe a different API version, and are frequently wrong about pagination.
 * Everything produced here is a proposal that only a real request can promote
 * to fact — which is why nothing on this path is ever marked verified.
 */

const BLOCK_TAGS = /<(script|style|svg|noscript|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

const decode = (value: string): string =>
  value
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Code samples are the highest-signal part of any API doc — a single `curl`
 * example states the base URL, the auth header and the query parameters at
 * once — so they are pulled out before the markup is flattened.
 */
export const extractCodeBlocks = (html: string): string[] => {
  const blocks: string[] = [];
  for (const match of html.matchAll(/<(?:pre|code)\b[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi)) {
    const text = decode(match[1]!.replace(/<[^>]+>/g, " "));
    if (text.length > 12 && text.length < 2000) blocks.push(text);
  }
  return blocks.slice(0, 40);
};

export const extractText = (html: string): string =>
  decode(html.replace(BLOCK_TAGS, " ").replace(COMMENTS, " ").replace(/<[^>]+>/g, " "));

export interface PageAnalysis {
  readonly text: string;
  readonly codeBlocks: readonly string[];
  /** True when the HTML is a shell that only fills in once JavaScript runs. */
  readonly isClientRendered: boolean;
  readonly reason: string | null;
}

const SPA_MARKERS = [
  /<div[^>]+id=["'](?:root|__next|app|docusaurus)["'][^>]*>\s*<\/div>/i,
  /__NEXT_DATA__/,
  /window\.__NUXT__/,
  /data-reactroot/,
];

/**
 * Detect a client-rendered docs site.
 *
 * This is the known limitation of the whole rung: Stripe, Twilio and most
 * modern docs are single-page apps, so a plain fetch returns an empty shell.
 * Saying that plainly is far better than feeding a page with no content to a
 * model and letting it invent an API from the navigation menu.
 */
export const analysePage = (html: string): PageAnalysis => {
  const text = extractText(html);
  const codeBlocks = extractCodeBlocks(html);

  const marker = SPA_MARKERS.some((pattern) => pattern.test(html));
  const sparse = text.length < 900 && html.length > 2500;

  const isClientRendered = (marker && text.length < 2000 && codeBlocks.length === 0) || sparse;

  return {
    text,
    codeBlocks,
    isClientRendered,
    reason: isClientRendered
      ? "This documentation is rendered in the browser, so there is nothing to read in the page itself."
      : null,
  };
};

interface ScoredChunk {
  readonly text: string;
  readonly score: number;
}

const SIGNALS: ReadonlyArray<{ pattern: RegExp; weight: number }> = [
  { pattern: /\bcurl\b/i, weight: 6 },
  { pattern: /\bGET\s+\/|\bGET\s+https?:/i, weight: 6 },
  { pattern: /https?:\/\/[a-z0-9.-]*api[a-z0-9.-]*\//i, weight: 5 },
  { pattern: /authorization|bearer|x-api-key|api[_-]?key|access[_-]?token/i, weight: 5 },
  { pattern: /\/v\d+\//, weight: 4 },
  { pattern: /cursor|starting_after|page_token|next_page/i, weight: 4 },
  { pattern: /\bper_page\b|\bpage_size\b|\blimit\b|\boffset\b|\bpagination\b/i, weight: 3 },
  { pattern: /\bsince\b|created\[|start_date|updated_after/i, weight: 3 },
  { pattern: /"data"|"items"|"results"|"records"/i, weight: 3 },
  { pattern: /endpoint|request|response/i, weight: 1 },
];

const scoreOf = (text: string): number =>
  SIGNALS.reduce((total, signal) => total + (signal.pattern.test(text) ? signal.weight : 0), 0);

const CHUNK_CHARS = 1_100;

const chunk = (text: string): string[] => {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) chunks.push(text.slice(i, i + CHUNK_CHARS));
  return chunks;
};

export interface RankedContext {
  readonly content: string;
  readonly chunksKept: number;
  readonly chunksTotal: number;
}

/**
 * Rank and trim the page down to what will fit in a prompt.
 *
 * Docs pages routinely run to hundreds of kilobytes, so this is the same
 * chunk-and-rank problem as scanning a source tree: score by how API-shaped a
 * passage looks, keep the best, and drop the navigation and the marketing.
 */
export const rankContext = (analysis: PageAnalysis, budget = 12_000): RankedContext => {
  // Code blocks lead — they are dense and unambiguous.
  const scored: ScoredChunk[] = [
    ...analysis.codeBlocks.map((text) => ({ text, score: scoreOf(text) + 4 })),
    ...chunk(analysis.text).map((text) => ({ text, score: scoreOf(text) })),
  ];

  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const kept: string[] = [];
  let used = 0;

  for (const candidate of ranked) {
    if (candidate.score === 0 && kept.length > 0) break;
    if (used + candidate.text.length > budget) continue;
    kept.push(candidate.text);
    used += candidate.text.length;
  }

  return {
    content: kept.join("\n---\n"),
    chunksKept: kept.length,
    chunksTotal: scored.length,
  };
};
