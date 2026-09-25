import { describe, expect, it } from "vitest";
import { parentsFrom, recordKeyString, valueForParam } from "./record-key.js";

/**
 * A record's whole address, for the records whose own id is not enough.
 */
describe("record keys", () => {
  it("keys a top-level record on its id exactly as before", () => {
    expect(recordKeyString(41)).toBe("41");
    expect(recordKeyString("41", {})).toBe("41");
  });

  it("keeps two records with one id under different parents apart", () => {
    // Unit 222 of one property is not unit 222 of the next.
    expect(recordKeyString("222", { propertyID: "210" })).not.toBe(
      recordKeyString("222", { propertyID: "211" }),
    );
  });

  it("is the same key whatever order the parents were spelled in", () => {
    expect(recordKeyString("7", { a: "1", b: "2" })).toBe(recordKeyString("7", { b: "2", a: "1" }));
  });
});

describe("finding a parent's id", () => {
  const parts = [{ param: "propertyID", field: "unit.propertyID" }];

  it("reads it off the row, nested or not", () => {
    expect(parentsFrom(parts, { unit: { propertyID: 210 } })).toEqual({ propertyID: "210" });
    expect(parentsFrom(parts, { unit_propertyID: 210 })).toEqual({ propertyID: "210" });
  });

  it("falls back to what is known, under any spelling of the parameter", () => {
    // The page it was opened from says `propertyId`; this endpoint says `propertyID`.
    expect(parentsFrom([{ param: "propertyID" }], {}, { propertyId: 210 })).toEqual({
      propertyID: "210",
    });
  });

  it("is nothing at all when any part is missing", () => {
    // An address with a hole in it fetches nothing but an error.
    expect(parentsFrom(parts, { unit: {} })).toBeNull();
    expect(parentsFrom([{ param: "leaseId" }], {}, {})).toBeNull();
  });

  it("never takes an unresolved template for a value", () => {
    expect(valueForParam({ propertyID: "{{param.propertyID}}" }, "propertyID")).toBeUndefined();
    expect(valueForParam({ propertyID: "" }, "propertyID")).toBeUndefined();
  });
});
