import { intParam, json, notFound, pick, random } from "../seed.js";
import type { MockProvider } from "../types.js";

/**
 * Gazette: answers in XML, and a table of rows.
 *
 * A public-notices API from before JSON: lists answer in XML, numbered pages
 * with the count as an attribute of the top element, and the subscriber list
 * is a CSV file. Nothing here needs code: the answers only have to be read as
 * what they say they are.
 */

const G_HOST = "api.gazette.bench.test";
const G_KEY = "gz_live_5b90e2";
const G_PAGE = 40;

const notices = (() => {
  const next = random(77031);
  return Array.from({ length: 173 }, (_, index) => ({
    id: `N-${3000 + index}`,
    kind: pick(next, ["planning", "licensing", "probate", "insolvency"] as const),
    status: pick(next, ["published", "published", "published", "draft", "withdrawn"] as const),
    words: 60 + Math.floor(next() * 900),
    title: `${pick(next, ["Notice of", "Application for", "Order on"] as const)} matter ${index + 1} & others`,
  }));
})();

const subscribers = (() => {
  const next = random(12880);
  return Array.from({ length: 96 }, (_, index) => ({
    id: 500 + index,
    name: `${pick(next, ["Ada", "Ben", "Cy", "Dee", "Eli"] as const)} ${pick(next, ["Okoro", "Lind", "Marsh, Jr.", "Vale"] as const)}`,
    plan: pick(next, ["free", "free", "standard", "premium"] as const),
    postcode: `0${1000 + Math.floor(next() * 8999)}`,
  }));
})();

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const csvCell = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

const gazetteSpec = {
  openapi: "3.0.3",
  info: { title: "Gazette", version: "1", description: "Public notices and who subscribes to them. Lists answer in XML; exports are CSV." },
  servers: [{ url: `https://${G_HOST}/v1` }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Gazette-Key" } } },
  security: [{ key: [] }],
  paths: {
    "/notices": {
      get: {
        operationId: "listNotices",
        summary: "List notices",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", default: 1 } }],
        responses: {
          "200": {
            description: `Notices, ${G_PAGE} to a page. The notices element says how many there are in all (total) and which page this is.`,
            content: { "application/xml": { schema: { type: "object", xml: { name: "notices" } } } },
          },
        },
      },
    },
    "/subscribers.csv": {
      get: {
        operationId: "exportSubscribers",
        summary: "Export subscribers",
        responses: { "200": { description: "Every subscriber, one a row.", content: { "text/csv": { schema: { type: "string" } } } } },
      },
    },
  },
};

export const gazette: MockProvider = {
  id: "gazette",
  split: "dev",
  pattern: "Answers in XML (numbered pages, the count an attribute of the top element) and a CSV export: no JSON anywhere, and no code needed",
  hosts: [G_HOST],
  docsUrl: `https://${G_HOST}/openapi.json`,
  credentials: [G_KEY],
  reference: {
    connection: {
      id: "gazette",
      title: "Gazette",
      kind: "rest",
      baseUrl: `https://${G_HOST}/v1`,
      auth: { type: "header", header: "X-Gazette-Key", keyRef: "gazette-key" },
      ops: [
        {
          id: "notices",
          title: "List notices",
          path: "/notices",
          rowsPath: "$.notices.notice",
          pagination: { kind: "page", param: "page", startsAt: 1 },
          maxPages: 10,
        },
        { id: "subscribers", title: "Export subscribers", path: "/subscribers.csv", rowsPath: "$" },
      ],
    },
    secrets: { "gazette-key": G_KEY },
  },
  objectives: [
    {
      id: "published-notices",
      request: "How many notices are published?",
      answer: notices.filter((one) => one.status === "published").length,
      tolerance: 0,
      records: notices.length,
      scripted: { path: "/notices", measure: { agg: "count", where: 'status == "published"' } },
    },
    {
      id: "premium-subscribers",
      request: "How many subscribers are on the premium plan?",
      answer: subscribers.filter((one) => one.plan === "premium").length,
      tolerance: 0,
      records: subscribers.length,
      scripted: { path: "/subscribers.csv", measure: { agg: "count", where: 'plan == "premium"' } },
    },
  ],
  handle(request) {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(gazetteSpec);
    if (request.headers["x-gazette-key"] !== G_KEY)
      return { status: 401, headers: { "content-type": "application/xml" }, body: "<error><message>A valid key is required.</message></error>" };
    if (url.pathname === "/v1/subscribers.csv")
      return {
        status: 200,
        headers: { "content-type": "text/csv; charset=utf-8" },
        body: ["id,name,plan,postcode", ...subscribers.map((one) => [String(one.id), csvCell(one.name), one.plan, one.postcode].join(","))].join("\r\n"),
      };
    if (url.pathname !== "/v1/notices") return notFound();
    const page = Math.max(1, intParam(request, "page", 1));
    const slice = notices.slice((page - 1) * G_PAGE, page * G_PAGE);
    return {
      status: 200,
      headers: { "content-type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="UTF-8"?>\n<notices total="${notices.length}" page="${page}">${slice
        .map(
          (one) =>
            `<notice id="${one.id}"><kind>${one.kind}</kind><status>${one.status}</status><words>${one.words}</words><title>${escapeXml(one.title)}</title></notice>`,
        )
        .join("")}</notices>`,
    };
  },
};
