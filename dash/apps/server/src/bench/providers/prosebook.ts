import { html, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Prosebook: an API documented only in prose, with no specification anywhere.
 *
 * The pattern: discovery falls through every specification rung to the model
 * reading the page. The scripted answer below is what a careful reader would
 * say; a live run asks a real model instead.
 */

const KEY = "pb_key_22";
const HOST = "api.prosebook.bench.test";
const DOCS = "docs.prosebook.bench.test";

const books = (() => {
  const next = random(4404);
  return Array.from({ length: 42 }, (_, index) => ({
    id: `bk${index + 1}`,
    title: `Book ${index + 1}`,
    genre: pick(next, ["fiction", "history", "science"] as const),
    pages: 80 + Math.floor(next() * 600),
  }));
})();

const PAGE = `<html><body>
<h1>Prosebook API reference</h1>
<p>The Prosebook API gives read access to your library. All requests go to
https://${HOST}/v2 and must carry your API key in the X-Key header. You can find
your key under Settings, then Developer. Responses are JSON.</p>
<h2>Books</h2>
<p>GET /books returns every book in your library as an object with a "books"
array. Each book has an id, a title, a genre and a page count ("pages"). The
list is not paginated: every book comes back in one response.</p>
<pre>curl https://${HOST}/v2/books -H "X-Key: YOUR_KEY"</pre>
<h2>Errors</h2>
<p>A missing or wrong key returns 401. Unknown paths return 404. We do not
rate limit reads at the volumes a library produces.</p>
</body></html>`;

export const prosebook: MockProvider = {
  id: "prosebook",
  split: "dev",
  pattern: "Prose documentation only: no specification to read",
  hosts: [HOST, DOCS],
  docsUrl: `https://${DOCS}/reference`,
  credentials: [KEY],
  reference: {
    connection: {
      id: "prosebook",
      title: "Prosebook",
      kind: "rest",
      baseUrl: `https://${HOST}/v2`,
      auth: { type: "header", header: "X-Key", keyRef: "prosebook-key" },
      ops: [{ id: "books", title: "List books", path: "/books", rowsPath: "$.books" }],
    },
    secrets: { "prosebook-key": KEY },
  },
  scriptedModel: {
    propose_dialect: {
      title: "Prosebook",
      baseUrl: `https://${HOST}/v2`,
      authType: "header",
      authName: "X-Key",
      paginationKind: "none",
      rowsPath: "$.books",
      endpoints: [{ id: "books", title: "List books", path: "/books", archetype: "list" }],
    },
  },
  objectives: [
    {
      id: "book-count",
      request: "How many books are in the library?",
      answer: books.length,
      tolerance: 0,
      records: books.length,
      scripted: { path: "/books", measure: { agg: "count" } },
    },
    {
      id: "history-pages",
      request: "How many pages of history books do we have?",
      answer: books.filter((one) => one.genre === "history").reduce((sum, one) => sum + one.pages, 0),
      tolerance: 0,
      records: books.length,
      scripted: {
        path: "/books",
        measure: { agg: "sum", field: "pages", where: 'genre == "history"' },
      },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.hostname === DOCS) return url.pathname === "/reference" ? html(PAGE) : notFound();
    if (request.headers["x-key"] !== KEY) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/v2/books") return json({ books });
    return notFound();
  },
};
