import { bearerOf, json, notFound, random } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Keyring: a specification that names the wrong sign-in header.
 *
 * The pattern: the security scheme says `X-API-KEY`, but the API only
 * accepts a bearer token — and the specification's own overview says so.
 * Every request the importer's reading sends is refused as unauthorised,
 * though the key is right.
 */

const KEY = "kr_2718";
const HOST = "api.keyring.bench.test";

const contacts = (() => {
  const next = random(7707);
  return Array.from({ length: 90 }, (_, index) => ({
    id: index + 1,
    name: `Contact ${index + 1}`,
    vip: next() < 0.2,
  }));
})();

const SPEC = {
  openapi: "3.0.3",
  info: {
    title: "Keyring CRM",
    version: "1",
    description:
      "Authenticate by sending your API key as a Bearer token in the Authorization header: Authorization: Bearer YOUR_KEY.",
  },
  servers: [{ url: `https://${HOST}` }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-API-KEY" } } },
  security: [{ key: [] }],
  paths: {
    "/contacts": {
      get: {
        summary: "List contacts",
        responses: {
          "200": {
            description: "Every contact.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "integer" }, name: { type: "string" }, vip: { type: "boolean" } },
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

export const keyring: MockProvider = {
  id: "keyring",
  split: "dev",
  pattern: "The security scheme names the wrong header; the overview says to send a bearer token",
  hosts: [HOST],
  docsUrl: `https://${HOST}/openapi.json`,
  credentials: [KEY],
  reference: {
    connection: {
      id: "keyring",
      title: "Keyring",
      kind: "rest",
      baseUrl: `https://${HOST}`,
      auth: { type: "bearer", keyRef: "keyring-key" },
      ops: [{ id: "contacts", title: "List contacts", path: "/contacts" }],
    },
    secrets: { "keyring-key": KEY },
  },
  objectives: [
    {
      id: "vip-count",
      request: "How many VIP contacts do we have?",
      answer: contacts.filter((one) => one.vip).length,
      tolerance: 0,
      records: contacts.length,
      scripted: { path: "/contacts", measure: { agg: "count", where: "vip == true" } },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(SPEC);
    if (bearerOf(request) !== KEY) return json({ error: "invalid credentials" }, 401);
    if (url.pathname === "/contacts") return json(contacts);
    return notFound();
  },
};
