import type { ColumnMeta, ColumnReference } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { recordEntries, referenceText } from "./resolve.js";

/**
 * What a reference cell says, and whether it opens.
 *
 * The three-way precedence is the whole of it — the name on the row, then one
 * that was fetched, then a fallback that at least says what kind of thing the
 * number is. The last is the one most readers meet on a wide table, so it is
 * tested hardest.
 */

const reference = (input: Partial<ColumnReference> = {}): ColumnReference => ({
  target: "vendor",
  targetName: "Vendor",
  targetTitle: ["CompanyName"],
  holds: "scalar",
  embedded: [],
  lookup: { op: "vendors_byid", param: "vendorId" },
  ...input,
});

const cell = (input: {
  row: Record<string, unknown>;
  reference?: ColumnReference;
  names?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  formatted?: string;
}) =>
  referenceText({
    row: input.row,
    column: "VendorId",
    reference: input.reference ?? reference(),
    ...(input.names ? { names: input.names } : {}),
    ...(input.formatted ? { formatted: input.formatted } : {}),
  });

describe("recordEntries", () => {
  it("carries a column's reference through to the record view", () => {
    /*
     * A record is where a bare id is least forgivable, so the reference has to
     * survive the trip from the column into the label/value pair — otherwise
     * the record view is the one surface that still shows `VendorId 4711`.
     */
    const columns: ColumnMeta[] = [
      { name: "Title", valueType: "text" },
      { name: "VendorId", valueType: "categorical", reference: reference() },
    ];
    const entries = recordEntries(
      { rows: [{ Title: "Leak", VendorId: 41 }], columns, format: {}, now: 0 },
      ["Title", "VendorId"],
    );

    expect(entries.find((entry) => entry.name === "VendorId")?.reference?.target).toBe("vendor");
    // An ordinary field is untouched, so nothing else in the view changes.
    expect(entries.find((entry) => entry.name === "Title")?.reference).toBeUndefined();
  });

  it("carries what the record type says a field means", () => {
    /*
     * The specification described 2,898 of one real API's 2,927 field entries
     * and not one of those sentences ever reached a reader. A record is the
     * one surface with room for them — a table header has none — so this is
     * where they land.
     */
    const columns: ColumnMeta[] = [
      { name: "Title", valueType: "text", description: "What the job is." },
      { name: "Notes", valueType: "text" },
    ];
    const entries = recordEntries(
      { rows: [{ Title: "Leak", Notes: "" }], columns, format: {}, now: 0 },
      ["Title", "Notes"],
    );

    expect(entries.find((entry) => entry.name === "Title")?.description).toBe("What the job is.");
    // None was written for this one, and none is invented.
    expect(entries.find((entry) => entry.name === "Notes")?.description).toBeUndefined();
  });
});

describe("referenceText", () => {
  it("prefers the name already on the row, and costs nothing to do it", () => {
    expect(
      cell({
        row: { VendorId: 41, Vendor_Name: "Acme Plumbing" },
        reference: reference({ embedded: ["Vendor_Name"] }),
      }).text,
    ).toBe("Acme Plumbing");
  });

  it("joins several embedded fields, which is how a person's name arrives", () => {
    expect(
      cell({
        row: { VendorId: 41, First: "Ada", Last: "Byron" },
        reference: reference({ embedded: ["First", "Last"] }),
      }).text,
    ).toBe("Ada Byron");
  });

  it("uses a fetched name when the row carries none", () => {
    expect(
      cell({ row: { VendorId: 41 }, names: { VendorId: { "41": "Acme Plumbing" } } }).text,
    ).toBe("Acme Plumbing");
  });

  it("names the kind of record when nothing resolved", () => {
    /*
     * The honest fallback, and the reason this feature is worth shipping before
     * the lookups are complete: "Vendor 4711" is legible where 4711 is not.
     */
    expect(cell({ row: { VendorId: 4711 } }).text).toBe("Vendor 4711");
  });

  it("counts a list rather than pretending it is one record", () => {
    expect(
      cell({ row: { VendorId: [1, 2, 3] }, reference: reference({ holds: "array" }) }),
    ).toMatchObject({ text: "3 vendors", canOpen: false });
  });

  it("opens only a single id, and only where something can return it", () => {
    expect(cell({ row: { VendorId: 41 } })).toMatchObject({
      canOpen: true,
      target: { entity: "vendor", id: 41 },
    });
    expect(cell({ row: { VendorId: 41 }, reference: reference({ lookup: undefined }) })).toMatchObject(
      { canOpen: false },
    );
    expect(cell({ row: {} })).toMatchObject({ canOpen: false });
  });

  it("falls back to the formatted value for an empty cell", () => {
    // Whatever the widget would have printed anyway — never a stray "Vendor".
    expect(cell({ row: { VendorId: null }, formatted: "—" }).text).toBe("—");
  });

  it("leaves a row pointing at another kind of record alone", () => {
    /*
     * Nothing here knows what that kind is called, and borrowing this link's
     * name would mislabel the record. The plain value is the only honest
     * answer, and it is not offered as a link.
     */
    const poly = reference({ typeColumn: "Kind", typeMap: { Rental: "vendor" } });
    expect(
      cell({ row: { VendorId: 9, Kind: "Association" }, reference: poly, formatted: "9" }),
    ).toEqual({ text: "9", canOpen: false });
  });

  it("honours a type column that does name this link's own kind", () => {
    const poly = reference({ typeColumn: "Kind", typeMap: { Rental: "vendor" } });
    expect(cell({ row: { VendorId: 9, Kind: "Rental" }, reference: poly })).toMatchObject({
      text: "Vendor 9",
      canOpen: true,
    });
  });

  it("treats an absent type as the link's default rather than a refusal", () => {
    // The row simply did not say. The link's own answer is the best evidence
    // there is, and refusing would lose a name for no gain.
    const poly = reference({ typeColumn: "Kind", typeMap: { Rental: "vendor" } });
    expect(cell({ row: { VendorId: 9 }, reference: poly }).canOpen).toBe(true);
  });
});
