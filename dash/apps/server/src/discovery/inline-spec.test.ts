import { describe, expect, it } from "vitest";
import { extractInlineSpec, readJsonValueAt } from "./inline-spec.js";
import { looksLikeOpenApi } from "./openapi.js";

const SPEC = {
  openapi: "3.0.4",
  info: { title: "Open API, powered by Widgets" },
  servers: [{ url: "https://api.widgets.dev" }],
  paths: { "/v1/leases": { get: { summary: "List leases" } } },
};

describe("readJsonValueAt", () => {
  it("reads one balanced object and stops", () => {
    const source = `prefix {"a":{"b":1}} trailing garbage {"c":2}`;
    expect(readJsonValueAt(source, source.indexOf("{"))).toBe('{"a":{"b":1}}');
  });

  it("ignores braces inside strings", () => {
    // The reason a regex cannot do this: descriptions contain braces.
    const source = `{"description":"use {id} like }this{ ","ok":true}`;
    expect(JSON.parse(readJsonValueAt(source, 0)!)).toEqual({
      description: "use {id} like }this{ ",
      ok: true,
    });
  });

  it("respects backslash escapes so an escaped quote does not end the string", () => {
    const source = String.raw`{"q":"a \" } still inside","done":1}`;
    expect(JSON.parse(readJsonValueAt(source, 0)!)).toEqual({ q: 'a " } still inside', done: 1 });
  });

  it("handles arrays", () => {
    expect(readJsonValueAt("[[1,2],[3]]", 0)).toBe("[[1,2],[3]]");
  });

  it("returns null when the value never closes", () => {
    expect(readJsonValueAt('{"a":{"b":1}', 0)).toBeNull();
  });

  it("returns null when it does not start on an opener", () => {
    expect(readJsonValueAt('"a string"', 0)).toBeNull();
  });
});

describe("extractInlineSpec", () => {
  it("pulls the spec out of a Redoc page", () => {
    // The exact shape Buildium ships: state object, spec nested under .spec.data
    const html = `<html><body><div id="redoc"></div><script>
      window.__redoc_state = ${JSON.stringify({ menu: { activeItemIdx: -1 }, spec: { data: SPEC } })};
    </script></body></html>`;

    const found = extractInlineSpec(html, looksLikeOpenApi);
    expect(found?.label).toBe("Redoc");
    expect((found?.spec as typeof SPEC).info.title).toBe("Open API, powered by Widgets");
  });

  it("pulls the spec out of a Swagger UI page", () => {
    const html = `<script>SwaggerUIBundle({ ${JSON.stringify({ spec: SPEC }).slice(1, -1)} })</script>`;
    expect(extractInlineSpec(html, looksLikeOpenApi)?.label).toBe("Swagger UI");
  });

  it("pulls the spec out of a generic window global", () => {
    const html = `<script>window.__SPEC__ = ${JSON.stringify(SPEC)};</script>`;
    expect(extractInlineSpec(html, looksLikeOpenApi)?.label).toBe("embedded");
  });

  it("keeps looking when an earlier marker holds something that is not a spec", () => {
    const html = `<script>window.__SPEC__ = {"unrelated":true};</script>
      <script>window.__redoc_state = ${JSON.stringify({ spec: { data: SPEC } })};</script>`;
    expect(extractInlineSpec(html, looksLikeOpenApi)?.label).toBe("Redoc");
  });

  it("returns null for a page with no embedded spec", () => {
    expect(extractInlineSpec("<html><body>Read our API docs</body></html>", looksLikeOpenApi)).toBeNull();
  });

  it("returns null rather than throwing on a truncated blob", () => {
    const html = `<script>window.__redoc_state = {"spec":{"data":{"openapi":"3.0.0"`;
    expect(extractInlineSpec(html, looksLikeOpenApi)).toBeNull();
  });

  it("survives a marker followed by a JS object literal it cannot parse", () => {
    // Unquoted keys are valid JS but not JSON — skip, do not crash.
    const html = "<script>SwaggerUIBundle({ dom_id: '#swagger', url: '/x.json' })</script>";
    expect(extractInlineSpec(html, looksLikeOpenApi)).toBeNull();
  });

  it("copes with a megabyte-scale document", () => {
    const big = {
      ...SPEC,
      paths: Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [
          `/v1/resource${i}`,
          { get: { summary: `x`.repeat(3000) } },
        ]),
      ),
    };
    const html = `<script>window.__redoc_state = ${JSON.stringify({ spec: { data: big } })};</script>`;
    expect(html.length).toBeGreaterThan(900_000);

    const found = extractInlineSpec(html, looksLikeOpenApi);
    expect(Object.keys((found?.spec as typeof big).paths)).toHaveLength(300);
  });
});
