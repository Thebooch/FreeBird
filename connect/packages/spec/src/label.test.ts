import { describe, expect, it } from "vitest";
import { humanValue, isNothingValue, looksLikeToken } from "./label.js";
import { formatValue } from "./semantics.js";

/**
 * Values that read like words.
 *
 * Every value here is one a real API sends: Buildium's enums from
 * `dash/apps/server/connections/open-api-powered-by-buildium.json`, and
 * Rentvine's snake_case codes from `rentvine-api-docs.json`.
 */
describe("humanValue", () => {
  it("splits PascalCase codes into a sentence", () => {
    expect(humanValue("InProgress", true)).toBe("In progress");
    expect(humanValue("NotStarted", true)).toBe("Not started");
    expect(humanValue("MonthToMonth", true)).toBe("Month to month");
    expect(humanValue("CondoTownhome", true)).toBe("Condo townhome");
    expect(humanValue("OnePointFiveBath", true)).toBe("One point five bath");
    expect(humanValue("NonOperatingExpenses", true)).toBe("Non operating expenses");
  });

  it("keeps acronyms", () => {
    expect(humanValue("GLAccount", true)).toBe("GL account");
    expect(humanValue("GLAccount")).toBe("GL account");
  });

  it("gives a number inside a code a word of its own", () => {
    expect(humanValue("Every2Weeks", true)).toBe("Every 2 weeks");
    expect(humanValue("Every6Months", true)).toBe("Every 6 months");
  });

  it("speaks snake_case, shouted or not", () => {
    expect(humanValue("bank_account_reconciliation_lapse")).toBe("Bank account reconciliation lapse");
    expect(humanValue("PAST_DUE")).toBe("Past due");
    expect(humanValue("in_progress", true)).toBe("In progress");
  });

  it("leaves one plain word alone", () => {
    expect(humanValue("Active", true)).toBe("Active");
    expect(humanValue("Studio", true)).toBe("Studio");
    expect(humanValue("Active")).toBe("Active");
  });

  it("speaks a shouted status, but not a short acronym", () => {
    expect(humanValue("ACTIVE", true)).toBe("Active");
    expect(humanValue("USD", true)).toBe("USD");
    // Outside a set of values, one capitalised word could be anything.
    expect(humanValue("ACTIVE")).toBe("ACTIVE");
  });

  it("leaves names and sentences exactly as typed", () => {
    expect(humanValue("McDonald")).toBe("McDonald");
    expect(humanValue("DeAngelo")).toBe("DeAngelo");
    expect(humanValue("iPhone")).toBe("iPhone");
    expect(humanValue("Ada Park")).toBe("Ada Park");
    expect(humanValue("Leak under the sink")).toBe("Leak under the sink");
    expect(humanValue("ada@example.com")).toBe("ada@example.com");
    expect(humanValue("12 Main St.")).toBe("12 Main St.");
  });

  it("knows a code from a word", () => {
    expect(looksLikeToken("InProgress")).toBe(true);
    expect(looksLikeToken("notSet")).toBe(true);
    expect(looksLikeToken("past_due")).toBe(true);
    expect(looksLikeToken("Active")).toBe(false);
    expect(looksLikeToken("eBay")).toBe(false);
  });
});

describe("isNothingValue", () => {
  it("reads an API's words for nothing as empty", () => {
    for (const value of ["NotSet", "None", "Null", "Undefined", "Unknown", "N/A", "NA", "n/a", "not_set"]) {
      expect(isNothingValue(value), value).toBe(true);
    }
  });

  it("reads placeholder dates as empty", () => {
    expect(isNothingValue("0001-01-01")).toBe(true);
    expect(isNothingValue("0001-01-01T00:00:00")).toBe(true);
    expect(isNothingValue("0001-01-01T00:00:00Z")).toBe(true);
    expect(isNothingValue("9999-12-31")).toBe(true);
  });

  it("leaves real values alone", () => {
    for (const value of ["Nonprofit", "Not started", "NotStarted", "2026-01-01", "Nora", "0", "Unknown caller left a message"]) {
      expect(isNothingValue(value), value).toBe(false);
    }
    expect(isNothingValue(null)).toBe(false);
    expect(isNothingValue(0)).toBe(false);
  });
});

describe("formatValue with words for values", () => {
  it("speaks a status", () => {
    expect(formatValue("InProgress", { semantic: "status_enum" })).toBe("In progress");
    expect(formatValue("ACTIVE", { semantic: "status_enum" })).toBe("Active");
  });

  it("speaks a code in a plain text field", () => {
    expect(formatValue("RentalOwner", undefined)).toBe("Rental owner");
  });

  it("never touches identifiers or links", () => {
    expect(formatValue("AbcDef", { semantic: "identifier" })).toBe("AbcDef");
    expect(formatValue("https://example.com/InProgress", { semantic: "url" })).toBe("https://example.com/InProgress");
  });

  it("shows nothing for an API's nothing, in the caller's words", () => {
    expect(formatValue("NotSet", { semantic: "status_enum" })).toBe("—");
    expect(formatValue("NotSet", { semantic: "status_enum" }, { empty: "Not set" })).toBe("Not set");
    expect(formatValue(null, undefined, { empty: "Not set" })).toBe("Not set");
    // A .NET API's "no date" is not 1 January in year one.
    expect(formatValue("0001-01-01T00:00:00", { semantic: "timestamp" })).toBe("—");
  });

  it("prints exactly what was sent when asked to", () => {
    expect(formatValue("NotSet", { semantic: "status_enum" }, { raw: true })).toBe("NotSet");
    expect(formatValue("InProgress", { semantic: "status_enum" }, { raw: true })).toBe("InProgress");
  });
});
