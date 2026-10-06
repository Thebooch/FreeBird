import { html, intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Drawnhub: documentation that is an empty page until its script runs. The
 * script fetches the reference and draws it — and only the drawn page links
 * to the OpenAPI document, at an address no well-known guess reaches. A plain
 * read of the page finds nothing; a browser that draws it finds the
 * specification.
 *
 * Written for the kind of gap it tests, without reading any held-out provider.
 */

const DOCS = "docs.drawnhub.bench.test";
const API = "api.drawnhub.bench.test";
const KEY = "dh_live_5520";
const PER_PAGE = 25;

export const dhTickets = (() => {
  const next = random(6610);
  return Array.from({ length: 140 }, (_, index) => ({
    id: `tk_${index + 1}`,
    subject: `Ticket ${index + 1}`,
    status: pick(next, ["open", "open", "pending", "closed"] as const),
    priority: pick(next, ["low", "normal", "high"] as const),
  }));
})();

/* The page as served: a shell, and a script that fills it in. */
const shell = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Drawnhub API</title></head>
  <body>
    <div id="app"></div>
    <script src="/assets/app.js"></script>
  </body>
</html>`;

const script = `
fetch("/assets/reference.json")
  .then((response) => response.json())
  .then((reference) => {
    const endpoints = reference.endpoints
      .map((one) => "<h2>" + one.method + " " + one.path + "</h2><p>" + one.summary + "</p>")
      .join("");
    document.getElementById("app").innerHTML =
      "<h1>" + reference.title + "</h1>" +
      "<p>" + reference.intro + "</p>" +
      "<p>The whole reference is published as an <a href=\\"" + reference.document + "\\">OpenAPI document</a>.</p>" +
      endpoints;
  });
`;

const reference = {
  title: "Drawnhub API",
  intro: "Drawnhub keeps your support tickets. Send your key in the X-Drawnhub-Key header.",
  document: "/assets/drawnhub-openapi.json",
  endpoints: [{ method: "GET", path: "/v1/tickets", summary: "Every ticket, 25 to a page." }],
};

const specification = {
  openapi: "3.0.3",
  info: { title: "Drawnhub", version: "1" },
  servers: [{ url: `https://${API}/v1` }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Drawnhub-Key" } } },
  security: [{ key: [] }],
  paths: {
    "/tickets": {
      get: {
        summary: "List tickets",
        parameters: [{ name: "page", in: "query", description: "Which page, from 1.", schema: { type: "integer", default: 1 } }],
        responses: {
          "200": {
            description: "Twenty-five tickets; fewer on the last page.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tickets: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          subject: { type: "string" },
                          status: { type: "string", enum: ["open", "pending", "closed"] },
                          priority: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export const drawnhub: MockProvider = {
  id: "drawnhub",
  split: "dev",
  pattern: "documentation drawn by its own script; only the drawn page links to the OpenAPI document",
  hosts: [DOCS, API],
  docsUrl: `https://${DOCS}/`,
  credentials: [KEY],
  credentialLabels: ["API key"],
  needs: "browser",
  reference: {
    connection: {
      id: "drawnhub",
      title: "Drawnhub",
      kind: "rest",
      baseUrl: `https://${API}/v1`,
      auth: { type: "header", header: "X-Drawnhub-Key", keyRef: "drawnhub-key" },
      ops: [
        {
          id: "tickets",
          title: "List tickets",
          path: "/tickets",
          rowsPath: "$.tickets",
          pagination: { kind: "page", param: "page", startsAt: 1 },
          paginationChecked: true,
        },
      ],
    },
    secrets: { "drawnhub-key": KEY },
  },
  objectives: [
    {
      id: "open-tickets",
      request: "How many tickets are open?",
      answer: dhTickets.filter((one) => one.status === "open").length,
      tolerance: 0,
      records: dhTickets.length,
      scripted: { path: "/tickets", measure: { agg: "count", where: 'status == "open"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === DOCS) {
      if (url.pathname === "/" || url.pathname === "/index.html") return html(shell);
      if (url.pathname === "/assets/app.js") return { status: 200, headers: { "content-type": "text/javascript" }, body: script };
      if (url.pathname === "/assets/reference.json") return json(reference);
      if (url.pathname === "/assets/drawnhub-openapi.json") return json(specification);
      return notFound();
    }
    if (request.headers["x-drawnhub-key"] !== KEY) return json({ error: "X-Drawnhub-Key is required" }, 401);
    if (url.pathname !== "/v1/tickets") return notFound();
    const page = Math.max(1, intParam(request, "page", 1));
    return json({ tickets: dhTickets.slice((page - 1) * PER_PAGE, page * PER_PAGE) });
  },
};
