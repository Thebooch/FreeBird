import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown.js";

describe("a reply's inline marks", () => {
  it("reads bold, italic, code and links", () => {
    expect(parseInline("a **bold** b *it* c `x` d [site](https://example.com)")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", children: [{ kind: "text", text: "bold" }] },
      { kind: "text", text: " b " },
      { kind: "em", children: [{ kind: "text", text: "it" }] },
      { kind: "text", text: " c " },
      { kind: "code", text: "x" },
      { kind: "text", text: " d " },
      { kind: "link", href: "https://example.com", children: [{ kind: "text", text: "site" }] },
    ]);
  });

  it("keeps marks inside code literal", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }]);
  });

  it("leaves snake_case names alone", () => {
    expect(parseInline("set created_at_field now")).toEqual([{ kind: "text", text: "set created_at_field now" }]);
  });

  it("links only to web addresses", () => {
    // A javascript: or relative link is just shown as written.
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ kind: "text", text: "[x](javascript:alert(1))" }]);
    expect(parseInline("[x](/admin)")).toEqual([{ kind: "text", text: "[x](/admin)" }]);
  });

  it("shows a half-written mark as text while it streams in", () => {
    expect(parseInline("this is **unfinish")).toEqual([{ kind: "text", text: "this is **unfinish" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
  });
});

describe("a reply's blocks", () => {
  it("reads headings, paragraphs and lists", () => {
    const blocks = parseMarkdown("## Tools\n\nYou can:\n\n- read\n- write\n\n1. first\n2. second");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "list", "list"]);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: false });
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true, start: 1 });
    expect(blocks[2]).toMatchObject({ items: [expect.anything(), expect.anything()] });
  });

  it("keeps single line breaks inside a paragraph", () => {
    expect(parseMarkdown("line one\nline two")).toEqual([
      {
        kind: "paragraph",
        lines: [[{ kind: "text", text: "line one" }], [{ kind: "text", text: "line two" }]],
      },
    ]);
  });

  it("starts a list where a paragraph ends, with no blank line between", () => {
    expect(parseMarkdown("Options:\n- a\n- b").map((block) => block.kind)).toEqual(["paragraph", "list"]);
  });

  it("joins a wrapped line onto its list item", () => {
    const [list] = parseMarkdown("- a long item\n  that wraps");
    expect(list).toMatchObject({
      kind: "list",
      items: [[{ kind: "text", text: "a long item that wraps" }]],
    });
  });

  it("keeps an ordered list's first number", () => {
    expect(parseMarkdown("3. third\n4. fourth")[0]).toMatchObject({ kind: "list", ordered: true, start: 3 });
  });

  it("reads fenced code verbatim, and an unclosed fence as code to the end", () => {
    expect(parseMarkdown("```\n**raw** # here\n```")).toEqual([{ kind: "code", text: "**raw** # here" }]);
    expect(parseMarkdown("```js\nconst a = 1;")).toEqual([{ kind: "code", text: "const a = 1;" }]);
  });

  it("reads a rule, not an empty list", () => {
    expect(parseMarkdown("above\n\n---\n\nbelow").map((block) => block.kind)).toEqual(["paragraph", "rule", "paragraph"]);
  });

  it("is plain text when there is no markdown at all", () => {
    expect(parseMarkdown("Just a sentence.")).toEqual([
      { kind: "paragraph", lines: [[{ kind: "text", text: "Just a sentence." }]] },
    ]);
  });
});
