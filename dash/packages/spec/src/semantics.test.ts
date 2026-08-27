import { describe, expect, it } from "vitest";
import { applyCoercion } from "./coercion.js";
import { SEMANTICS, formatValue, guessSemantic } from "./semantics.js";

describe("formatValue", () => {
  it("shows an em dash rather than NaN or null", () => {
    for (const value of [null, undefined, "", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatValue(value, { semantic: "count" })).toBe("—");
    }
  });

  /*
   * A nested object used to be `JSON.stringify`d straight into the cell, which
   * put a wall of braces and quotes in a table column wide enough to shove
   * everything else off screen. A row is a summary.
   */
  it("summarises a container instead of dumping its JSON", () => {
    expect(formatValue({ AddressLine1: "9976 North Recreation Avenue", City: "Fresno" }, undefined))
      .toBe("{AddressLine1, City}");
    // Named keys tell the reader whether the column is worth expanding; a bare
    // "{…}" tells them nothing.
    expect(formatValue({ a: 1, b: 2, c: 3, d: 4 }, undefined)).toBe("{a, b, …}");
    expect(formatValue({}, undefined)).toBe("{}");
  });

  it("counts array members rather than listing them", () => {
    expect(formatValue([1, 2, 3], undefined)).toBe("3 items");
    expect(formatValue(["only"], undefined)).toBe("1 item");
    // An empty array is not absent — "—" would claim there is no value at all.
    expect(formatValue([], undefined)).toBe("0 items");
  });

  it("formats currency in major units", () => {
    expect(formatValue(42, { semantic: "currency", currency: "USD" })).toBe("$42.00");
    expect(formatValue(1234.5, { semantic: "currency", currency: "USD", compact: true })).toBe(
      "$1.2K",
    );
  });

  it("formats counts, percents and plain numbers", () => {
    expect(formatValue(1234, { semantic: "count" })).toBe("1,234");
    expect(formatValue(1234, { semantic: "count", compact: true })).toBe("1.2K");
    expect(formatValue(12.345, { semantic: "percent", decimals: 1 })).toBe("12.3%");
    expect(formatValue(3.14159, { semantic: "number" })).toBe("3.14");
  });

  it("formats bytes and durations at a readable scale", () => {
    expect(formatValue(512, { semantic: "bytes" })).toBe("512 B");
    expect(formatValue(1536, { semantic: "bytes" })).toBe("1.5 KB");
    expect(formatValue(5_368_709_120, { semantic: "bytes" })).toBe("5.0 GB");
    expect(formatValue(450, { semantic: "duration" })).toBe("450ms");
    expect(formatValue(5_025_000, { semantic: "duration" })).toBe("1h 23m");
    expect(formatValue(90_000, { semantic: "duration" })).toBe("1m 30s");
  });

  it("formats timestamps and relative times against an injected clock", () => {
    const now = Date.UTC(2026, 7, 4, 12, 0);
    expect(
      formatValue(now - 3 * 86_400_000, { semantic: "relative_time" }, { now }),
    ).toBe("3 days ago");
    expect(
      formatValue(now, { semantic: "timestamp" }, { timeZone: "UTC" }),
    ).toMatch(/Aug 4, 2026/);
  });

  it("applies prefix, suffix and unit", () => {
    expect(
      formatValue(5, { semantic: "number", prefix: "~", suffix: "!", unit: "rpm" }),
    ).toBe("~5 rpm!");
  });

  it("falls back to text for non-numeric semantics", () => {
    expect(formatValue("succeeded", { semantic: "status_enum" })).toBe("succeeded");
    expect(formatValue("abc", undefined)).toBe("abc");
  });
});

describe("guessSemantic", () => {
  it.each([
    ["customer_id", "identifier"],
    ["id", "identifier"],
    ["profile_url", "url"],
    ["status", "status_enum"],
    ["created_at", "timestamp"],
    ["amount", "currency"],
    ["conversion_rate", "percent"],
    ["file_size", "bytes"],
    ["latency_ms", "duration"],
    ["order_count", "count"],
  ])("maps %s to %s", (name, expected) => {
    expect(guessSemantic(name, 1)).toBe(expected);
  });

  it("falls back on the sample value", () => {
    expect(guessSemantic("whatever", 3)).toBe("number");
    expect(guessSemantic("whatever", "text")).toBe("text");
  });
});

describe("SEMANTICS registry", () => {
  it("never numerically aggregates an identifier", () => {
    expect(SEMANTICS.identifier.defaultAggregation).toBe("countDistinct");
  });

  it("gives every semantic an axis and an affinity", () => {
    for (const [name, def] of Object.entries(SEMANTICS)) {
      expect(def.affinity.length, name).toBeGreaterThan(0);
      expect(["linear", "time", "category"]).toContain(def.axis);
    }
  });
});

describe("applyCoercion", () => {
  it("resolves the cents-versus-dollars question explicitly", () => {
    expect(applyCoercion(4200, "money:cents->major")).toBe(42);
    expect(applyCoercion(4200, "money:major")).toBe(4200);
  });

  it("resolves the seconds-versus-milliseconds question explicitly", () => {
    expect(applyCoercion(1_700_000_000, "unix_s->datetime")).toBe(1_700_000_000_000);
    expect(applyCoercion(1_700_000_000_000, "unix_ms->datetime")).toBe(1_700_000_000_000);
  });

  it("parses ISO strings and Date objects", () => {
    expect(applyCoercion("2026-08-04T00:00:00Z", "iso->datetime")).toBe(Date.UTC(2026, 7, 4));
    expect(applyCoercion(new Date(Date.UTC(2026, 7, 4)), "auto->datetime")).toBe(
      Date.UTC(2026, 7, 4),
    );
  });

  it("tolerates the separators real APIs emit", () => {
    expect(applyCoercion("1,234.5", "->number")).toBe(1234.5);
    expect(applyCoercion("$99", "->number")).toBe(99);
  });

  it("scales fractions to percent", () => {
    expect(applyCoercion(0.125, "percent:fraction->percent")).toBe(12.5);
  });

  it("returns null instead of throwing on junk", () => {
    expect(applyCoercion("not a number", "->number")).toBe(null);
    expect(applyCoercion(null, "money:cents->major")).toBe(null);
    expect(applyCoercion("neither", "->boolean")).toBe(null);
  });

  it("parses the boolean spellings APIs actually use", () => {
    expect(applyCoercion("yes", "->boolean")).toBe(true);
    expect(applyCoercion(0, "->boolean")).toBe(false);
    expect(applyCoercion("TRUE", "->boolean")).toBe(true);
  });
});
