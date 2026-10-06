import { describe, expect, it } from "vitest";
import { ExprParseError } from "./errors.js";
import { evalExpr, evalPredicate } from "./eval.js";
import type { EvalContext } from "./functions.js";
import { parseExpr } from "./parser.js";

const CTX: EvalContext = { now: Date.UTC(2026, 7, 4, 12, 30) };

const run = (source: string, row: unknown = {}): unknown =>
  evalExpr(parseExpr(source), row, CTX);

describe("literals and fields", () => {
  it("evaluates literals", () => {
    expect(run("42")).toBe(42);
    expect(run("1.5e2")).toBe(150);
    expect(run("'hello'")).toBe("hello");
    expect(run('"hello"')).toBe("hello");
    expect(run("true")).toBe(true);
    expect(run("null")).toBe(null);
    expect(run("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("reads dotted field paths", () => {
    expect(run("customer.email", { customer: { email: "x@y.z" } })).toBe("x@y.z");
  });

  it("returns null for a missing field instead of throwing", () => {
    expect(run("nope", {})).toBe(null);
    expect(run("a.b.c.d", { a: {} })).toBe(null);
  });

  it("records which fields an expression reads", () => {
    expect([...parseExpr("amount - fee > 0").fields].sort()).toEqual(["amount", "fee"]);
  });
});

describe("arithmetic", () => {
  it("does the usual maths with correct precedence", () => {
    expect(run("2 + 3 * 4")).toBe(14);
    expect(run("(2 + 3) * 4")).toBe(20);
    expect(run("10 % 3")).toBe(1);
    expect(run("-5 + 2")).toBe(-3);
  });

  it("coerces numeric strings", () => {
    expect(run("amount * 2", { amount: "21" })).toBe(42);
  });

  it("yields null rather than NaN on non-numeric operands", () => {
    expect(run("amount - fee", { amount: 10, fee: null })).toBe(null);
    expect(run("amount * 2", { amount: "not a number" })).toBe(null);
  });

  it("yields null on division by zero", () => {
    expect(run("1 / 0")).toBe(null);
    expect(run("1 % 0")).toBe(null);
  });

  it("concatenates when either side is a string", () => {
    expect(run("'order-' + id", { id: 7 })).toBe("order-7");
  });
});

describe("comparison and equality", () => {
  it("compares numbers and strings", () => {
    expect(run("3 > 2")).toBe(true);
    expect(run("'a' < 'b'")).toBe(true);
    expect(run("amount >= 100", { amount: 100 })).toBe(true);
  });

  it("is strict about equality across types", () => {
    // "0" == 0 loosely is exactly the silent-wrongness this design rejects.
    expect(run("'0' == 0")).toBe(false);
    expect(run("0 == 0")).toBe(true);
    expect(run("status != 'failed'", { status: "succeeded" })).toBe(true);
  });

  it("treats a missing field as null in equality", () => {
    expect(run("missing == null", {})).toBe(true);
    expect(run("missing == 'x'", {})).toBe(false);
  });

  it("returns false when comparing against a non-numeric value", () => {
    expect(run("amount > 10", { amount: null })).toBe(false);
    expect(run("amount < 10", { amount: null })).toBe(false);
  });
});

describe("logical operators", () => {
  it("short-circuits and returns booleans", () => {
    expect(run("true || missing.deep.thing")).toBe(true);
    expect(run("false && missing.deep.thing")).toBe(false);
    expect(run("1 && 'x'")).toBe(true);
    expect(run("!0")).toBe(true);
  });

  it("supports in over arrays and substrings", () => {
    expect(run("status in ['paid', 'succeeded']", { status: "paid" })).toBe(true);
    expect(run("status in ['paid', 'succeeded']", { status: "failed" })).toBe(false);
    expect(run("'ample' in 'example'")).toBe(true);
  });
});

describe("functions", () => {
  it("runs the whitelisted set", () => {
    expect(run("lower('ABC')")).toBe("abc");
    expect(run("upper('abc')")).toBe("ABC");
    expect(run("abs(-3)")).toBe(3);
    expect(run("round(3.14159, 2)")).toBe(3.14);
    expect(run("round(2.5)")).toBe(3);
    expect(run("floor(2.9)")).toBe(2);
    expect(run("ceil(2.1)")).toBe(3);
    expect(run("len('abcd')")).toBe(4);
    expect(run("len([1,2])")).toBe(2);
    expect(run("contains('example', 'amp')")).toBe(true);
    expect(run("startsWith('example', 'ex')")).toBe(true);
    expect(run("endsWith('example', 'le')")).toBe(true);
    expect(run("trim('  x  ')")).toBe("x");
    expect(run("string(120820)")).toBe("120820");
    expect(run("string('abc')")).toBe("abc");
    expect(run("string(true)")).toBe("true");
  });

  it("matches an id against a list of ids regardless of type", () => {
    // The array-valued foreign key. A parent's id arrives through a
    // `{{row.Id}}` token, so it is always a string, while the array holds
    // whatever the API sent — normally numbers. `in` and `contains` compare
    // strictly and answer false for every row, which renders as a section
    // that is permanently empty rather than as an error.
    expect(run("includesId(ids, '2')", { ids: [1, 2, 3] })).toBe(true);
    expect(run("includesId(ids, '4')", { ids: [1, 2, 3] })).toBe(false);
    expect(run("includesId(ids, 2)", { ids: ["1", "2"] })).toBe(true);
    expect(run("2 in ids", { ids: ["1", "2"] })).toBe(false);
  });

  it("answers false rather than guessing when there is no list, or nothing to find", () => {
    expect(run("includesId(ids, '1')", { ids: null })).toBe(false);
    expect(run("includesId(ids, '1')", { ids: "1,2,3" })).toBe(false);
    expect(run("includesId(ids, missing)", { ids: [1] })).toBe(false);
    // An object is not a scalar and cannot be an id, so it never matches —
    // stringifying it would make `[object Object]` a value that could.
    expect(run("includesId(ids, '1')", { ids: [{ Id: 1 }] })).toBe(false);
  });

  it("coalesces past null and undefined", () => {
    expect(run("coalesce(missing, fallback, 'last')", { fallback: null })).toBe("last");
    expect(run("coalesce(a, 'last')", { a: 0 })).toBe(0);
  });

  it("uses the injected clock for now()", () => {
    expect(run("now()")).toBe(CTX.now);
  });

  it("truncates timestamps in UTC", () => {
    expect(run("dateTrunc(t, 'day')", { t: Date.UTC(2026, 7, 4, 18, 45) })).toBe(
      Date.UTC(2026, 7, 4),
    );
    expect(run("dateTrunc(t, '1mo')", { t: Date.UTC(2026, 7, 4, 18, 45) })).toBe(
      Date.UTC(2026, 7, 1),
    );
    // 2026-08-04 is a Tuesday; the ISO week starts Monday the 3rd.
    expect(run("dateTrunc(t, 'week')", { t: Date.UTC(2026, 7, 4, 18, 45) })).toBe(
      Date.UTC(2026, 7, 3),
    );
    expect(run("dateTrunc(t, 'day')", { t: "2026-08-04T18:45:00Z" })).toBe(
      Date.UTC(2026, 7, 4),
    );
    expect(run("dateTrunc(t, 'day')", { t: null })).toBe(null);
  });

  it("rejects unknown functions at parse time", () => {
    expect(() => parseExpr("evil('x')")).toThrow(/unknown function "evil"/);
  });

  it("rejects wrong arity at parse time", () => {
    expect(() => parseExpr("abs()")).toThrow(/takes 1 argument/);
    expect(() => parseExpr("now(1)")).toThrow(/takes 0 argument/);
  });
});

describe("evalPredicate", () => {
  it("reduces to a boolean for filter steps", () => {
    const ast = parseExpr("status == 'succeeded' && amount > 0");
    expect(evalPredicate(ast, { status: "succeeded", amount: 5 }, CTX)).toBe(true);
    expect(evalPredicate(ast, { status: "succeeded", amount: 0 }, CTX)).toBe(false);
    expect(evalPredicate(ast, {}, CTX)).toBe(false);
  });
});

describe("parse errors", () => {
  it.each([
    ["1 +", "ended unexpectedly"],
    ["(1 + 2", 'expected ")"'],
    ["1 2", 'unexpected "2"'],
    ["'unterminated", "unterminated string"],
    ["#", "unexpected character"],
    ["in", "not valid here"],
  ])("rejects %s", (source, message) => {
    expect(() => parseExpr(source)).toThrow(ExprParseError);
    expect(() => parseExpr(source)).toThrow(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("reports a position", () => {
    try {
      parseExpr("1 + #");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ExprParseError);
      expect((error as ExprParseError).position).toBe(4);
    }
  });
});

/**
 * Matching a child row against the record it belongs to.
 *
 * The reason `string()` exists: `==` is strict, and the same id routinely
 * arrives as a number on one endpoint and a string on another. Comparing them
 * raw matches nothing, silently, which reads as an empty section rather than
 * as a type mismatch.
 */
describe("comparing an id across types", () => {
  it("matches a numeric column against a string id", () => {
    expect(run('string(PropertyId) == "120820"', { PropertyId: 120820 })).toBe(true);
    expect(run('string(PropertyId) == "120820"', { PropertyId: 51099 })).toBe(false);
  });

  it("matches a string column against the same id", () => {
    expect(run('string(PropertyId) == "abc-1"', { PropertyId: "abc-1" })).toBe(true);
  });

  it("does not match when the column is missing", () => {
    expect(run('string(PropertyId) == "120820"', { Other: 1 })).toBe(false);
  });

  it("is what a raw comparison gets wrong", () => {
    // The failure the coercion exists for.
    expect(run('PropertyId == "120820"', { PropertyId: 120820 })).toBe(false);
  });
});
