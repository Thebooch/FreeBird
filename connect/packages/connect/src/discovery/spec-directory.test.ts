import { describe, expect, it } from "vitest";
import { rereadSpec } from "./connect-details.js";
import { discover } from "./index.js";
import { mergeSpecDocuments } from "./merge-specs.js";
import { specLinksIn } from "./openapi.js";
import { specDirectoryIn } from "./spec-directory.js";

/**
 * An API that publishes a list of per-service specifications instead of one
 * document. The docs site lists no spec of its own: its `llms.txt` links the
 * list, at an address with no file extension.
 */

const DIRECTORY = "https://api.multi.test/v1/openapi";

const service = (title: string, resource: string, errorField: string) => ({
  openapi: "3.0.3",
  info: { title },
  servers: [{ url: "https://api.multi.test/v1" }],
  security: [{ ApiKeyAuth: [] }],
  paths: {
    [`/${resource}`]: {
      get: {
        operationId: `list-${resource}`,
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } } },
      },
      post: {
        operationId: `launch-${resource}`,
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } },
        responses: {
          "201": { description: "ok" },
          "400": { description: "bad", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    [`/${resource}/{id}`]: {
      get: {
        operationId: `get-${resource}`,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
  components: {
    securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" } },
    schemas: { Error: { type: "object", properties: { [errorField]: { type: "string" } } } },
  },
});

const site = (extra: Record<string, string> = {}) => {
  const documents: Record<string, string> = {
    "https://docs.multi.test/api/introduction": "# API\n\nFetch the index at: https://docs.multi.test/llms.txt\n",
    "https://docs.multi.test/llms.txt": `# Multi\n\n- [Specs](${DIRECTORY}): Machine-readable API specifications\n`,
    [DIRECTORY]: JSON.stringify({
      specs: [
        { name: "agents", url: `${DIRECTORY}/agents` },
        { name: "runs", url: `${DIRECTORY}/runs` },
      ],
    }),
    [`${DIRECTORY}/agents`]: JSON.stringify(service("Multi Agents API", "agents", "message")),
    [`${DIRECTORY}/runs`]: JSON.stringify(service("Multi Runs API", "runs", "detail")),
    ...extra,
  };
  return async (url: string) => {
    const text = documents[url];
    return text === undefined ? { status: 404, text: "not found", url } : { status: 200, text, url };
  };
};

describe("a directory of specifications", () => {
  it("imports every service from a docs page, reads and changes alike", async () => {
    const found = await discover("https://docs.multi.test/api/introduction", { fetchDocument: site() });

    expect(found.source).toBe("openapi");
    expect(found.entry?.ops.map((op) => op.path).sort()).toEqual([
      "/agents",
      "/agents/{{param.id}}",
      "/runs",
      "/runs/{{param.id}}",
    ]);
    expect(found.entry?.writes?.map((write) => write.path).sort()).toEqual(["/agents", "/runs"]);
    expect(found.entry?.title).toBe("Multi API");
    expect(found.entry?.specUrl).toBe(DIRECTORY);
    expect(found.tried).toContain(`${DIRECTORY}/runs`);
    expect(found.warnings.join(" ")).toMatch(/2 specifications/);
  });

  it("reads the directory when it is the address given", async () => {
    const found = await discover(DIRECTORY, { fetchDocument: site() });
    expect(found.entry?.ops).toHaveLength(4);
  });

  it("reads the same again from the entry's own address", async () => {
    const parsed = await rereadSpec(DIRECTORY, site());
    expect(parsed.entry.writes).toHaveLength(2);
  });

  it("says which specification could not be read, and imports the rest", async () => {
    const fetchDocument = site({ [`${DIRECTORY}/runs`]: "<html>gone</html>" });
    const found = await discover(DIRECTORY, { fetchDocument });
    expect(found.entry?.ops).toHaveLength(2);
    expect(found.warnings.join(" ")).toContain(`${DIRECTORY}/runs`);
  });

  it("does not follow a listing to another organisation", () => {
    expect(specDirectoryIn({ urls: [{ url: "/one.json" }] }, DIRECTORY)).toEqual(["https://api.multi.test/one.json"]);
    return discover(DIRECTORY, {
      fetchDocument: site({ [DIRECTORY]: JSON.stringify({ specs: [{ url: "https://evil.test/spec.json" }] }) }),
    }).then((found) => expect(found.tried).not.toContain("https://evil.test/spec.json"));
  });

  it("keeps same-named definitions of different services apart", () => {
    const { merged, warnings } = mergeSpecDocuments(
      [
        { spec: service("A", "agents", "message"), sourceUrl: `${DIRECTORY}/agents` },
        { spec: service("B", "runs", "detail"), sourceUrl: `${DIRECTORY}/runs` },
      ],
      { keepApart: true },
    );
    const schemas = (merged?.components as { schemas: Record<string, { properties: object }> }).schemas;
    expect(Object.keys(schemas.Error!.properties)).toEqual(["message"]);
    expect(Object.keys(schemas.Error_runs!.properties)).toEqual(["detail"]);
    expect(JSON.stringify((merged?.paths as Record<string, unknown>)["/runs"])).toContain("#/components/schemas/Error_runs");
    expect(warnings).toEqual([]);
  });
});

describe("a specification address with no extension", () => {
  it("is found in prose and Markdown, but not as a piece of a longer path", () => {
    const text = [
      "[Specs](https://api.multi.test/v1/openapi): the list.",
      "GET https://api.other.test/swagger.",
      "One service: https://api.third.test/v1/openapi/agents",
      "A template: https://api.fourth.test/openapi/{name}",
    ].join("\n");
    expect(specLinksIn(text, "https://docs.multi.test/")).toEqual([
      "https://api.multi.test/v1/openapi",
      "https://api.other.test/swagger",
    ]);
  });
});
