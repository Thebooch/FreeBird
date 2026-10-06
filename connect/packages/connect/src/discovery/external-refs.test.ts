import { describe, expect, it } from "vitest";
import { resolveExternalRefs } from "./external-refs.js";
import { parseOpenApi } from "./openapi.js";

/*
 * A specification split across files: paths and schemas in files of their
 * own, referred to with `$ref`. It used to import as nothing at all.
 */

const SPEC_URL = "https://api.split.dev/openapi.yaml";

const files: Record<string, string> = {
  "https://api.split.dev/paths/invoices.yaml": [
    "get:",
    "  summary: List invoices",
    "  responses:",
    "    '200':",
    "      content:",
    "        application/json:",
    "          schema:",
    "            $ref: '../schemas/invoice-list.json'",
  ].join("\n"),
  "https://api.split.dev/schemas/invoice-list.json": JSON.stringify({
    type: "object",
    properties: { data: { type: "array", items: { $ref: "#/definitions/Invoice" } } },
    definitions: {
      Invoice: {
        type: "object",
        properties: { id: { type: "string" }, total: { type: "number" }, status: { type: "string", enum: ["paid", "open"] } },
      },
    },
  }),
  "https://elsewhere.dev/schemas/customer.json": JSON.stringify({ type: "object" }),
};

const reads: string[] = [];
const fetchDocument = async (url: string) => {
  reads.push(url);
  const text = files[url];
  return text === undefined ? { status: 404, text: "", url } : { status: 200, text, url };
};

const spec = {
  openapi: "3.0.0",
  info: { title: "Split" },
  servers: [{ url: "https://api.split.dev/v1" }],
  paths: {
    "/invoices": { $ref: "paths/invoices.yaml" },
    "/customers": {
      get: {
        summary: "List customers",
        responses: { "200": { content: { "application/json": { schema: { $ref: "https://elsewhere.dev/schemas/customer.json" } } } } },
      },
    },
    "/ping": { get: { summary: "Ping", responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Pong" } } } } } } },
  },
  components: { schemas: { Pong: { type: "object", properties: { ok: { type: "boolean" } } } } },
};

describe("resolveExternalRefs", () => {
  it("puts a split specification back together, so its endpoints and fields import", async () => {
    const whole = await resolveExternalRefs(spec, SPEC_URL, fetchDocument);
    expect(whole.read).toBe(2);
    const parsed = parseOpenApi(whole.doc, SPEC_URL)!;
    const invoices = parsed.entry.ops.find((op) => op.title === "List invoices");
    expect(invoices?.path).toBe("/invoices");
    expect(invoices?.fields?.map((field) => field.name)).toEqual(expect.arrayContaining(["id", "total", "status"]));
    expect(invoices?.fields?.find((field) => field.name === "status")?.values).toEqual(["paid", "open"]);
  });

  it("follows nothing off the specification's own site, and says so", async () => {
    reads.length = 0;
    const whole = await resolveExternalRefs(spec, SPEC_URL, fetchDocument);
    expect(reads.some((url) => url.includes("elsewhere.dev"))).toBe(false);
    expect(whole.unresolved).toContain("https://elsewhere.dev/schemas/customer.json");
  });

  it("leaves the main document's own references for the importer", async () => {
    const whole = await resolveExternalRefs(spec, SPEC_URL, fetchDocument);
    const ping = (whole.doc as typeof spec).paths["/ping"].get.responses["200"].content["application/json"].schema;
    expect(ping).toEqual({ $ref: "#/components/schemas/Pong" });
  });

  it("returns a document with no external references as it was, reading nothing", async () => {
    reads.length = 0;
    const plain = { ...spec, paths: { "/ping": spec.paths["/ping"] } };
    const whole = await resolveExternalRefs(plain, SPEC_URL, fetchDocument);
    expect(whole.doc).toBe(plain);
    expect(reads).toEqual([]);
  });

  it("stops at a reference that comes back round to itself", async () => {
    const loop = {
      "https://api.split.dev/a.json": JSON.stringify({ type: "object", properties: { next: { $ref: "b.json" } } }),
      "https://api.split.dev/b.json": JSON.stringify({ type: "object", properties: { back: { $ref: "a.json" } } }),
    };
    const fetchLoop = async (url: string) => ({ status: 200, text: loop[url as keyof typeof loop] ?? "{}", url });
    const whole = await resolveExternalRefs({ openapi: "3.0.0", paths: { "/x": { $ref: "a.json" } } }, SPEC_URL, fetchLoop);
    expect(JSON.stringify(whole.doc)).toContain('"$ref":"a.json"');
  });
});
