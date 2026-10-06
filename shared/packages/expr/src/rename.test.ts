import { describe, expect, it } from "vitest";
import { renameExprFields } from "./rename.js";
import { parseExpr } from "./index.js";

describe("expression field renaming", () => {
  it("preserves literals while restoring nested field references", () => {
    const result = renameExprFields('Address_City == "Address_City"', {
      Address_City: "Address.City",
    });
    expect(result).toBe('Address.City == "Address_City"');
    expect(parseExpr(result)).toBeDefined();
  });
  it("does not rename function calls", () => {
    expect(renameExprFields("lower(Name)", { lower: "Other", Name: "Owner.Name" })).toBe(
      "lower(Owner.Name)",
    );
  });
});
