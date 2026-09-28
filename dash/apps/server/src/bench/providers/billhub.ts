import { bearerOf, cents, html, json, major, notFound, pick, random } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Billhub: a specification that points at the wrong address.
 *
 * The pattern, and a common one: the specification is served from the
 * documentation site and names its server relatively (`/v1`), so an importer
 * resolves the API to the documentation host. The documentation's own text
 * names the real address. A person would read it; so should the loop.
 */

const TOKEN = "bh_live_c4";
const DOCS = "docs.billhub.bench.test";
const API = "api.billhub.bench.test";

const bills = (() => {
  const next = random(6606);
  return Array.from({ length: 64 }, (_, index) => ({
    id: `bill_${index + 1}`,
    vendor: pick(next, ["Acme Supply", "Northwind", "Globex", "Initech"] as const),
    status: pick(next, ["unpaid", "paid", "paid"] as const),
    amount: major(cents(next, 20, 1800)),
  }));
})();

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Billhub", version: "1" },
  servers: [{ url: "/v1" }],
  components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
  security: [{ token: [] }],
  paths: {
    "/bills": {
      get: {
        summary: "List bills",
        responses: {
          "200": {
            description: "Every bill.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    bills: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          vendor: { type: "string" },
                          status: { type: "string", enum: ["unpaid", "paid"] },
                          amount: { type: "number" },
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

const PAGE = `<html><body>
<h1>Billhub API</h1>
<p>The Billhub API lives at https://${API}/v1 and answers in JSON. Authenticate with
your API token as a bearer token. The full reference is our
<a href="https://${DOCS}/openapi.json">OpenAPI document</a>.</p>
<pre>curl https://${API}/v1/bills -H "Authorization: Bearer YOUR_TOKEN"</pre>
</body></html>`;

export const billhub: MockProvider = {
  id: "billhub",
  split: "dev",
  pattern: "The specification's relative server resolves to the documentation host; the docs name the real API address",
  hosts: [DOCS, API],
  docsUrl: `https://${DOCS}/`,
  credentials: [TOKEN],
  reference: {
    connection: {
      id: "billhub",
      title: "Billhub",
      kind: "rest",
      baseUrl: `https://${API}/v1`,
      auth: { type: "bearer", keyRef: "billhub-key" },
      ops: [{ id: "bills", title: "List bills", path: "/bills", rowsPath: "$.bills" }],
    },
    secrets: { "billhub-key": TOKEN },
  },
  objectives: [
    {
      id: "unpaid-total",
      request: "How much do we owe on unpaid bills?",
      answer: major(
        bills.filter((one) => one.status === "unpaid").reduce((sum, one) => sum + Math.round(one.amount * 100), 0),
      ),
      tolerance: 0.005,
      records: bills.length,
      scripted: { path: "/bills", measure: { agg: "sum", field: "amount", where: 'status == "unpaid"' } },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.hostname === DOCS) {
      if (url.pathname === "/") return html(PAGE);
      if (url.pathname === "/openapi.json") return json(SPEC);
      /* The documentation site has no API behind it: an HTML 404, like a real one. */
      return { status: 404, headers: { "content-type": "text/html" }, body: "<html><body><h1>Page not found</h1></body></html>" };
    }
    if (bearerOf(request) !== TOKEN) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/v1/bills") return json({ bills });
    return notFound();
  },
};
