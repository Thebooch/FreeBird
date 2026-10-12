import type { ContactFieldDef } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { fieldsToFill } from "./extract.js";

const def = (key: string, fromEmail?: ContactFieldDef["fromEmail"]): ContactFieldDef => ({
  key,
  label: key,
  kind: "text",
  askable: false,
  trust: "any",
  sources: [],
  ...(fromEmail ? { fromEmail } : {}),
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
});

describe("fieldsToFill", () => {
  it("is only fields set to fill from email that the contact has nothing for, from anyone", () => {
    const defs = [def("a", { enabled: true, look: "x" }), def("b", { enabled: true, look: "y" }), def("c"), def("d", { enabled: false, look: "z" })];
    const contact = { fields: { b: { member: { value: "kept", at: "2026-10-11T00:00:00.000Z" } } } };
    expect(fieldsToFill(defs, contact).map((one) => one.key)).toEqual(["a"]);
  });
});
