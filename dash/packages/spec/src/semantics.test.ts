import { describe, expect, it } from "vitest";
import { applyCoercion } from "./coercion.js";
import { SEMANTICS, formatValue, guessSemantic, looksLikeFlag } from "./semantics.js";

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

  /*
   * Every rule used to hold only for snake_case: the name was lowercased
   * before matching, so `workOrderID` lost the boundary that made it an id.
   */
  it.each([
    ["workOrder_workOrderID", "identifier"],
    ["VendorId", "identifier"],
    ["GLAccountId", "identifier"],
    ["PropertyIds", "identifier"],
    ["createdAt", "timestamp"],
    ["DateTimeCreated", "timestamp"],
    ["workOrderStatus", "status_enum"],
    ["RentAmount", "currency"],
    ["unitCount", "count"],
    ["numberOfUnits", "count"],
  ])("reads %s the same whatever the convention (%s)", (name, expected) => {
    expect(guessSemantic(name, 1)).toBe(expected);
  });

  /* A reference number is not a quantity: summed, or printed as "104,868". */
  it.each(["workOrder_workOrderNumber", "order_number", "PhoneNumber", "AccountNumber", "item_num"])(
    "reads %s as a reference, not a count",
    (name) => {
      expect(guessSemantic(name, 104868)).toBe("identifier");
      expect(formatValue(104868, { semantic: guessSemantic(name, 104868) })).toBe("104868");
    },
  );

  /* Letters inside a word are not the word. */
  it.each([
    ["GLAccount_Name", "Rent Income"],
    ["contact_isCorporate", true],
    ["candidate_name", "Ada"],
    ["carrier_name", "Acme Freight"],
    ["line_items", "3 items"],
    ["timezone", "America/Chicago"],
  ])("does not read %s by the letters inside its words", (name, sample) => {
    expect(guessSemantic(name, sample)).toBe("text");
  });

  /*
   * The guess formats every column nothing else describes, so one the value
   * contradicts must not stand: a number format over text prints "—".
   */
  it("never lets a name's guess make a value unreadable", () => {
    expect(formatValue("555-123-4567", { semantic: guessSemantic("PhoneNumber", "555-123-4567") })).toBe(
      "555-123-4567",
    );
    expect(formatValue("000123456789", { semantic: guessSemantic("AccountNumber", "000123456789") })).toBe(
      "000123456789",
    );
    expect(guessSemantic("total_label", "Grand total")).toBe("text");
    expect(guessSemantic("due_date", "not a date")).toBe("text");
    /* Judged on its name alone, the guess still stands. */
    expect(guessSemantic("order_status", null)).toBe("status_enum");
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

/*
 * Rentvine sends its flags as 1 and 0. A field known to be a flag reads as a
 * state however it arrives, and a real true/false does too.
 */
describe("flags", () => {
  it("reads a flag as Active or Inactive, however the API sends it", () => {
    for (const on of [true, 1, "1", "true", " TRUE "]) {
      expect(formatValue(on, { semantic: "boolean" }), String(on)).toBe("Active");
    }
    for (const off of [false, 0, "0", "false"]) {
      expect(formatValue(off, { semantic: "boolean" }), String(off)).toBe("Inactive");
    }
  });

  it("prints what a so-called flag really holds when it is not one", () => {
    // Declared boolean, sent as a type id: 3 is not a state.
    expect(formatValue(3, { semantic: "boolean" })).toBe("3");
    expect(formatValue(null, { semantic: "boolean" })).toBe("—");
  });

  it("reads a real true/false as a state with nothing to say it is a flag", () => {
    expect(formatValue(true, undefined)).toBe("Active");
    expect(formatValue(false, { semantic: "text" })).toBe("Inactive");
  });
});

describe("looksLikeFlag", () => {
  it("reads a name that asks a yes/no question, in any convention", () => {
    for (const name of ["isVacant", "workOrder.isSharedWithTenant", "has_pets", "CanEdit", "active", "enabled"]) {
      expect(looksLikeFlag(name), name).toBe(true);
    }
  });

  it("does not read a word that merely starts with the same letters", () => {
    for (const name of ["issueDate", "isoCode", "hash", "canonicalUrl", "status", "is", "taxFormTypeID"]) {
      expect(looksLikeFlag(name), name).toBe(false);
    }
  });
});
