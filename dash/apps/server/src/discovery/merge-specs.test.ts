import { describe, expect, it } from "vitest";
import { mergeSpecDocuments } from "./merge-specs.js";
import { parseOpenApi } from "./openapi.js";

/**
 * Folding one-operation fragments into a document worth importing.
 *
 * The two tests that matter are the first two: they are the reason the merge
 * happens at the document level instead of over finished catalog entries.
 */

const fragment = (
  path: string,
  extra: Record<string, unknown> = {},
  method = "get",
): Record<string, unknown> => ({
  openapi: "3.0.3",
  info: { title: "Widget API", version: "1.0" },
  servers: [{ url: "https://api.widgets.test" }],
  paths: {
    [path]: {
      [method]: {
        summary: `${method} ${path}`,
        responses: {
          "200": { content: { "application/json": { schema: { type: "array" } } } },
        },
      },
    },
  },
  ...extra,
});

const at = (spec: Record<string, unknown>, page: string) => ({
  spec,
  sourceUrl: `https://docs.widgets.test/api/${page}.md`,
});

describe("mergeSpecDocuments", () => {
  it("keeps operations that would collide if parsed separately", () => {
    /*
     * `opId` strips `{…}` segments, so `/widgets` and `/widgets/{id}` both
     * slug to `widgets`, and de-duplication is scoped to one `parseOpenApi`
     * call. Parsed page-by-page each fragment is internally consistent and
     * the two ids collide the moment they meet. Merged first, the existing
     * `usedIds` suffixing sees both and separates them.
     */
    const { merged, operations } = mergeSpecDocuments([
      at(fragment("/widgets"), "list-widgets"),
      at(fragment("/widgets/{widgetId}"), "get-widget"),
    ]);
    expect(operations).toBe(2);

    const result = parseOpenApi(merged, "https://docs.widgets.test/api");
    const ids = result?.entry.ops.map((op) => op.id) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("produces the resource graph that separate parses cannot", () => {
    /*
     * The whole reason for merging. `deriveResourceGraph` pairs a collection
     * with its detail endpoint only when both are in the same ops array, so
     * one-page-at-a-time importing yields no resources at all — no
     * drill-downs, no relations, nothing for the widget engine to offer.
     */
    const separately = [
      parseOpenApi(fragment("/widgets"), "https://docs.widgets.test/a"),
      parseOpenApi(fragment("/widgets/{widgetId}"), "https://docs.widgets.test/b"),
    ];
    expect(separately.flatMap((r) => r?.entry.resources ?? [])).toEqual([]);

    const { merged } = mergeSpecDocuments([
      at(fragment("/widgets"), "list-widgets"),
      at(fragment("/widgets/{widgetId}"), "get-widget"),
    ]);
    const together = parseOpenApi(merged, "https://docs.widgets.test/api");
    expect(together?.entry.resources).toHaveLength(1);
    expect(together?.entry.resources[0]).toMatchObject({ detailParam: "widgetId" });
  });

  it("unions the paths and counts the operations", () => {
    const { merged, operations } = mergeSpecDocuments([
      at(fragment("/widgets"), "a"),
      at(fragment("/gadgets"), "b"),
      at(fragment("/sprockets"), "c"),
    ]);
    expect(operations).toBe(3);
    expect(Object.keys((merged as { paths: object }).paths)).toEqual([
      "/widgets",
      "/gadgets",
      "/sprockets",
    ]);
  });

  it("keeps two methods on the same path", () => {
    const { merged, operations } = mergeSpecDocuments([
      at(fragment("/widgets", {}, "get"), "list"),
      at(fragment("/widgets", {}, "post"), "create"),
    ]);
    expect(operations).toBe(2);
    const item = (merged as { paths: Record<string, object> }).paths["/widgets"]!;
    expect(Object.keys(item).sort()).toEqual(["get", "post"]);
  });

  it("warns when pages disagree about the host", () => {
    /*
     * Only one `baseUrl` survives, and it also becomes the SSRF allowlist —
     * so an operation belonging to a second host is silently repointed and
     * fails at run time rather than at import, which is far worse.
     */
    const { merged, warnings } = mergeSpecDocuments([
      at(fragment("/widgets"), "a"),
      at(
        { ...fragment("/gadgets"), servers: [{ url: "https://other.example.com" }] },
        "b",
      ),
    ]);
    expect(warnings.join(" ")).toMatch(/2 different hosts/);
    expect(warnings.join(" ")).toMatch(/will not work/);
    // The first still wins, so the import is usable rather than refused.
    expect((merged as { servers: Array<{ url: string }> }).servers[0]?.url).toBe(
      "https://api.widgets.test",
    );
  });

  it("says nothing when every page repeats the same host", () => {
    const { warnings } = mergeSpecDocuments([
      at(fragment("/widgets"), "a"),
      at(fragment("/gadgets"), "b"),
    ]);
    expect(warnings).toEqual([]);
  });

  it("warns when two pages define a different schema under one name", () => {
    /*
     * Every fragment carries its own `$ref` targets. Two pages defining a
     * different `Error` means the second operation's responses silently
     * resolve against the first's shape.
     */
    const withSchema = (properties: Record<string, unknown>) => ({
      components: { schemas: { Error: { type: "object", properties } } },
    });
    const { warnings } = mergeSpecDocuments([
      at({ ...fragment("/widgets"), ...withSchema({ code: { type: "string" } }) }, "a"),
      at({ ...fragment("/gadgets"), ...withSchema({ detail: { type: "number" } }) }, "b"),
    ]);
    expect(warnings.join(" ")).toMatch(/different `Error` under schemas/);
  });

  it("treats the same schema repeated on every page as routine", () => {
    // Fragments duplicate their shared pieces by design; only disagreement
    // is worth a warning, or the list is noise on every single import.
    const shared = { components: { schemas: { Error: { type: "object" } } } };
    const { warnings } = mergeSpecDocuments([
      at({ ...fragment("/widgets"), ...shared }, "a"),
      at({ ...fragment("/gadgets"), ...shared }, "b"),
    ]);
    expect(warnings).toEqual([]);
  });

  it("unions security schemes and the requirement that names them", () => {
    const { merged } = mergeSpecDocuments([
      at(
        {
          ...fragment("/widgets"),
          security: [{ ApiKeyHeader: [] }],
          components: {
            securitySchemes: { ApiKeyHeader: { type: "apiKey", in: "header", name: "x-token" } },
          },
        },
        "a",
      ),
      at(
        {
          ...fragment("/gadgets"),
          components: { securitySchemes: { Bearer: { type: "http", scheme: "bearer" } } },
        },
        "b",
      ),
    ]);

    // Both schemes survive, and the nominated one still wins the ranking.
    const auth = parseOpenApi(merged, "https://docs.widgets.test/api")?.entry.dialect.auth;
    expect(auth).toMatchObject({ type: "header", header: "x-token" });
  });

  it("returns nothing when no fragment carried an operation", () => {
    expect(mergeSpecDocuments([]).merged).toBeNull();
    expect(mergeSpecDocuments([at({ openapi: "3.0.3", paths: {} }, "a")]).merged).toBeNull();
    expect(mergeSpecDocuments([{ spec: "not a document", sourceUrl: "x" }]).merged).toBeNull();
  });

  it("carries a Swagger 2 document's own shape through", () => {
    const { merged } = mergeSpecDocuments([
      at(
        {
          swagger: "2.0",
          info: { title: "Old API" },
          host: "api.old.test",
          basePath: "/v1",
          schemes: ["https"],
          paths: { "/things": { get: { responses: { "200": { schema: { type: "array" } } } } } },
        },
        "a",
      ),
    ]);
    expect(merged).toMatchObject({ swagger: "2.0", host: "api.old.test", basePath: "/v1" });
    expect(merged).not.toHaveProperty("openapi");
    expect(parseOpenApi(merged, "https://docs.old.test/a")?.entry.baseUrl).toBe(
      "https://api.old.test/v1",
    );
  });
});

describe("reporting a rejected entry", () => {
  it("hands back the schema issues instead of a silent null", () => {
    /*
     * A bare null is fine for one spec — the ladder moves on. After a minute
     * of paced fetching it is the worst outcome available: nothing to show
     * and no way to know which limit was hit. `resources` caps at 200.
     */
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 205; index += 1) {
      const responses = { "200": { content: { "application/json": { schema: { type: "array" } } } } };
      paths[`/kind${index}`] = { get: { responses } };
      paths[`/kind${index}/{itemId}`] = { get: { responses } };
    }

    const issues: unknown[] = [];
    const result = parseOpenApi(
      { openapi: "3.0.3", info: { title: "Huge" }, servers: [{ url: "https://api.huge.test" }], paths },
      "https://docs.huge.test/spec",
      { onReject: (found) => issues.push(...found) },
    );

    expect(result).toBeNull();
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).toContain("resources");
  });

  it("does not call back when the entry is fine", () => {
    let called = false;
    parseOpenApi(fragment("/widgets"), "https://docs.widgets.test/a", {
      onReject: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });
});

describe("choosing a validation endpoint", () => {
  it("never picks a path that still has a placeholder in it", () => {
    /*
     * A merged set of mostly detail pages used to fall through to `ops[0]`,
     * whose path carries a live `{{param.x}}`. That sends the placeholder
     * literally, comes back 404, and reads as "your key is wrong".
     */
    const { merged } = mergeSpecDocuments([
      at(fragment("/widgets/{widgetId}"), "a"),
      at(fragment("/gadgets/{gadgetId}"), "b"),
    ]);
    const entry = parseOpenApi(merged, "https://docs.widgets.test/api")?.entry;
    expect(entry?.ops.length).toBeGreaterThan(0);
    expect(entry?.validateOpId).toBeUndefined();
  });

  it("prefers a parameter-free collection when one exists", () => {
    const { merged } = mergeSpecDocuments([
      at(fragment("/widgets/{widgetId}"), "a"),
      at(fragment("/widgets"), "b"),
    ]);
    const entry = parseOpenApi(merged, "https://docs.widgets.test/api")?.entry;
    const chosen = entry?.ops.find((op) => op.id === entry.validateOpId);
    expect(chosen?.path).toBe("/widgets");
  });
});
