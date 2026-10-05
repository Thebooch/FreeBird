import { describe, expect, it } from "vitest";
import { discover } from "./index.js";

/**
 * Reported failures against real documentation sites, as a suite.
 *
 * Two links were submitted and both came back wrong: one offered
 * `api.gigantic-server.com` — the Petstore example inside the OpenAPI
 * specification document itself — and one returned four endpoints guessed
 * from a table of contents. Nothing here is hypothetical; each test closes
 * one link in those chains.
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

const YAML_SPEC = [
  "openapi: 3.0.3",
  "info:",
  "  title: Aptly API",
  "servers:",
  "  - url: https://core-api.getaptly.com",
  "security:",
  "  - ApiKeyHeader: []",
  "components:",
  "  securitySchemes:",
  "    ApiKeyHeader:",
  "      type: apiKey",
  "      in: header",
  "      name: x-token",
  "    PartnerBearer:",
  "      type: http",
  "      scheme: bearer",
  "paths:",
  "  /api/users:",
  "    get:",
  "      responses:",
  "        \"200\":",
  "          content:",
  "            application/json:",
  "              schema:",
  "                type: array",
  "  /api/boards:",
  "    get:",
  "      responses:",
  "        \"200\":",
  "          content:",
  "            application/json:",
  "              schema:",
  "                type: array",
  "",
].join("\n");

/** One endpoint's page, as a docs platform serves it to a non-browser client. */
const MARKDOWN_PAGE = [
  "> ## Documentation Index",
  "> Fetch the complete documentation index at: https://docs.aptly.test/llms.txt",
  "",
  "# List users",
  "",
  "## OpenAPI",
  "",
  "```yaml /openapi.yaml get /api/users",
  "openapi: 3.0.3",
  "info:",
  "  title: Aptly API",
  "servers:",
  "  - url: https://core-api.getaptly.com",
  "paths:",
  "  /api/users:",
  "    get:",
  "      responses:",
  "        \"200\":",
  "          content:",
  "            application/json:",
  "              schema:",
  "                type: array",
  "```",
  "",
].join("\n");

/** No model, no search — everything here must be answered deterministically. */
const offline = { llm: null, search: null } as const;

describe("a docs site that serves Markdown and publishes a YAML spec", () => {
  it("finds the YAML spec that a JSON-only parser threw away", async () => {
    /*
     * The root cause. `WELL_KNOWN_SPEC_PATHS` asks for `/openapi.yaml` by
     * name and the caller checked the reply with `JSON.parse`. A real spec
     * came back, failed to parse, and was discarded as though the path had
     * 404'd — after which discovery fell all the way through to a web search.
     */
    const docs = documents({
      "https://docs.aptly.test/api-reference": { text: MARKDOWN_PAGE },
      "https://docs.aptly.test/openapi.yaml": { text: YAML_SPEC },
    });

    const result = await discover("https://docs.aptly.test/api-reference", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });

    expect(result.source).toBe("openapi");
    expect(result.entry?.baseUrl).toBe("https://core-api.getaptly.com");
    expect(result.entry?.ops).toHaveLength(2);
  });

  it("uses the scheme the spec nominates, not the highest-ranked type", async () => {
    /*
     * The spec declares an `x-token` header and a partner bearer, with
     * `security: [{ApiKeyHeader: []}]` naming the first. Ranking by type alone
     * picked the bearer, and every request would have been rejected.
     */
    const docs = documents({
      "https://docs.aptly.test/api-reference": { text: MARKDOWN_PAGE },
      "https://docs.aptly.test/openapi.yaml": { text: YAML_SPEC },
    });
    const result = await discover("https://docs.aptly.test/api-reference", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });
    expect(result.entry?.dialect.auth).toMatchObject({ type: "header", header: "x-token" });
  });

  it("prefers the whole spec over the fragment fenced in one page", async () => {
    /*
     * The fenced block holds only the endpoint that page documents. Returning
     * it immediately — as the inline extractor rightly does for a Redoc embed,
     * where the embed *is* the whole document — imported one endpoint instead
     * of the site's real two. A fence is a floor, not an answer.
     */
    const docs = documents({
      "https://docs.aptly.test/api-reference": { text: MARKDOWN_PAGE },
      "https://docs.aptly.test/openapi.yaml": { text: YAML_SPEC },
    });
    const result = await discover("https://docs.aptly.test/api-reference", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });
    expect(result.entry?.ops).toHaveLength(2);
    expect(result.note).toContain("/openapi.yaml");
  });

  it("falls back to the fenced fragment when nothing standalone exists", async () => {
    const docs = documents({
      "https://docs.aptly.test/api-reference": { text: MARKDOWN_PAGE },
    });
    const result = await discover("https://docs.aptly.test/api-reference", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });
    // One endpoint beats none, and it is still exact rather than guessed.
    expect(result.source).toBe("openapi");
    expect(result.entry?.ops).toHaveLength(1);
  });

  it("reads llms.txt to find a spec that sits on no well-known path", async () => {
    const docs = documents({
      "https://docs.aptly.test/api-reference": { text: "# List users\n\nNothing linked here.\n" },
      "https://docs.aptly.test/llms.txt": {
        text: "# Aptly API\n\n- [Spec](https://docs.aptly.test/spec/v2/openapi.yaml): the API\n",
      },
      "https://docs.aptly.test/spec/v2/openapi.yaml": { text: YAML_SPEC },
    });

    const result = await discover("https://docs.aptly.test/api-reference", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });
    expect(result.source).toBe("openapi");
    expect(docs.fetched).toContain("https://docs.aptly.test/llms.txt");
  });

  it("carries on when the site publishes no llms.txt", async () => {
    const docs = documents({
      "https://docs.aptly.test/api-reference": { text: MARKDOWN_PAGE },
      "https://docs.aptly.test/openapi.yaml": { text: YAML_SPEC },
    });
    const result = await discover("https://docs.aptly.test/api-reference", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });
    expect(result.source).toBe("openapi");
  });
});

describe("what search is allowed to offer", () => {
  const searchOf = (urls: string[]) => ({
    name: "stub",
    search: async () => urls.map((url) => ({ url, title: url, snippet: "API reference" })),
  });

  it("refuses another company's API rather than ranking it last", async () => {
    /*
     * Demoting off-domain results by sort order reads as caution and is not:
     * when every result is foreign — which is what happens for any small or
     * new API — last resort becomes first resort. That is precisely how a
     * search for one docs site returned a different company's spec.
     */
    const docs = documents({});
    const result = await discover("https://docs.aptly.test/api-reference", {
      fetchDocument: docs.fetchDocument,
      llm: null,
      search: searchOf(["https://unrelated.example.com/openapi.json"]),
    });

    expect(result.source).toBe("none");
    expect(result.entry).toBeNull();
    expect(result.note).toContain("docs.aptly.test");
    expect(docs.fetched).not.toContain("https://unrelated.example.com/openapi.json");
  });

  it("still follows a result on the host the user named", async () => {
    const docs = documents({
      "https://docs.aptly.test/reference/openapi.yaml": { text: YAML_SPEC },
    });
    const result = await discover("https://docs.aptly.test/api-reference", {
      fetchDocument: docs.fetchDocument,
      llm: null,
      search: searchOf(["https://docs.aptly.test/reference/openapi.yaml"]),
    });
    expect(result.source).toBe("openapi");
  });

  it("never offers a meta-spec, however well it scores", async () => {
    /*
     * The OpenAPI specification page is wall-to-wall `openapi:`, `paths:` and
     * `servers:`, so it ranks brilliantly for exactly the wrong reason — and
     * what a model extracts from it is the Petstore example. These hosts
     * describe how to write an API and are therefore never one.
     */
    const docs = documents({});
    const result = await discover("some obscure api", {
      fetchDocument: docs.fetchDocument,
      llm: null,
      search: searchOf([
        "https://spec.openapis.org/oas/v3.2.0.html",
        "https://swagger.io/specification/",
        "https://json-schema.org/draft/2020-12/schema",
      ]),
    });

    expect(result.entry).toBeNull();
    expect(docs.fetched).toEqual([]);
  });
});

/**
 * A docs site whose pages do not sit at the origin root.
 *
 * Guessing `${origin}/llms.txt` works only when the docs are the whole site.
 * HubSpot's live under `/docs/`, so the guess 404s while the page body says
 * plainly where the index is — and we were ignoring it.
 */
describe("finding the index a page advertises", () => {
  const ADVERTISED = [
    "> ## Documentation Index",
    "> Fetch the complete documentation index at: https://docs.deep.test/docs/llms.txt",
    "",
    "# Overview",
    "",
    "Prose about versioning. No endpoints here.",
    "",
  ].join("\n");

  it("reads the advertised path rather than the origin root", async () => {
    const docs = documents({
      "https://docs.deep.test/docs/api-reference/overview": { text: ADVERTISED },
      "https://docs.deep.test/docs/llms.txt": {
        text: "# API\n\n- [Spec](https://docs.deep.test/docs/openapi.yaml): everything\n",
      },
      "https://docs.deep.test/docs/openapi.yaml": { text: YAML_SPEC },
    });

    const result = await discover("https://docs.deep.test/docs/api-reference/overview", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });

    expect(result.source).toBe("openapi");
    expect(result.entry?.ops).toHaveLength(2);
    expect(docs.fetched).toContain("https://docs.deep.test/docs/llms.txt");
  });

  it("still falls back to the origin root when nothing is advertised", async () => {
    const docs = documents({
      "https://docs.flat.test/reference": { text: "# Overview\n\nNo index mentioned.\n" },
      "https://docs.flat.test/llms.txt": {
        text: "# API\n\n- [Spec](https://docs.flat.test/openapi.yaml)\n",
      },
      "https://docs.flat.test/openapi.yaml": { text: YAML_SPEC },
    });

    const result = await discover("https://docs.flat.test/reference", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });
    expect(result.source).toBe("openapi");
    expect(docs.fetched).toContain("https://docs.flat.test/llms.txt");
  });

  it("does not also probe the root once the advertised index answered", async () => {
    // One index per site. A second fetch is the same site saying it twice.
    const docs = documents({
      "https://docs.deep.test/docs/api-reference/overview": { text: ADVERTISED },
      "https://docs.deep.test/docs/llms.txt": {
        text: "# API\n\n- [Spec](https://docs.deep.test/docs/openapi.yaml)\n",
      },
      "https://docs.deep.test/docs/openapi.yaml": { text: YAML_SPEC },
    });

    await discover("https://docs.deep.test/docs/api-reference/overview", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });
    expect(docs.fetched).not.toContain("https://docs.deep.test/llms.txt");
  });

  it("gives up honestly when the index lists no spec at all", async () => {
    /*
     * HubSpot's index is 100KB of `.md` page links and no spec — reading it
     * correctly still yields nothing. Reaching the index is not the same as
     * finding an API, and the ladder must not pretend otherwise.
     */
    const docs = documents({
      "https://docs.deep.test/docs/api-reference/overview": { text: ADVERTISED },
      "https://docs.deep.test/docs/llms.txt": {
        text: "# API\n\n- [Guide](https://docs.deep.test/docs/guide.md)\n- [Errors](https://docs.deep.test/docs/errors.md)\n",
      },
    });

    const result = await discover("https://docs.deep.test/docs/api-reference/overview", {
      fetchDocument: docs.fetchDocument,
      ...offline,
    });
    expect(result.source).toBe("none");
    expect(result.entry).toBeNull();
  });
});
