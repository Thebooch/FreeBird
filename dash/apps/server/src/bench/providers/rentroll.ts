import { cents, json, major, notFound, pick, random } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Rentroll: a property API that wraps each record and pages by cursor.
 *
 * The pattern, taken from a real API: each row is `{ lease: {…} }` though the
 * specification describes a flat lease, the cursor comes back as
 * `meta.next`, not the `next_cursor` an importer guesses, and sign-in is
 * Basic with an access key as the username and a secret as the password.
 */

const USER = "rr_access_91";
const SECRET = "rr_secret_b3";
const HOST = "acme.rentroll.bench.test";
const PAGE = 50;

const leases = (() => {
  const next = random(3303);
  return Array.from({ length: 180 }, (_, index) => ({
    lease: {
      leaseID: 5000 + index,
      status: pick(next, ["active", "active", "active", "ended", "pending"] as const),
      rent: major(cents(next, 900, 3200)),
    },
    unit: { unitID: 100 + (index % 60), name: `Unit ${100 + (index % 60)}` },
  }));
})();

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Rentroll Manager API", version: "1" },
  servers: [{ url: `https://${HOST}/api/manager` }],
  tags: [
    {
      name: "Authentication",
      description:
        "Requests use HTTP Basic authentication with the access key as the username and the secret as the password.",
    },
  ],
  components: { securitySchemes: { basic: { type: "http", scheme: "basic" } } },
  security: [{ basic: [] }],
  paths: {
    "/leases": {
      get: {
        summary: "List leases",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "page_size", in: "query", schema: { type: "integer", maximum: PAGE } },
        ],
        responses: {
          "200": {
            description: "Leases.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    leases: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          leaseID: { type: "integer" },
                          status: { type: "string" },
                          rent: { type: "number" },
                        },
                      },
                    },
                    meta: { type: "object", properties: { next: { type: "string", nullable: true } } },
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

export const rentroll: MockProvider = {
  id: "rentroll",
  split: "dev",
  pattern: "Wrapped records the spec describes flat; cursor in meta.next; Basic auth with key and secret",
  hosts: [HOST],
  docsUrl: `https://${HOST}/api/manager/openapi.json`,
  credentials: [USER, SECRET],
  reference: {
    connection: {
      id: "rentroll",
      title: "Rentroll",
      kind: "rest",
      baseUrl: `https://${HOST}/api/manager`,
      auth: { type: "basic", usernameRef: "rentroll-user", keyRef: "rentroll-key" },
      ops: [
        {
          id: "leases",
          title: "List leases",
          path: "/leases",
          rowsPath: "$.leases",
          pagination: { kind: "cursor", param: "cursor", cursorPath: "$.meta.next" },
          maxPages: 10,
        },
      ],
    },
    secrets: { "rentroll-user": USER, "rentroll-key": SECRET },
  },
  objectives: [
    {
      id: "active-leases",
      request: "How many active leases do we have?",
      answer: leases.filter((one) => one.lease.status === "active").length,
      tolerance: 0,
      records: leases.length,
      scripted: { path: "/leases", measure: { agg: "count", where: 'lease.status == "active"' } },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.pathname === "/api/manager/openapi.json") return json(SPEC);
    const expected = `Basic ${Buffer.from(`${USER}:${SECRET}`).toString("base64")}`;
    if (request.headers.authorization !== expected) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/api/manager/leases") {
      const start = Number(url.searchParams.get("cursor") ?? "0") || 0;
      const size = Math.min(PAGE, Number(url.searchParams.get("page_size") ?? PAGE) || PAGE);
      const end = start + size;
      return json({
        leases: leases.slice(start, end),
        meta: { next: end < leases.length ? String(end) : null },
      });
    }
    return notFound();
  },
};
