import { describe, expect, it } from "vitest";
import { discover, indexReadGap, readIndex, sectionOf } from "./index.js";

/**
 * Reading a documentation section page by page.
 *
 * The case this exists for: a site that documents every endpoint on its own
 * page and publishes no whole-API spec. Pointed at the table of contents,
 * discovery could only ever guess — the material was all there, one fragment
 * at a time, and nothing gathered it up.
 */

/** A stub document server: URL → response. Anything else 404s. */
const documents = (map: Record<string, { status?: number; text: string }>) => {
  const fetched: string[] = [];
  return {
    fetched,
    fetchDocument: async (url: string) => {
      fetched.push(url);
      const hit = map[url];
      if (!hit) return { status: 404, text: "not found", url };
      return { status: hit.status ?? 200, text: hit.text, url };
    },
  };
};

/** A page carrying one operation in a fenced block, as these sites serve it. */
const page = (path: string, method = "get"): string =>
  [
    "> ## Documentation Index",
    "> Fetch the complete documentation index at: https://docs.deep.test/docs/llms.txt",
    "",
    `# ${method} ${path}`,
    "",
    "```yaml specs/api.json",
    "openapi: 3.0.3",
    "info:",
    "  title: Deep API",
    "servers:",
    "  - url: https://api.deep.test",
    "paths:",
    `  ${path}:`,
    `    ${method}:`,
    "      responses:",
    '        "200":',
    "          content:",
    "            application/json:",
    "              schema:",
    "                type: array",
    "```",
    "",
  ].join("\n");

const INDEX = [
  "# Deep API",
  "",
  "- [Overview](https://docs.deep.test/docs/reference/overview.md)",
  "- [List widgets](https://docs.deep.test/docs/reference/list-widgets.md)",
  "- [Get widget](https://docs.deep.test/docs/reference/get-widget.md)",
  "- [Unrelated guide](https://docs.deep.test/docs/guides/intro.md)",
  "",
].join("\n");

const site = () =>
  documents({
    "https://docs.deep.test/docs/reference/overview.md": {
      text:
        "> Fetch the complete documentation index at: https://docs.deep.test/docs/llms.txt\n\n" +
        "# Overview\n\nProse only.\n",
    },
    "https://docs.deep.test/docs/llms.txt": { text: INDEX },
    "https://docs.deep.test/docs/reference/list-widgets.md": { text: page("/widgets") },
    "https://docs.deep.test/docs/reference/get-widget.md": { text: page("/widgets/{widgetId}") },
    "https://docs.deep.test/docs/guides/intro.md": { text: "# Intro\n\nNot an endpoint.\n" },
  });

const OVERVIEW = "https://docs.deep.test/docs/reference/overview.md";
const offline = { llm: null, search: null } as const;
/** Injected so tests never actually wait out the pacing. */
const instant = { sleep: async () => {} };

describe("offering the read", () => {
  it("reports the page count without spending anything extra", async () => {
    /*
     * The index was already fetched looking for spec links, so saying what it
     * holds is free. That count is what makes a deep read something a person
     * can price before agreeing to it.
     */
    const docs = site();
    const result = await discover(OVERVIEW, { fetchDocument: docs.fetchDocument, ...offline });

    expect(result.entry).toBeNull();
    expect(result.index).toMatchObject({
      url: "https://docs.deep.test/docs/llms.txt",
      section: "/docs/reference/",
      pages: 3,
    });
    expect(result.index?.estimatedMs).toBeGreaterThan(0);
  });

  it("prices the requests themselves, not just the gaps between them", async () => {
    /*
     * A gap-only estimate said twelve HubSpot pages would take 1.4s; they took
     * 21s, because each page is tens of kilobytes that take over a second to
     * arrive. An estimate someone consents to has to include the fetching.
     */
    const slow = site();
    const result = await discover(OVERVIEW, {
      fetchDocument: async (url) => {
        await new Promise((done) => setTimeout(done, 20));
        return slow.fetchDocument(url);
      },
      ...offline,
    });
    // Three pages at ~20ms each is far above the ~250ms of pure gap.
    expect(result.index?.estimatedMs).toBeGreaterThan(3 * 20);
  });
});

describe("reading every page in a section", () => {
  it("merges them into one importable API", async () => {
    const docs = site();
    const result = await readIndex(
      OVERVIEW,
      { fetchDocument: docs.fetchDocument, ...offline },
      instant,
    );

    expect(result.source).toBe("openapi");
    expect(result.entry?.baseUrl).toBe("https://api.deep.test");
    expect(result.entry?.ops).toHaveLength(2);
    // The pair only becomes a resource because both were read together.
    expect(result.entry?.resources).toHaveLength(1);
    expect(result.note).toMatch(/Read 3 page\(s\)/);
  });

  it("reads only the submitted section, not the whole site", async () => {
    // Scope comes from the link, so the cost stays the user's to choose.
    const docs = site();
    await readIndex(OVERVIEW, { fetchDocument: docs.fetchDocument, ...offline }, instant);
    expect(docs.fetched).not.toContain("https://docs.deep.test/docs/guides/intro.md");
  });

  it("reports progress so a determinate bar is honest", async () => {
    const docs = site();
    const seen: Array<{ spent: number; planned: number }> = [];
    await readIndex(OVERVIEW, { fetchDocument: docs.fetchDocument, ...offline }, {
      ...instant,
      onProgress: (progress) => seen.push(progress),
    });
    expect(seen.at(0)).toEqual({ spent: 1, planned: 3 });
    expect(seen.at(-1)).toEqual({ spent: 3, planned: 3 });
  });

  it("stops after three pages in a row refuse", async () => {
    /*
     * A site that has started refusing will keep refusing. Spending four
     * hundred more requests to collect four hundred more failures helps
     * nobody, so the pass reports what it managed and stops.
     */
    const failing = documents({
      "https://docs.deep.test/docs/reference/overview.md": { text: "# Overview\n" },
      "https://docs.deep.test/docs/llms.txt": {
        text: ["a", "b", "c", "d", "e"]
          .map((name) => `- [${name}](https://docs.deep.test/docs/reference/${name}.md)`)
          .join("\n"),
      },
    });

    const result = await readIndex(
      OVERVIEW,
      { fetchDocument: failing.fetchDocument, ...offline },
      instant,
    );
    expect(result.warnings.join(" ")).toMatch(/Stopped after 3 pages/);
    expect(failing.fetched).not.toContain("https://docs.deep.test/docs/reference/e.md");
  });

  it("says so plainly when no page carried an API description", async () => {
    const proseOnly = documents({
      "https://docs.deep.test/docs/reference/overview.md": { text: "# Overview\n" },
      "https://docs.deep.test/docs/llms.txt": {
        text: "- [Guide](https://docs.deep.test/docs/reference/guide.md)\n",
      },
      "https://docs.deep.test/docs/reference/guide.md": { text: "# Guide\n\nNo spec here.\n" },
    });

    const result = await readIndex(
      OVERVIEW,
      { fetchDocument: proseOnly.fetchDocument, ...offline },
      instant,
    );
    expect(result.source).toBe("none");
    expect(result.entry).toBeNull();
    expect(result.note).toMatch(/none of them carried an API description/);
  });

  it("finds the index by walking up when the submitted page is gone", async () => {
    // A moved or mistyped URL is exactly when the advertised link is missing.
    const moved = documents({
      "https://docs.deep.test/docs/llms.txt": { text: INDEX },
      "https://docs.deep.test/docs/reference/list-widgets.md": { text: page("/widgets") },
      "https://docs.deep.test/docs/reference/get-widget.md": { text: page("/widgets/{widgetId}") },
    });

    const result = await readIndex(
      "https://docs.deep.test/docs/reference/does-not-exist",
      { fetchDocument: moved.fetchDocument, ...offline },
      instant,
    );
    expect(result.source).toBe("openapi");
    expect(result.entry?.ops).toHaveLength(2);
  });

  it("reports having no index rather than pretending to read", async () => {
    const bare = documents({ "https://docs.bare.test/api": { text: "# API\n\nNothing linked.\n" } });
    const result = await readIndex(
      "https://docs.bare.test/api",
      { fetchDocument: bare.fetchDocument, ...offline },
      instant,
    );
    expect(result.source).toBe("none");
    expect(result.note).toMatch(/No page index was found/);
  });
});

describe("pacing a fan-out", () => {
  it("holds a steady floor instead of a fixed total", () => {
    /*
     * `paceGapMs` alone targets five seconds overall, which would fire 434
     * pages at a 12ms gap — the burst that pacing exists to prevent. The
     * fan-out passes a computed target so the gap becomes a floor instead.
     */
    for (const pages of [12, 94, 434]) {
      expect(indexReadGap(pages)).toBeGreaterThanOrEqual(115);
      expect(indexReadGap(pages)).toBeLessThanOrEqual(135);
    }
  });
});

describe("scoping by the submitted URL", () => {
  it("takes a page's siblings as its section", () => {
    expect(sectionOf("https://x.test/docs/api/latest/overview")).toBe("/docs/api/latest/");
  });

  it("treats a trailing slash as the section itself", () => {
    expect(sectionOf("https://x.test/docs/api/crm/")).toBe("/docs/api/crm/");
  });
});
