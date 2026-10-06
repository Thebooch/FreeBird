import { describe, expect, it } from "vitest";
import { ExprParseError } from "./errors.js";
import { evalPath, extractRows, parsePath } from "./path.js";

const payload = {
  data: [
    { id: "a", amount: 100, customer: { email: "a@example.com" } },
    { id: "b", amount: 250, customer: { email: "b@example.com" } },
  ],
  meta: { total: 2 },
  keyed: { one: { n: 1 }, two: { n: 2 } },
};

describe("parsePath", () => {
  it("parses dotted keys, indices, wildcards and quoted keys", () => {
    expect(parsePath("$.data[*].amount").segments).toEqual([
      { kind: "key", key: "data" },
      { kind: "wildcard" },
      { kind: "key", key: "amount" },
    ]);
    expect(parsePath("$.data[0]").segments).toEqual([
      { kind: "key", key: "data" },
      { kind: "index", index: 0 },
    ]);
    expect(parsePath('$["odd key"]').segments).toEqual([{ kind: "key", key: "odd key" }]);
    expect(parsePath("$.data.*").segments).toEqual([
      { kind: "key", key: "data" },
      { kind: "wildcard" },
    ]);
  });

  it("accepts a bare root", () => {
    expect(parsePath("$").segments).toEqual([]);
  });

  it("parses [last], [first] and negative indices", () => {
    expect(parsePath("$.data[last]").segments).toEqual([
      { kind: "key", key: "data" },
      { kind: "index", index: -1 },
    ]);
    expect(parsePath("$.data[first]").segments).toEqual([
      { kind: "key", key: "data" },
      { kind: "index", index: 0 },
    ]);
    expect(parsePath("$.data[-2]").segments).toEqual([
      { kind: "key", key: "data" },
      { kind: "index", index: -2 },
    ]);
  });

  it("allows hyphens in property names", () => {
    expect(parsePath("$.total-count").segments).toEqual([
      { kind: "key", key: "total-count" },
    ]);
  });

  it.each([
    ["data[*]", 'a path must start with "$"'],
    ["$.", 'expected a property name after "."'],
    ["$[", "expected an array index"],
    ["$[1", 'expected "]"'],
    ["$.data[*", 'expected "]"'],
    ["$.a b", "unexpected character"],
    ['$["unterminated', "unterminated quoted key"],
  ])("rejects %s", (source, message) => {
    expect(() => parsePath(source)).toThrow(ExprParseError);
    expect(() => parsePath(source)).toThrow(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("evalPath", () => {
  it("collects every wildcard match", () => {
    expect(evalPath(parsePath("$.data[*].amount"), payload)).toEqual([100, 250]);
  });

  it("reaches into nested objects", () => {
    expect(evalPath(parsePath("$.data[*].customer.email"), payload)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("indexes arrays", () => {
    expect(evalPath(parsePath("$.data[1].id"), payload)).toEqual(["b"]);
  });

  it("spreads object values for a wildcard over a keyed map", () => {
    expect(evalPath(parsePath("$.keyed[*].n"), payload)).toEqual([1, 2]);
  });

  it("returns an empty match set for a missing key rather than throwing", () => {
    expect(evalPath(parsePath("$.nope.deeper"), payload)).toEqual([]);
    expect(evalPath(parsePath("$.data[99]"), payload)).toEqual([]);
  });

  it("drops non-array values under an index segment", () => {
    expect(evalPath(parsePath("$.meta[0]"), payload)).toEqual([]);
  });

  it("reads from the end, which is how cursor APIs name their next cursor", () => {
    // Stripe's `starting_after` is the last item's id.
    expect(evalPath(parsePath("$.data[last].id"), payload)).toEqual(["b"]);
    expect(evalPath(parsePath("$.data[-1].id"), payload)).toEqual(["b"]);
    expect(evalPath(parsePath("$.data[-2].id"), payload)).toEqual(["a"]);
    expect(evalPath(parsePath("$.data[first].id"), payload)).toEqual(["a"]);
  });

  it("yields nothing when a negative index runs past the start", () => {
    expect(evalPath(parsePath("$.data[-9]"), payload)).toEqual([]);
    expect(evalPath(parsePath("$.data[last]"), { data: [] })).toEqual([]);
  });
});

describe("extractRows", () => {
  it("unwraps a single array match so $.data and $.data[*] agree", () => {
    const viaWildcard = extractRows(parsePath("$.data[*]"), payload);
    const viaArray = extractRows(parsePath("$.data"), payload);
    expect(viaArray).toEqual(viaWildcard);
    expect(viaArray).toHaveLength(2);
  });

  it("treats a single object match as one row", () => {
    expect(extractRows(parsePath("$.meta"), payload)).toEqual([{ total: 2 }]);
  });

  it("treats a bare root array as the row set", () => {
    expect(extractRows(parsePath("$"), [{ a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("yields no rows when nothing matches", () => {
    expect(extractRows(parsePath("$.missing[*]"), payload)).toEqual([]);
  });
});
