/**
 * The markdown a reply is written in, read into a tree the chat renders.
 *
 * Models write headings, lists, bold and code whether or not they are asked
 * to, and shown raw they arrive as `###` and `**` in the middle of a sentence.
 * This reads the part of markdown replies actually use and nothing more.
 *
 * Hand-rolled for the same reason as `route.ts`: the surface is small, and a
 * markdown library brings HTML passthrough, plugins and a dependency tree to
 * hold a dozen rules. Nothing here produces HTML — the result is data, and
 * `ReplyMarkdown.tsx` turns it into React elements, so a reply can never inject
 * markup. Links are kept only for http(s) addresses; anything else stays text.
 *
 * It is tolerant on purpose: a reply is parsed again on every streamed delta,
 * so an unclosed fence or a half-written `**` must read as text, never throw.
 */

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly Inline[] }
  | { readonly kind: "em"; readonly children: readonly Inline[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly href: string; readonly children: readonly Inline[] };

export type Block =
  /** Lines of one paragraph, each its own row: a single newline in a reply is meant. */
  | { readonly kind: "paragraph"; readonly lines: readonly (readonly Inline[])[] }
  | { readonly kind: "heading"; readonly level: number; readonly children: readonly Inline[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly Inline[])[];
    }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "rule" };

/*
 * One pass over the text, earliest match first. Order inside the alternation
 * settles ties at the same index: code before emphasis, so `**` inside
 * backticks stays literal; bold before italic, so `**x**` is not two `*`.
 * Underscore italics need a non-word character on both sides, so snake_case
 * names in a reply stay names.
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*(?=\S)[^\n]*?\S\*\*)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*)|((?<![\w])_(?=\S)[^_\n]*?\S_(?![\w]))/g;

export const parseInline = (text: string): Inline[] => {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (value: string): void => {
    if (value.length === 0) return;
    const previous = out[out.length - 1];
    if (previous?.kind === "text") out[out.length - 1] = { kind: "text", text: previous.text + value };
    else out.push({ kind: "text", text: value });
  };
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    pushText(text.slice(last, index));
    const [whole, code, strong, link, linkText, href, em, underscore] = match;
    if (code) out.push({ kind: "code", text: code.slice(1, -1) });
    else if (strong) out.push({ kind: "strong", children: parseInline(strong.slice(2, -2)) });
    else if (link && linkText && href) out.push({ kind: "link", href, children: parseInline(linkText) });
    else if (em) out.push({ kind: "em", children: parseInline(em.slice(1, -1)) });
    else if (underscore) out.push({ kind: "em", children: parseInline(underscore.slice(1, -1)) });
    else pushText(whole);
    last = index + whole.length;
  }
  pushText(text.slice(last));
  return out;
};

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

export const parseMarkdown = (text: string): Block[] => {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph.map(parseInline) });
      paragraph = [];
    }
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, start: list.start, items: list.items.map(parseInline) });
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      // An unclosed fence runs to the end: mid-stream, the rest is still arriving.
      while (++i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i]!);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    // A rule is checked before a list item, since "- - -" would read as one.
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, children: parseInline(heading[2]!) });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush();
      if (!list) list = { ordered, start: ordered ? Number(item[2]) : 1, items: [] };
      list.items.push(item[3]!);
      continue;
    }

    // A line under a list item, not itself an item, continues that item.
    if (list && list.items.length > 0) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();
  return blocks;
};
