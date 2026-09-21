import { describe, expect, it } from "vitest";
import { isFieldNoise, looksLikeApiLink, looksLikeIdentifier } from "./semantics.js";

/**
 * Which fields exist for the API rather than for the person reading it.
 *
 * These three rules decide what a record view shows when nobody arranged one,
 * and which columns a table takes when nobody picked any. Getting them wrong
 * is visible in opposite directions: too loose and a record opens on a wall of
 * numbers pointing elsewhere, too tight and a real column disappears with no
 * way to tell it ever existed.
 */

describe("looksLikeIdentifier", () => {
  it("reads the conventions APIs actually use", () => {
    for (const name of ["Id", "id", "ID", "VendorId", "vendor_id", "unitID"]) {
      expect(looksLikeIdentifier(name), name).toBe(true);
    }
  });

  it("leaves alone the ordinary words that end the same way", () => {
    // A bid, a grid and an amount that was paid are not references, and
    // reading them as such would hide real columns.
    for (const name of ["bid", "paid", "valid", "grid", "rapid", "solid"]) {
      expect(looksLikeIdentifier(name), name).toBe(false);
    }
  });

  it("does not treat a word merely containing the letters as one", () => {
    for (const name of ["Identity", "Idea", "Video", "Width"]) {
      expect(looksLikeIdentifier(name), name).toBe(false);
    }
  });
});

describe("looksLikeApiLink", () => {
  it("matches the API's own self-reference, nested or not", () => {
    for (const name of ["Href", "href", "Url", "uri", "Category.Href", "Property.Url"]) {
      expect(looksLikeApiLink(name), name).toBe(true);
    }
  });

  it("keeps a link somebody would actually follow", () => {
    // The reason this is an exact-word test rather than a substring one.
    for (const name of ["RentalApplicationUrl", "ReceiptUrl", "PhotoUrl", "WebsiteUri"]) {
      expect(looksLikeApiLink(name), name).toBe(false);
    }
  });
});

describe("isFieldNoise", () => {
  it("drops the ids of other records", () => {
    for (const name of ["VendorId", "OperatingBankAccountId", "Property.Id", "RentalManager.Id"]) {
      expect(isFieldNoise(name), name).toBe(true);
    }
  });

  it("keeps the record's own bare identity", () => {
    /*
     * The useful half of the rule. It is the one identifier a reader uses —
     * to quote in a ticket, or to hand to somebody else — and on an endpoint
     * with no name field it is the only thing telling two rows apart.
     */
    expect(isFieldNoise("Id")).toBe(false);
    expect(isFieldNoise("id")).toBe(false);
  });

  it("drops the API's self-links", () => {
    expect(isFieldNoise("Href")).toBe(true);
    expect(isFieldNoise("Category.Href")).toBe(true);
  });

  it("keeps everything a person reads", () => {
    for (const name of [
      "Title",
      "Category.Name",
      "Status",
      "DueDate",
      "Amount",
      "RentalApplicationUrl",
    ]) {
      expect(isFieldNoise(name), name).toBe(false);
    }
  });
});
