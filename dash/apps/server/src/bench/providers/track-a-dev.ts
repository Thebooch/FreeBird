import { bearerOf, intParam, json, notFound, pick, random } from "../seed.js";
import type { MockProvider } from "../types.js";

/**
 * Dev-set providers for track A. Tuned against freely.
 */

/* ── Casebook: records only through a search the request must write ─────── */

/*
 * A case-management API whose only list is a search. The search expression is
 * required, and so is a bound on when the cases were opened: an unbounded
 * search is refused. Nothing in the specification says what to send to read
 * every case; its documentation does, in words — which is the gap a check that
 * could only change an address or a header could not close.
 */

const C_HOST = "api.casebook.bench.test";
const C_KEY = "cb_live_7f3a91";
const C_PAGE = 50;

const cases = (() => {
  const next = random(20931);
  const start = Date.UTC(2024, 0, 1);
  const span = Date.UTC(2026, 8, 1) - start;
  return Array.from({ length: 380 }, (_, index) => ({
    id: `CASE-${10_000 + index}`,
    title: pick(next, ["Billing dispute", "Access request", "Data correction", "Contract review", "Complaint"] as const),
    status: pick(next, ["open", "open", "pending", "closed", "closed", "closed"] as const),
    priority: pick(next, ["low", "normal", "normal", "high"] as const),
    opened: new Date(start + Math.floor((index / 380) * span) + Math.floor(next() * 86_400_000)).toISOString().slice(0, 10),
  }));
})();

type Term = (one: (typeof cases)[number]) => boolean;

/** The search grammar: `status:open`, `priority:high`, `opened>=2026-01-01`, `opened<=2026-06-30`. */
const parse = (q: string): { terms: Term[]; bounded: boolean } | { error: string } => {
  const terms: Term[] = [];
  let bounded = false;
  for (const word of q.trim().split(/\s+/).filter(Boolean)) {
    const field = /^(status|priority):([a-z]+)$/.exec(word);
    const range = /^opened(>=|<=)(\d{4}-\d{2}-\d{2})$/.exec(word);
    if (field) terms.push((one) => one[field[1] as "status" | "priority"] === field[2]);
    else if (range) {
      bounded = true;
      terms.push((one) => (range[1] === ">=" ? one.opened >= range[2]! : one.opened <= range[2]!));
    } else return { error: `Unknown search term "${word}". Terms are status:, priority:, opened>= and opened<=.` };
  }
  return { terms, bounded };
};

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Casebook",
    version: "2",
    description:
      "Cases are read through search. Every search needs q, and every q must be bounded by when the cases were opened: " +
      "include opened>= or opened<= with a date (YYYY-MM-DD). To read every case, bound it by the earliest date there could be, " +
      "for example opened>=1970-01-01. Other terms narrow: status:open, priority:high.",
  },
  servers: [{ url: `https://${C_HOST}/v2` }],
  components: { securitySchemes: { key: { type: "http", scheme: "bearer" } } },
  security: [{ key: [] }],
  paths: {
    "/cases/search": {
      get: {
        operationId: "searchCases",
        summary: "Search cases",
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "The search. Must include opened>= or opened<=, e.g. opened>=2026-01-01 status:open.",
          },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "next_cursor from the previous page." },
          { name: "limit", in: "query", schema: { type: "integer", maximum: C_PAGE, default: C_PAGE } },
        ],
        responses: {
          "200": {
            description: "A page of cases",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    cases: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          title: { type: "string" },
                          status: { type: "string", enum: ["open", "pending", "closed"] },
                          priority: { type: "string", enum: ["low", "normal", "high"] },
                          opened: { type: "string", format: "date" },
                        },
                      },
                    },
                    total: { type: "integer" },
                    next_cursor: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          "400": { description: "q is missing, unbounded, or has a term the search does not know." },
        },
      },
    },
  },
};

export const casebook: MockProvider = {
  id: "casebook",
  split: "dev",
  pattern: "Records only through a search whose expression is required and must be bounded by date; cursor paging",
  hosts: [C_HOST],
  docsUrl: `https://${C_HOST}/openapi.json`,
  credentials: [C_KEY],
  /* CI's mechanics: the value the documentation says reads every case. */
  scriptedModel: {
    propose_repair: {
      reason: "Every search needs q bounded by opened date; the documentation says opened>=1970-01-01 reads every case.",
      inputs: [{ name: "q", value: "opened>=1970-01-01" }],
    },
  },
  reference: {
    connection: {
      id: "casebook",
      title: "Casebook",
      kind: "rest",
      baseUrl: `https://${C_HOST}/v2`,
      auth: { type: "bearer", keyRef: "casebook-key" },
      ops: [
        {
          id: "cases",
          title: "Search cases",
          path: "/cases/search",
          query: { q: "opened>=1970-01-01" },
          rowsPath: "$.cases",
          pagination: { kind: "cursor", cursorPath: "$.next_cursor", param: "cursor" },
          maxPages: 20,
        },
      ],
    },
    secrets: { "casebook-key": C_KEY },
  },
  objectives: [
    {
      id: "open-cases",
      request: "How many cases are open?",
      answer: cases.filter((one) => one.status === "open").length,
      tolerance: 0,
      records: cases.length,
      scripted: { path: "/cases/search", measure: { agg: "count", where: 'status == "open"' } },
    },
  ],
  handle(request) {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(spec);
    if (bearerOf(request) !== C_KEY) return json({ error: "A valid API key is required." }, 401);
    if (url.pathname !== "/v2/cases/search") return notFound();
    const q = url.searchParams.get("q");
    if (q === null || q.trim() === "") return json({ error: "q is required: a search expression." }, 400);
    const parsed = parse(q);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    if (!parsed.bounded)
      return json(
        { error: "Unbounded searches are not allowed. Restrict q with opened>= or opened<= (for example opened>=2026-01-01)." },
        400,
      );
    const matching = cases.filter((one) => parsed.terms.every((term) => term(one)));
    const limit = Math.min(C_PAGE, Math.max(1, intParam(request, "limit", C_PAGE)));
    const cursor = url.searchParams.get("cursor");
    const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8").replace(/^o:/, "")) || 0 : 0;
    const page = matching.slice(offset, offset + limit);
    const after = offset + page.length;
    return json({
      cases: page,
      total: matching.length,
      next_cursor: after < matching.length ? Buffer.from(`o:${after}`, "utf8").toString("base64url") : null,
    });
  },
};

/* ── Gazette: answers in XML, and a table of rows ──────────────────────── */

/*
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
