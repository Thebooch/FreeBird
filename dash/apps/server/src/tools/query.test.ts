import { describe, expect, it } from "vitest";
import type { OpReader } from "../context/types.js";
import { QUERY_TOOL, queryRecords } from "./query.js";
import type { ToolBinding, ToolDeps } from "./types.js";

/**
 * Narrowing, and the distinction that keeps it honest.
 *
 * Only one of the two ways to narrow is a statement about the collection. When
 * the API applies the filter, "no results" means no results. When a page is
 * read and matched here, "no results" means "not on this page" — and reporting
 * the second as the first is how a record that exists gets declared missing.
 */

const binding = (over: Partial<ToolBinding> = {}): ToolBinding => ({
  verb: "query",
  id: "conversation",
  connection: "helpdesk",
  connectionTitle: "Helpdesk",
  resource: "conversation",
  title: "Conversations",
  op: "tickets.list",
  describes: "Support threads",
  ...over,
});

const deps = (read: OpReader): ToolDeps => ({
  read,
  resolved: { range: { start: 0, end: 1, grain: "1d", preset: "30d" }, filters: {} },
  rowsOf: (body) => (Array.isArray(body) ? (body as Record<string, unknown>[]) : []),
  rowsPathFor: () => "$",
});

const reader = (
  rows: Record<string, unknown>[],
  opts: { sent?: Record<string, unknown>[]; truncated?: boolean } = {},
): OpReader =>
  (async (input) => {
    opts.sent?.push({ ...input.params });
    return { ok: true as const, body: rows, requests: 1, truncated: opts.truncated ?? false };
  }) as OpReader;

const param = (name: string, over: Record<string, unknown> = {}) =>
  ({ name, in: "query", type: "string", required: false, ...over }) as never;

describe("queryRecords — the API does the filtering", () => {
  it("sends the text to whatever the endpoint calls its search input", async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await queryRecords({
      // The vendor calls it `q`; nothing here knows that, only that it is the
      // search role.
      binding: binding({ search: "q" }),
      text: "running late",
      deps: deps(reader([{ id: 1 }], { sent })),
    });
    expect(sent).toEqual([{ q: "running late" }]);
    expect(result.matchedLocally).toBe(false);
    expect(result.note).toContain('asked "Conversations" to search for "running late"');
  });

  it("sends only the filters the endpoint declares, and says what it dropped", async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await queryRecords({
      binding: binding({ filters: [param("statuses"), param("priorities")] }),
      filters: [
        { name: "statuses", value: "open" },
        { name: "invented", value: "x" },
      ],
      deps: deps(reader([{ id: 1 }], { sent })),
    });
    expect(sent).toEqual([{ statuses: "open" }]);
    expect(result.warnings.join(" ")).toContain("does not accept invented");
    expect(result.note).toContain("narrowed by statuses");
  });
});

describe("queryRecords — matched here instead", () => {
  /*
   * The fallback for an API with no search input, and the reason it must
   * announce itself: this is a search over a page, not over the collection.
   */
  it("reads a page and matches the words here, saying so", async () => {
    const result = await queryRecords({
      binding: binding(),
      text: "dishwasher",
      deps: deps(reader([{ Title: "Dishwasher" }, { Title: "Turn" }])),
    });
    expect(result.records).toEqual([{ Title: "Dishwasher" }]);
    expect(result.matchedLocally).toBe(true);
    expect(result.note).toContain("declares no search input");
  });

  it("matches anywhere in the record, not only a field somebody guessed", async () => {
    const result = await queryRecords({
      binding: binding(),
      text: "downpipe",
      deps: deps(reader([{ Title: "Water", Description: "by the downpipe" }])),
    });
    expect(result.records).toHaveLength(1);
  });

  /*
   * The claim that would be wrong: a local match over a page the API cut short
   * proves nothing about what lies beyond it.
   */
  it("refuses to let an empty local match read as proof of absence", async () => {
    const result = await queryRecords({
      binding: binding(),
      text: "dishwasher",
      deps: deps(reader([{ Title: "Turn" }], { truncated: true })),
    });
    expect(result.records).toEqual([]);
    expect(result.warnings.join(" ")).toContain("not proof that nothing else matches");
    expect(result.partial).toBe(true);
  });

  it("does not caveat a complete read the same way", async () => {
    const result = await queryRecords({
      binding: binding(),
      text: "dishwasher",
      deps: deps(reader([{ Title: "Turn" }])),
    });
    expect(result.warnings).toEqual([]);
    expect(result.partial).toBe(false);
  });

  it("says how many more matched than it is showing", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ Title: `Water ${i}` }));
    const result = await queryRecords({
      binding: binding(),
      text: "water",
      limit: 3,
      deps: deps(reader(rows)),
    });
    expect(result.records).toHaveLength(3);
    expect(result.warnings.join(" ")).toContain("7 more matched");
  });
});

describe("queryRecords — when it cannot", () => {
  it("passes the API's own reason through when it refuses", async () => {
    const refusing = (async () => ({
      ok: false as const,
      reason: "the key is not permitted to read this endpoint",
    })) as OpReader;
    const result = await queryRecords({ binding: binding(), deps: deps(refusing) });
    expect(result.note).toContain("not permitted");
    expect(result.refused).toBeTruthy();
    expect(result.requests).toBe(0);
  });

  it("reports a cold cache-only read as unread rather than empty", async () => {
    const cold = (async () => null) as OpReader;
    const result = await queryRecords({ binding: binding(), deps: deps(cold), cacheOnly: true });
    expect(result.records).toEqual([]);
    expect(result.note).toContain("could not be read");
  });
});

describe("QUERY_TOOL", () => {
  it("tells the model the distinction it has to report", () => {
    expect(QUERY_TOOL.name).toBe("query_records");
    expect(QUERY_TOOL.description).toContain("only the first is a statement about the whole");
  });
});
