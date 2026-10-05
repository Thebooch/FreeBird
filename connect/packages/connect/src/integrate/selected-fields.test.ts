import { connectionSchema, getOp } from "@freebirdai/connect-spec";
import { describe, expect, it } from "vitest";
import { fieldSelector, holdsOnlyIds } from "./selected-fields.js";

/* Regression (trackwell mock API): issues came back as ids unless their fields were asked for. */
describe("records that come back as ids alone", () => {
  it("are told apart from records that say something", () => {
    expect(holdsOnlyIds({ id: "10001" })).toBe(true);
    expect(holdsOnlyIds({ id: "10001", key: "PLAT-1", self: "https://x.test/issue/10001", fields: {} })).toBe(true);
    expect(holdsOnlyIds({ id: "10001", fields: { status: { name: "Open" } } })).toBe(false);
    expect(holdsOnlyIds({ id: 7, name: "Ann" })).toBe(false);
  });

  it("are asked for their fields with the value the documentation says asks for every one", () => {
    const op = (params: unknown[]) =>
      getOp(connectionSchema.parse({ id: "c", title: "C", kind: "rest", baseUrl: "https://x.test", ops: [{ id: "s", title: "S", path: "/s", params }] }), "s")!;
    expect(
      fieldSelector(op([{ name: "fields", in: "query", description: "The fields to return. By default only the ID is returned. *all returns every field, *navigable the navigable ones." }])),
    ).toEqual({ name: "fields", all: "*all" });
    expect(fieldSelector(op([{ name: "$select", in: "query", enum: ["id", "name", "*"] }]))).toEqual({ name: "$select", all: "*" });
    /* Named for fields, but nothing says how to ask for all of them: nothing is guessed. */
    expect(fieldSelector(op([{ name: "fields", in: "query", description: "Comma-separated field names." }]))).toBeNull();
  });
});
