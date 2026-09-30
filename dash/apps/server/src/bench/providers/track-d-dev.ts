import { bearerOf, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Dev-set providers for track D (completeness). Tuned against freely.
 */

/* ── Linkfold: the next page is an address only the answer knows ───────── */

/*
 * A fleet API that pages the way HAL does: each answer carries
 * `_links.next.href`, an address with a token only the server can read. Its
 * specification declares no paging parameter and states no total, and pages
 * hold 30 records — not a size anything would recognise as a full page. The
 * only way to read past the first is to follow the address.
 */

const HOST = "api.linkfold.bench.test";
const KEY = "lf_live_a41c07";
const PAGE = 30;

const vehicles = (() => {
  const next = random(55102);
  return Array.from({ length: 214 }, (_, index) => ({
    id: `veh_${7000 + index}`,
    plate: `${pick(next, ["KX", "LB", "MT", "NR"] as const)}-${1000 + Math.floor(next() * 9000)}`,
    kind: pick(next, ["van", "van", "truck", "car"] as const),
    state: pick(next, ["in_service", "in_service", "in_service", "in_repair", "retired"] as const),
    odometer_km: 5_000 + Math.floor(next() * 240_000),
  }));
})();

const tokenOf = (start: number): string => Buffer.from(`v1:${start}:${(start * 7919) % 9973}`, "utf8").toString("base64url");
const startOf = (token: string | null): number | null => {
  if (token === null) return 0;
  const [version, start, check] = Buffer.from(token, "base64url").toString("utf8").split(":");
  const at = Number(start);
  return version === "v1" && Number.isInteger(at) && Number(check) === (at * 7919) % 9973 ? at : null;
};

const SPEC = {
  openapi: "3.0.3",
  info: {
    title: "Linkfold Fleet",
    version: "1",
    description: "Read access to your fleet. Responses follow HAL: related addresses are under _links.",
  },
  servers: [{ url: `https://${HOST}/fleet/v1` }],
  components: { securitySchemes: { key: { type: "http", scheme: "bearer" } } },
  security: [{ key: [] }],
  paths: {
    "/vehicles": {
      get: {
        operationId: "listVehicles",
        summary: "List vehicles",
        responses: {
          "200": {
            description: "Vehicles, with links.",
            content: {
              "application/hal+json": {
                schema: {
                  type: "object",
                  properties: {
                    _embedded: {
                      type: "object",
                      properties: {
                        vehicles: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              plate: { type: "string" },
                              kind: { type: "string", enum: ["van", "truck", "car"] },
                              state: { type: "string", enum: ["in_service", "in_repair", "retired"] },
                              odometer_km: { type: "integer" },
                            },
                          },
                        },
                      },
                    },
                    _links: { type: "object" },
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

export const linkfold: MockProvider = {
  id: "linkfold",
  split: "dev",
  pattern: "The next page is an address in the answer (HAL), carrying a token no parameter declares; no total, an unusual page size",
  hosts: [HOST],
  docsUrl: `https://${HOST}/openapi.json`,
  credentials: [KEY],
  reference: {
    connection: {
      id: "linkfold",
      title: "Linkfold",
      kind: "rest",
      baseUrl: `https://${HOST}/fleet/v1`,
      auth: { type: "bearer", keyRef: "linkfold-key" },
      ops: [
        {
          id: "vehicles",
          title: "List vehicles",
          path: "/vehicles",
          rowsPath: "$._embedded.vehicles",
          pagination: { kind: "next-url", path: "$._links.next" },
          maxPages: 20,
        },
      ],
    },
    secrets: { "linkfold-key": KEY },
  },
  objectives: [
    {
      id: "vehicles-in-repair",
      request: "How many vehicles are in repair?",
      answer: vehicles.filter((one) => one.state === "in_repair").length,
      tolerance: 0,
      records: vehicles.length,
      scripted: { path: "/vehicles", measure: { agg: "count", where: 'state == "in_repair"' } },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(SPEC);
    if (bearerOf(request) !== KEY) return json({ message: "A valid API key is required." }, 401);
    if (url.pathname !== "/fleet/v1/vehicles") return notFound();
    const start = startOf(url.searchParams.get("continue"));
    if (start === null) return json({ message: "That continuation is not one this API issued." }, 400);
    const after = start + PAGE;
    return json(
      {
        _embedded: { vehicles: vehicles.slice(start, after) },
        _links: {
          self: { href: url.pathname + url.search },
          ...(after < vehicles.length ? { next: { href: `/fleet/v1/vehicles?continue=${tokenOf(after)}` } } : {}),
        },
      },
      200,
      { "content-type": "application/hal+json" },
    );
  },
};
