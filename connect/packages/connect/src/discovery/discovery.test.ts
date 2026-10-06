import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeLlm } from "../agent/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog.js";
import { discover, rankSearchResults } from "./index.js";
import { analysePage, endpointsNamed, rankContext } from "./docs.js";
import { mapDialectProposal } from "./propose-dialect.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-discovery-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const catalogWith = (entries: Array<Record<string, unknown>>): CatalogStore => {
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  for (const entry of entries) {
    writeFileSync(join(seed, `${String(entry.id)}.json`), JSON.stringify(entry), "utf8");
  }
  return new CatalogStore(seed, join(dir, "overlay"));
};

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

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Widget API" },
  servers: [{ url: "https://api.widgets.dev/v1" }],
  components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Key" } } },
  paths: {
    "/widgets": {
      get: {
        summary: "List widgets",
        parameters: [{ name: "page", in: "query" }],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "array" } } },
              },
            },
          },
        },
      },
    },
  },
});

describe("the ladder is ordered by determinism", () => {
  it("does not match unrelated organisations that share a public suffix", async () => {
    const catalog = catalogWith([
      {
        id: "one",
        title: "One",
        baseUrl: "https://api.vendor-one.co.uk",
        dialect: {},
        ops: [{ id: "items", title: "Items", path: "/items" }],
        verified: true,
      },
    ]);
    const result = await discover("https://vendor-two.co.uk", {
      catalog,
      fetchDocument: documents({}).fetchDocument,
    });
    expect(result.source).not.toBe("catalog");
    expect(result.entry?.id).not.toBe("one");
  });
  it("stops at a catalog hit without fetching anything", async () => {
    const catalog = catalogWith([
      {
        id: "widgets",
        title: "Widget API",
        baseUrl: "https://api.widgets.dev",
        dialect: {},
        ops: [{ id: "a", title: "A", path: "/a" }],
        verified: true,
      },
    ]);
    const docs = documents({});

    const result = await discover("https://api.widgets.dev/docs", {
      fetchDocument: docs.fetchDocument,
      catalog,
    });

    expect(result.source).toBe("catalog");
    expect(docs.fetched).toEqual([]);
    expect(result.note).toMatch(/already in the catalog and has been verified/);
  });

  it("flags an unverified catalog hit rather than presenting it as fact", async () => {
    const catalog = catalogWith([
      {
        id: "widgets",
        title: "Widget API",
        baseUrl: "https://api.widgets.dev",
        dialect: {},
        ops: [{ id: "a", title: "A", path: "/a" }],
        verified: false,
      },
    ]);
    const result = await discover("https://api.widgets.dev/docs", {
      fetchDocument: documents({}).fetchDocument,
      catalog,
    });
    expect(result.warnings.join()).toMatch(/not been proven against a live key/);
  });

  it("parses a spec when the URL is the spec itself", async () => {
    const docs = documents({ "https://api.widgets.dev/openapi.json": { text: SPEC } });
    const result = await discover("https://api.widgets.dev/openapi.json", {
      fetchDocument: docs.fetchDocument,
    });

    expect(result.source).toBe("openapi");
    expect(result.entry?.title).toBe("Widget API");
    expect(result.entry?.dialect.auth).toMatchObject({ type: "header", header: "X-Key" });
    expect(result.entry?.verified).toBe(false);
  });

  it("follows a spec link out of a docs page", async () => {
    const docs = documents({
      "https://widgets.dev/reference": {
        text: `<html><body><p>Read our API docs</p><script>var s="/static/openapi.json"</script></body></html>`,
      },
      "https://widgets.dev/static/openapi.json": { text: SPEC },
    });

    const result = await discover("https://widgets.dev/reference", {
      fetchDocument: docs.fetchDocument,
    });

    expect(result.source).toBe("openapi");
    expect(docs.fetched).toContain("https://widgets.dev/static/openapi.json");
  });

  it("tries the conventional spec locations", async () => {
    const docs = documents({
      "https://widgets.dev/reference": { text: "<html><body>docs</body></html>" },
      "https://widgets.dev/swagger.json": { text: SPEC },
    });

    const result = await discover("https://widgets.dev/reference", {
      fetchDocument: docs.fetchDocument,
    });

    expect(result.source).toBe("openapi");
    expect(result.note).toMatch(/Found an OpenAPI spec/);
    expect(result.tried).toContain("https://widgets.dev/openapi.json");
  });

  it("records every URL it tried, so the path taken is auditable", async () => {
    const docs = documents({ "https://widgets.dev/x": { text: "<html>nothing</html>" } });
    const result = await discover("https://widgets.dev/x", { fetchDocument: docs.fetchDocument });
    expect(result.tried[0]).toBe("https://widgets.dev/x");
    expect(result.tried.length).toBeGreaterThan(1);
  });
});

describe("client-rendered documentation", () => {
  const SHELL = `<!doctype html><html><head><title>Docs</title>
    <script src="/bundle.js"></script></head>
    <body><div id="__next"></div><script>window.__NEXT_DATA__={}</script></body></html>`;

  it("is detected rather than fed to a model as an empty page", () => {
    const analysis = analysePage(SHELL);
    expect(analysis.isClientRendered).toBe(true);
    expect(analysis.reason).toMatch(/rendered in the browser/);
  });

  it("stops the ladder with an actionable message", async () => {
    const llm = fakeLlm([{ args: {} }]);
    const docs = documents({ "https://stripe-like.dev/docs": { text: SHELL } });

    const result = await discover("https://stripe-like.dev/docs", {
      fetchDocument: docs.fetchDocument,
      llm,
    });

    expect(result.source).toBe("none");
    expect(result.note).toMatch(/rendered in the browser/);
    expect(result.note).toMatch(/linking directly to an OpenAPI spec/);
    // The whole point: no model call was wasted on an empty shell.
    expect(llm.calls).toHaveLength(0);
  });

  it("does not mistake a real docs page for a shell", () => {
    const real = `<html><body><h1>API</h1>
      <p>${"Authenticate with a bearer token. ".repeat(40)}</p>
      <pre>curl https://api.example.com/v1/items -H "Authorization: Bearer KEY"</pre>
      </body></html>`;
    expect(analysePage(real).isClientRendered).toBe(false);
  });
});

describe("ranking documentation", () => {
  it("puts code samples and auth passages ahead of marketing copy", () => {
    const html = `<html><body>
      <p>${"We are a company that loves widgets and our mission is delightful. ".repeat(30)}</p>
      <pre>curl https://api.example.com/v1/charges -H "Authorization: Bearer sk_test"</pre>
      </body></html>`;
    const ranked = rankContext(analysePage(html));
    expect(ranked.content.indexOf("curl")).toBeLessThan(ranked.content.indexOf("mission"));
  });

  it("stays inside the prompt budget", () => {
    const html = `<html><body><p>${"GET /v1/items limit cursor authorization ".repeat(4000)}</p></body></html>`;
    expect(rankContext(analysePage(html), 5_000).content.length).toBeLessThanOrEqual(5_000);
  });
});

describe("reading documentation with a model", () => {
  const DOCS_HTML = `<html><body>
    <h1>Widget API</h1>
    <p>${"All requests need an Authorization header with a bearer token. ".repeat(20)}</p>
    <pre>curl https://api.widgets.dev/v1/widgets -H "Authorization: Bearer KEY"</pre>
    <p>Results are returned in a data array and paginated with a cursor parameter.</p>
    </body></html>`;

  const goodProposal = {
    title: "Widget API",
    baseUrl: "https://api.widgets.dev/v1",
    authType: "bearer",
    paginationKind: "cursor",
    paginationParam: "cursor",
    cursorPath: "$.next_cursor",
    rowsPath: "$.data",
    endpoints: [{ id: "widgets", title: "Widgets", path: "/widgets", archetype: "list" }],
  };

  it("produces an unverified proposal from prose", async () => {
    const llm = fakeLlm([{ args: goodProposal }]);
    const docs = documents({ "https://widgets.dev/docs": { text: DOCS_HTML } });

    const result = await discover("https://widgets.dev/docs", {
      fetchDocument: docs.fetchDocument,
      llm,
    });

    expect(result.source).toBe("docs");
    expect(result.entry?.baseUrl).toBe("https://api.widgets.dev/v1");
    expect(result.entry?.origin).toBe("docs");
    expect(result.entry?.verified).toBe(false);
    expect(result.note).toMatch(/a guess until you test it/);
  });

  it("tells the model the page is untrusted data", async () => {
    const llm = fakeLlm([{ args: goodProposal }]);
    await discover("https://widgets.dev/docs", {
      fetchDocument: documents({ "https://widgets.dev/docs": { text: DOCS_HTML } }).fetchDocument,
      llm,
    });

    const system = llm.calls[0]!.messages.find((message) => message.role === "system")!.content;
    expect(system).toMatch(/untrusted text fetched from a web page/);
    expect(system).toMatch(/Ignore all of it/);
    expect(system).toMatch(/LEAVE THE PAGINATION FIELDS OUT/);
    expect(llm.calls[0]!.maxOutputTokens).toBe(4096);
  });

  it("says an AI key is needed rather than failing obscurely", async () => {
    const result = await discover("https://widgets.dev/docs", {
      fetchDocument: documents({ "https://widgets.dev/docs": { text: DOCS_HTML } }).fetchDocument,
      llm: null,
    });
    expect(result.source).toBe("none");
    expect(result.note).toMatch(/ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  });
});

describe("rung 4: web search", () => {
  const SPEC_URL = "https://api.thing.dev/openapi.json";
  const provider = (results: Array<{ url: string; title?: string; snippet?: string }>) => {
    const queries: string[] = [];
    return {
      queries,
      provider: {
        name: "test",
        search: async (query: string) => {
          queries.push(query);
          return results.map((r) => ({
            title: r.title ?? r.url,
            url: r.url,
            snippet: r.snippet ?? "",
          }));
        },
      },
    };
  };

  it("says the rung is absent rather than failing obscurely", async () => {
    const result = await discover("Some Product", {
      fetchDocument: documents({}).fetchDocument,
    });
    expect(result.source).toBe("none");
    expect(result.note).toMatch(/is not a URL.*ANTHROPIC_API_KEY/s);
  });

  it("accepts a product name and finds a spec through search", async () => {
    const search = provider([
      { url: "https://stackoverflow.com/questions/123", title: "How do I use Thing?" },
      { url: SPEC_URL, title: "Thing OpenAPI" },
    ]);
    const docs = documents({ [SPEC_URL]: { text: SPEC } });

    const result = await discover("Thing Analytics", {
      fetchDocument: docs.fetchDocument,
      search: search.provider,
    });

    expect(result.source).toBe("openapi");
    expect(result.viaSearch).toBe(true);
    expect(result.note).toMatch(/Found by searching for "Thing Analytics"/);
    // Search finds candidates; the deterministic rung still does the parsing.
    expect(result.entry?.title).toBe("Widget API");
  });

  it("warns that a searched result may not be the API you meant", async () => {
    const search = provider([{ url: SPEC_URL }]);
    const result = await discover("Thing", {
      fetchDocument: documents({ [SPEC_URL]: { text: SPEC } }).fetchDocument,
      search: search.provider,
    });
    expect(result.warnings.join()).toMatch(/check the base URL is the API you meant/);
  });

  it("discards blogs and forums before spending a fetch on them", async () => {
    const search = provider([
      { url: "https://reddit.com/r/api/comments/x" },
      { url: "https://medium.com/@someone/thing-api-guide" },
      { url: "https://example.com/blog/thing-api" },
    ]);
    const docs = documents({});

    const result = await discover("Thing", {
      fetchDocument: docs.fetchDocument,
      search: search.provider,
    });

    expect(result.source).toBe("none");
    expect(result.note).toMatch(/Nothing that looked like API reference documentation/);
    expect(docs.fetched).toEqual([]);
  });

  it("only searches after the given URL has failed", async () => {
    const search = provider([{ url: "https://elsewhere.dev/openapi.json" }]);
    const docs = documents({ "https://api.thing.dev/openapi.json": { text: SPEC } });

    const result = await discover("https://api.thing.dev/openapi.json", {
      fetchDocument: docs.fetchDocument,
      search: search.provider,
    });

    expect(result.source).toBe("openapi");
    expect(result.viaSearch).toBeUndefined();
    expect(search.queries).toEqual([]);
  });

  it("keeps a catalog hit ahead of searching, by name", async () => {
    const catalog = catalogWith([
      {
        id: "thing",
        title: "Thing",
        baseUrl: "https://api.thing.dev",
        dialect: {},
        ops: [{ id: "a", title: "A", path: "/a" }],
        verified: true,
      },
    ]);
    const search = provider([{ url: SPEC_URL }]);

    const result = await discover("Thing", {
      fetchDocument: documents({}).fetchDocument,
      catalog,
      search: search.provider,
    });

    expect(result.source).toBe("catalog");
    expect(search.queries).toEqual([]);
  });

  it("reports honestly when the candidates lead nowhere", async () => {
    const search = provider([{ url: "https://docs.thing.dev/reference" }]);
    const docs = documents({ "https://docs.thing.dev/reference": { status: 500, text: "boom" } });

    const result = await discover("Thing", {
      fetchDocument: docs.fetchDocument,
      search: search.provider,
    });

    expect(result.source).toBe("none");
    expect(result.note).toMatch(/checked 1 result\(s\), but none produced a usable/);
  });

  it("survives a search provider that throws", async () => {
    const result = await discover("Thing", {
      fetchDocument: documents({}).fetchDocument,
      search: {
        name: "broken",
        search: async () => {
          throw new Error("rate limited");
        },
      },
    });
    expect(result.source).toBe("none");
    expect(result.warnings.join()).toMatch(/Search failed: rate limited/);
  });
});

describe("rankSearchResults", () => {
  it("puts reference docs above everything else", () => {
    const ranked = rankSearchResults([
      { title: "Thing on Reddit", url: "https://reddit.com/r/thing", snippet: "" },
      { title: "Thing API reference", url: "https://docs.thing.dev/api/reference", snippet: "" },
      { title: "Thing OpenAPI", url: "https://thing.dev/openapi.json", snippet: "openapi" },
    ]);
    expect(ranked[0]?.url).toBe("https://thing.dev/openapi.json");
    expect(ranked.some((r) => r.url.includes("reddit"))).toBe(false);
  });
});

describe("bare domains and names", () => {
  it("treats a bare domain as a URL", async () => {
    const docs = documents({ "https://api.thing.dev/openapi.json": { text: SPEC } });
    const result = await discover("api.thing.dev", { fetchDocument: docs.fetchDocument });
    expect(result.source).toBe("openapi");
  });
});

describe("documentation drawn in the browser", () => {
  const shell = `<html><head><script src="/app.js"></script></head><body><div id="root"></div>${"<script>window.__x=1</script>".repeat(200)}</body></html>`;
  const drawnHtml = `<html><body><h1>Widgets API</h1>${"<p>GET https://api.widgets.dev/v1/widgets returns every widget. Authenticate with a bearer token.</p>".repeat(20)}</body></html>`;

  it("is read as drawn where a renderer is plugged in, and said to be unreadable where not", async () => {
    const docs = documents({ "https://docs.widgets.dev/": { text: shell } });
    const plain = await discover("https://docs.widgets.dev/", { fetchDocument: docs.fetchDocument, llm: null, search: null });
    expect(plain.entry).toBeNull();
    expect(plain.note + plain.warnings.join(" ")).toMatch(/rendered in the browser/);

    const asked: string[] = [];
    const drawn = await discover("https://docs.widgets.dev/", {
      fetchDocument: docs.fetchDocument,
      llm: null,
      search: null,
      renderDocs: { render: async (url) => (asked.push(url), { html: drawnHtml, url }) },
    });
    expect(asked).toEqual(["https://docs.widgets.dev/"]);
    /* Past the renderer, the page reaches the next rung: reading it needs a model, and says so. */
    expect(drawn.note + drawn.warnings.join(" ")).toMatch(/needs an AI key/);
  });

  it("imports the specification only the drawn page links to", async () => {
    const docs = documents({
      "https://docs.widgets.dev/": { text: shell },
      "https://docs.widgets.dev/assets/widgets-openapi.json": { text: SPEC },
    });
    const drawn = await discover("https://docs.widgets.dev/", {
      fetchDocument: docs.fetchDocument,
      llm: null,
      search: null,
      renderDocs: {
        render: async (url) => ({ html: `<html><body><a href="/assets/widgets-openapi.json">OpenAPI</a></body></html>`, url }),
      },
    });
    expect(drawn.source).toBe("openapi");
    expect(drawn.note).toMatch(/linked from the documentation as drawn/);
  });

  it("imports the specification the drawn page fetched for itself, though it links to none", async () => {
    const docs = documents({
      "https://docs.widgets.dev/": { text: shell },
      "https://cdn.widgets.dev/reference/v3.json": { text: SPEC },
    });
    const drawn = await discover("https://docs.widgets.dev/", {
      fetchDocument: docs.fetchDocument,
      llm: null,
      search: null,
      renderDocs: {
        render: async (url) => ({ html: drawnHtml, url, specs: ["https://cdn.widgets.dev/reference/v3.json"] }),
      },
    });
    expect(drawn.source).toBe("openapi");
    expect(drawn.note).toMatch(/fetched to draw itself/);
  });

  it("asks before fetching the browser, and searches nothing past the page meanwhile", async () => {
    const docs = documents({ "https://docs.widgets.dev/": { text: shell } });
    const searched: string[] = [];
    const rendered: string[] = [];
    const waiting = await discover("https://docs.widgets.dev/", {
      fetchDocument: docs.fetchDocument,
      llm: null,
      search: { name: "test", search: async (query) => (searched.push(query), []) },
      renderDocs: { ready: async () => "needs-install", render: async (url) => (rendered.push(url), null) },
    });
    expect(waiting).toMatchObject({ entry: null, needsRenderer: true });
    expect(waiting.note).toMatch(/one-time download of about 150 MB/);
    expect(rendered).toEqual([]);
    expect(searched).toEqual([]);
  });
});

describe("mapDialectProposal", () => {
  const base = {
    title: "Thing API",
    baseUrl: "https://api.thing.dev",
    authType: "bearer",
    endpoints: [{ id: "things", title: "Things", path: "/things", archetype: "list" }],
  };

  it("never marks a proposal read from prose as verified", () => {
    const { entry } = mapDialectProposal(base);
    expect(entry?.verified).toBe(false);
    expect(entry?.origin).toBe("docs");
  });

  /* Sign-ins prose names that used to be "not supported". */
  it("reads a cookie key, a Digest login and an AWS signature from prose as sign-ins it can send", () => {
    expect(mapDialectProposal({ ...base, authType: "cookie", authName: "session_key" }).entry?.dialect.auth).toEqual({
      type: "headers",
      parts: [{ header: "session_key", keyRef: "thing-api-key", in: "cookie" }],
    });
    expect(mapDialectProposal({ ...base, authType: "digest" }).entry?.dialect.auth).toMatchObject({ type: "basic", digest: true });
    const signed = mapDialectProposal({ ...base, authType: "AWS Signature Version 4", authRegion: "eu-west-1", authService: "execute-api" });
    expect(signed.entry?.dialect.auth).toEqual({
      type: "sigv4",
      accessKeyRef: "thing-api-key-access",
      keyRef: "thing-api-key",
      region: "eu-west-1",
      service: "execute-api",
    });
    expect(signed.warnings.join(" ")).not.toMatch(/not supported|not an authentication style/i);
    /* A region the docs did not state is left out, never guessed; an AWS address says its own. */
    expect(mapDialectProposal({ ...base, authType: "aws", authRegion: "the default one" }).entry?.dialect.auth).toEqual({
      type: "sigv4",
      accessKeyRef: "thing-api-key-access",
      keyRef: "thing-api-key",
    });
    /* Any other signing is still named as what it is. */
    expect(mapDialectProposal({ ...base, authType: "signed" }).entry?.dialect.auth).toEqual({ type: "none" });
  });

  /* Measurement 1: a "modified after" filter as every read's window counted 33 of 194 products. */
  it("does not make a changed-since parameter every read's time window, and says why", () => {
    const { entry, warnings } = mapDialectProposal({ ...base, timeParam: "modifiedAfter" });
    expect(entry?.dialect.timeFilter).toBeUndefined();
    expect(warnings.join(" ")).toMatch(/"modifiedAfter" selects records changed since a time/);
    expect(mapDialectProposal({ ...base, timeParam: "created_after" }).entry?.dialect.timeFilter).toMatchObject({
      param: "created_after",
    });
  });

  /* Measurement 1: an API documented in prose had no resources, so no request could reach it. */
  it("reads the record structure off the paths the prose named, as a specification's are", () => {
    const { entry } = mapDialectProposal(base);
    expect(entry?.resources).toEqual([expect.objectContaining({ id: "thing", listOp: "things" })]);
  });

  /* Regression: 18 of 158 sections were read, and the collection a request was about was never imported. */
  it("adds the reads the whole page names under the API's address, and the collections their records belong to", () => {
    const { entry, warnings } = mapDialectProposal(base, [
      "GET https://api.thing.dev/things/{id}",
      "GET https://api.thing.dev/widgets/:widgetId",
      "GET /gadgets",
      "https://api.thing.dev/parts",
      "https://docs.thing.dev/guide",
      "GET https://elsewhere.dev/things",
    ]);
    const paths = entry?.ops.map((op) => op.path) ?? [];
    expect(paths).toEqual([
      "/things",
      "/things/{{param.id}}",
      "/widgets/{{param.widgetid}}",
      "/widgets",
      "/gadgets",
      "/parts",
    ]);
    expect(entry?.ops.find((op) => op.path === "/widgets")).toMatchObject({ archetype: "list", title: "List widgets" });
    expect(warnings.join(" ")).toMatch(/5 endpoint\(s\) the documentation names were added/);
  });

  /* Regression: a page's examples — /character/361, an avatar image — became twenty collections of their own. */
  it("reads an example id in a named address as the record's id, and skips files", () => {
    const { entry } = mapDialectProposal(base, [
      "https://api.thing.dev/episodes/27",
      "https://api.thing.dev/episodes/1,2,3",
      "https://api.thing.dev/episodes/0b7c7f9e-8f4e-4c2a-9a3b-1e2d3c4b5a69",
      "https://api.thing.dev/characters/avatar/361.jpeg",
    ]);
    expect(entry?.ops.map((op) => op.path)).toEqual(["/things", "/episodes/{{param.id}}", "/episodes"]);
  });

  /* Regression: a table of resources read `/todos`, and the to-dos were never imported. */
  it("takes a path written on its own, under the API's own address", () => {
    const named = endpointsNamed(analysePage("<table><tr><td>/posts</td><td>100 posts</td></tr><tr><td>/todos</td><td>200 todos</td></tr></table><p>See 1/2 of it.</p>"));
    expect(named).toEqual(expect.arrayContaining(["PATH /posts", "PATH /todos"]));
    expect(named.some((one) => one.includes("1/2"))).toBe(false);
    /* The end of a markup tag in a sample is not a path. */
    expect(endpointsNamed(analysePage("<pre>&lt;name&gt;x&lt;/name&gt;</pre>")).some((one) => one.includes("/name"))).toBe(false);
    /* An API whose base address is its one endpoint. */
    const single = mapDialectProposal({ ...base, baseUrl: "https://api.thing.dev/xml/v1/request.api", endpoints: [] }, ["https://api.thing.dev/xml/v1/request.api"]);
    expect(single.entry?.ops.map((op) => op.path)).toEqual(["/"]);
    const { entry } = mapDialectProposal(base, named);
    expect(entry?.ops.map((op) => op.path)).toEqual(expect.arrayContaining(["/posts", "/todos"]));
    /* Under an API with a path of its own, only paths beneath it. */
    const prefixed = mapDialectProposal({ ...base, baseUrl: "https://api.thing.dev/api" }, ["PATH /documentation", "PATH /api/todos"]);
    expect(prefixed.entry?.ops.map((op) => op.path)).toEqual(["/things", "/todos"]);
  });

  it("finds every read a page names, however far down it is", () => {
    const filler = "<p>Words about the product.</p>".repeat(2000);
    const html = `<html><body>${filler}<p>List them with GET https://api.thing.dev/v1/things?page=2.</p><p>See https://api.thing.dev/v1/status</p></body></html>`;
    const named = endpointsNamed(analysePage(html));
    expect(named).toContain("GET https://api.thing.dev/v1/things?page=2");
    expect(named).toContain("https://api.thing.dev/v1/status");
    expect(named).not.toContain("https://api.thing.dev/v1/things?page=2");
  });

  /* Regression: an API that filters by state and type was imported with no way to ask it to. */
  it("keeps the parameters an endpoint documents for narrowing, as optional inputs, and never paging ones", () => {
    const { entry } = mapDialectProposal({
      ...base,
      paginationKind: "page",
      paginationParam: "page",
      limitParam: "per_page",
      endpointParams: [
        { endpoint: "things", name: "by_state", description: "Filter by state." },
        { endpoint: "things", name: "by_type" },
        { endpoint: "things", name: "per_page" },
        { endpoint: "things", name: "sort" },
        { endpoint: "things", name: "not a name!" },
        { endpoint: "elsewhere", name: "status" },
      ],
    });
    const params = entry?.ops[0]?.params ?? [];
    expect(params.map((one) => one.name)).toEqual(["by_state", "by_type"]);
    expect(params[0]).toMatchObject({ in: "query", required: false, role: "filter", description: "Filter by state." });
    /* Nothing is asked of a person for them. */
    expect(params.every((one) => !one.required && one.default === undefined)).toBe(true);
  });

  it("refuses a pagination scheme that arrived without its parameter", () => {
    const { entry, warnings } = mapDialectProposal({ ...base, paginationKind: "cursor" });
    // Better single-page than a scheme that silently returns page one.
    expect(entry?.dialect.pagination).toEqual({ kind: "none" });
    expect(warnings.join()).toMatch(/without the parameter it needs/);
  });

  it("warns when a cursor has no declared source field", () => {
    const { entry, warnings } = mapDialectProposal({
      ...base,
      paginationKind: "cursor",
      paginationParam: "after",
    });
    expect(entry?.paginationProposal).toMatchObject({ kind: "cursor", param: "after" });
    expect(warnings.join()).toMatch(/not which response field carries it/);
  });

  it("keeps prose pagination as a proposal, never the live setting", () => {
    const { entry, warnings } = mapDialectProposal({
      ...base,
      paginationKind: "page",
      paginationParam: "page",
    });
    expect(entry?.dialect.pagination).toEqual({ kind: "none" });
    expect(entry?.paginationProposal).toMatchObject({ kind: "page", param: "page" });
    expect(warnings.join()).toMatch(/unconfirmed suggestion/);
  });

  it("keeps writes read from prose apart, and marks them inferred", () => {
    const { entry, warnings } = mapDialectProposal({
      ...base,
      writes: [
        { id: "create_thing", method: "post", title: "Create a thing", path: "/things" },
        { id: "nuke", method: "PURGE", title: "Nuke", path: "/things" },
        { id: "remove_thing", method: "DELETE", title: "Delete a thing", path: "things/{{param.id}}" },
      ],
      writeFields: [
        { write: "create_thing", name: "Name", type: "string", required: true },
        { write: "create_thing", name: "Size", type: "decimal" },
      ],
    });
    expect(entry?.ops.map((op) => op.id)).toEqual(["things"]);
    expect(entry?.writes.map((write) => [write.method, write.path, write.confidence])).toEqual([
      ["POST", "/things", "inferred"],
      ["DELETE", "/things/{{param.id}}", "inferred"],
    ]);
    expect(entry?.writes[0]?.confirmed).toBeUndefined();
    expect(entry?.writes[0]?.body?.fields).toEqual([
      { path: "Name", type: "string", required: true },
      { path: "Size", type: "string", required: false },
    ]);
    expect(warnings.join()).toMatch(/They are offered, and every change made through one says in its review/);
  });

  it("falls back to none for an invented auth style", () => {
    const { entry, warnings } = mapDialectProposal({ ...base, authType: "magic" });
    expect(entry?.dialect.auth).toEqual({ type: "none" });
    expect(warnings.join()).toMatch(/not an authentication style we support/);
  });

  it("names a sign-in the docs describe that no supported style covers", () => {
    const signed = mapDialectProposal({ ...base, authType: "signed (HMAC)" });
    expect(signed.entry?.dialect.auth).toEqual({ type: "none" });
    expect(signed.warnings.join()).toMatch(/signed requests.*only partly supported\. Connector code signs/);

    // OAuth stands in as a pasted token, and says the token will expire.
    const oauth = mapDialectProposal({ ...base, authType: "oauth2" });
    expect(oauth.entry?.dialect.auth).toMatchObject({ type: "bearer" });
    expect(oauth.warnings.join()).toMatch(/OAuth 2\.0 without a flow Dash can run, which is only partly supported/);
  });

  it("drops endpoints given as absolute URLs", () => {
    const { entry, warnings } = mapDialectProposal({
      ...base,
      endpoints: [
        { id: "ok", title: "OK", path: "/ok", archetype: "list" },
        { id: "bad", title: "Bad", path: "https://elsewhere.example.com/x", archetype: "list" },
      ],
    });
    expect(entry?.ops.map((op) => op.id)).toEqual(["ok"]);
    expect(warnings.join()).toMatch(/absolute URLs rather than paths/);
  });

  it("surfaces what the model said it could not determine", () => {
    const { warnings } = mapDialectProposal({
      ...base,
      uncertain: [{ topic: "Rate limits", note: "the docs never state them" }],
    });
    expect(warnings.join()).toMatch(/Rate limits: the docs never state them/);
  });

  it("returns nothing usable when no endpoints survive", () => {
    const { entry, warnings } = mapDialectProposal({ ...base, endpoints: [] });
    expect(entry).toBeNull();
    expect(warnings.join()).toMatch(/No usable endpoints/);
  });
});

describe("search results from another organisation", () => {
  const stubSearch = (urls: string[]) => ({
    name: "stub",
    search: async () => urls.map((url) => ({ title: url, url, snippet: "" })),
  });

  /** The mismatch check compares the API the spec *declares*, not where it sits. */
  const specServing = (baseUrl: string): string =>
    JSON.stringify({ ...JSON.parse(SPEC), servers: [{ url: baseUrl }] });

  it("prefers a candidate on the host the user actually named", async () => {
    const docs = documents({
      // Nothing useful at the user's URL, so the ladder falls through to search.
      "https://dog.ceo/docs": { status: 404, text: "" },
      "https://apify.com/openapi.json": { text: specServing("https://api.apify.com") },
      "https://api.dog.ceo/openapi.json": { text: specServing("https://api.dog.ceo") },
    });

    const result = await discover("https://dog.ceo/docs", {
      fetchDocument: docs.fetchDocument,
      // Deliberately listing the off-domain spec first, as the live run did.
      search: stubSearch(["https://apify.com/openapi.json", "https://api.dog.ceo/openapi.json"]),
    });

    expect(result.source).toBe("openapi");
    expect(result.tried).toContain("https://api.dog.ceo/openapi.json");
    expect(result.note).not.toMatch(/⚠/);
  });

  it("refuses another company's API instead of offering it with a warning", async () => {
    /*
     * This used to be followed and flagged. A warning above the Use button is
     * not a safeguard when every candidate is foreign — the demotion sort has
     * nothing to demote it below, so the wrong API is offered first and looks
     * like a complete, confident import. Refusing is the honest answer.
     */
    const docs = documents({
      "https://dog.ceo/docs": { status: 404, text: "" },
      "https://apify.com/openapi.json": { text: specServing("https://api.apify.com") },
    });

    const result = await discover("https://dog.ceo/docs", {
      fetchDocument: docs.fetchDocument,
      search: stubSearch(["https://apify.com/openapi.json"]),
    });

    expect(result.source).toBe("none");
    expect(result.entry).toBeNull();
    expect(result.note).toMatch(/Nothing on dog\.ceo/);
    // And it was never even fetched.
    expect(docs.fetched).not.toContain("https://apify.com/openapi.json");
  });
});

describe("mapDialectProposal: the address and the credentials", () => {
  const base = {
    title: "Thing API",
    baseUrl: "https://{account}.thing.dev/api",
    baseUrlParts: [{ name: "account", description: "Your company's subdomain", example: "acme" }],
    authType: "basic",
    authUsernameLabel: "Account ID",
    authSecretLabel: "API token",
    endpoints: [{ id: "things", title: "Things", path: "/things", archetype: "list" }],
  };

  it("keeps an address with a per-account blank as a template", () => {
    const { entry } = mapDialectProposal(base);
    expect(entry?.server).toMatchObject({
      url: "https://{account}.thing.dev/api",
      variables: [{ name: "account", description: "Your company's subdomain", default: "acme" }],
    });
    expect(entry?.baseUrl).toBe("https://acme.thing.dev/api");
  });

  it("asks for both halves of a Basic login, by the docs' names", () => {
    const { entry } = mapDialectProposal(base);
    expect(entry?.dialect.auth).toMatchObject({
      type: "basic",
      usernameRef: expect.any(String),
      usernameLabel: "Account ID",
      label: "API token",
    });
  });
});
