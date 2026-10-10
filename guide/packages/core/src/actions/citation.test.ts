import { describe, expect, it } from "vitest";
import { CITATION_KEY, citationOf, revealSelector, toComponentCitation, withCitation } from "./citation.js";

describe("action citations", () => {
  it("ride along on a result and are read back", () => {
    const result = withCitation({ saved: true }, { title: "Showing · Approval", page: "#/types", selector: "#approval", summary: "Showing now needs approval." });
    expect(result.saved).toBe(true);
    expect(citationOf(result)).toEqual({ title: "Showing · Approval", page: "#/types", selector: "#approval", summary: "Showing now needs approval." });
  });

  it("are absent from a result that carries none, and a malformed one is refused", () => {
    expect(citationOf({ saved: true })).toBeNull();
    expect(citationOf(null)).toBeNull();
    expect(citationOf("text")).toBeNull();
    expect(citationOf({ [CITATION_KEY]: { page: "#/x" } })).toBeNull();
    expect(citationOf({ [CITATION_KEY]: { title: " " } })).toBeNull();
    expect(citationOf({ [CITATION_KEY]: { title: "A", page: 3 } })).toBeNull();
    /* Only the known keys come back. */
    expect(citationOf({ [CITATION_KEY]: { title: "A", onclick: "x" } })).toEqual({ title: "A" });
  });

  it("become a highlight chip for their component", () => {
    expect(toComponentCitation("types", { title: "Showing", page: "#/types", selector: "#s" })).toEqual({
      componentId: "types",
      title: "Showing",
      directive: "highlight",
      kind: "component",
      selector: "#s",
      page: "#/types",
    });
  });

  it("build selectors over the data-freebird attributes, quoting what they hold", () => {
    expect(revealSelector({ component: "types" })).toBe('[data-freebird-component="types"]');
    expect(revealSelector({ component: "types", item: "showing", field: "approval" })).toBe(
      '[data-freebird-component="types"] [data-freebird-item="showing"] [data-freebird-field="approval"]',
    );
    expect(revealSelector({ component: "types", item: 'a"b\\c' })).toBe('[data-freebird-component="types"] [data-freebird-item="a\\"b\\\\c"]');
  });
});
