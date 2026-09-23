import { describe, expect, it } from "vitest";
import { readField } from "./field-path.js";

/**
 * One value off a row, by a path that may nest.
 *
 * Rentvine's records arrive wrapped — `{ property: { propertyID, name } }` —
 * so its identity is `property.propertyID`, and a reader that only tried the
 * key as written found nothing on any of its rows.
 */

const wrapped = { property: { propertyID: 12, name: "Maple Court" } };

describe("reading a field by its path", () => {
  it("reads a top-level field as written", () => {
    expect(readField({ Id: 41 }, "Id")).toBe(41);
  });

  it("reads a field nested the way the API sent it", () => {
    expect(readField(wrapped, "property.propertyID")).toBe(12);
  });

  it("reads the column a derive step flattened it to", () => {
    expect(readField({ property_name: "Maple Court" }, "property.name")).toBe("Maple Court");
  });

  it("prefers a key spelled with the dot, where an API really has one", () => {
    expect(readField({ "property.name": "As keyed", property: { name: "Nested" } }, "property.name")).toBe(
      "As keyed",
    );
  });

  it("keeps a null that is really there, rather than reading past it", () => {
    expect(readField({ property: { propertyID: null } }, "property.propertyID")).toBeNull();
  });

  it("finds nothing where there is nothing, whatever it was handed", () => {
    expect(readField(wrapped, "property.missing")).toBeUndefined();
    expect(readField(wrapped, "lease.leaseID")).toBeUndefined();
    expect(readField({ property: "not an object" }, "property.propertyID")).toBeUndefined();
    expect(readField({ Id: 41 }, "id")).toBeUndefined();
    expect(readField(null, "Id")).toBeUndefined();
    expect(readField([{ Id: 41 }], "Id")).toBeUndefined();
    expect(readField("text", "length")).toBeUndefined();
  });
});
