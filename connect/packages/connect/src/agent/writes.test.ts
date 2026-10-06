import { entitySchema } from "@freebirdai/connect-spec";
import { describe, expect, it } from "vitest";
import { fakeLlm } from "./llm.js";
import { buildMatchPrompt, matchWriteFields } from "./writes.js";

const PROPERTY = entitySchema.parse({
  id: "rental",
  resource: "rental",
  name: { one: "Property", many: "Properties" },
  kind: "asset",
  identity: { field: "Id" },
  fields: [
    { path: "Id", kinds: ["number"] },
    { path: "Name", kinds: ["string"] },
    { path: "RentalManager", kinds: ["object"] },
    { path: "RentalManager.Id", kinds: ["number"], label: "Manager" },
    { path: "RentalManager.FirstName", kinds: ["string"] },
  ],
});

const UNMATCHED = [
  { path: "PropertyManagerId", type: "integer" as const, required: false, readFrom: null },
  { path: "Notes", type: "string" as const, required: false, readFrom: null },
  { path: "Grade", type: "integer" as const, required: false, readFrom: null },
];

describe("matchWriteFields", () => {
  it("keeps a match that holds up, and says plainly where there is none", async () => {
    const llm = fakeLlm([
      {
        args: {
          matches: [
            { field: "PropertyManagerId", readFrom: "RentalManager.Id", label: "Property manager" },
            { field: "Notes" },
            // A name, not an id: the kinds disagree, so it is refused.
            { field: "Grade", readFrom: "RentalManager.FirstName" },
          ],
        },
      },
    ]);
    const result = await matchWriteFields(llm, { apiTitle: "Rentals", entity: PROPERTY, fields: UNMATCHED });
    if ("error" in result) throw new Error(result.error);
    const by = Object.fromEntries(result.fields.map((field) => [field.path, field]));
    expect(by["PropertyManagerId"]).toMatchObject({ readFrom: "RentalManager.Id", mappedBy: "model", label: "Property manager" });
    expect(by["Notes"]).toMatchObject({ readFrom: null, mappedBy: "model" });
    expect(by["Grade"]?.mappedBy).toBeUndefined();
    expect(result.matched).toBe(1);
    expect(result.refused).toEqual(["Grade → RentalManager.FirstName"]);
  });

  it("drops a record field the model invented", async () => {
    const llm = fakeLlm([{ args: { matches: [{ field: "PropertyManagerId", readFrom: "Manager.Id" }] } }]);
    const result = await matchWriteFields(llm, { apiTitle: "Rentals", entity: PROPERTY, fields: UNMATCHED.slice(0, 1) });
    if ("error" in result) throw new Error(result.error);
    expect(result.fields[0]?.readFrom).toBeNull();
    expect(result.fields[0]?.mappedBy).toBeUndefined();
    expect(result.refused).toHaveLength(1);
  });

  it("asks again, once, when the answer names a field that was not asked about", async () => {
    const llm = fakeLlm([
      { args: { matches: [{ field: "Invented", readFrom: "Name" }] } },
      { args: { matches: [{ field: "Notes" }] } },
    ]);
    const result = await matchWriteFields(llm, { apiTitle: "Rentals", entity: PROPERTY, fields: UNMATCHED.slice(1, 2) });
    expect("error" in result).toBe(false);
    expect(llm.calls).toHaveLength(2);
  });

  it("costs nothing with nothing to match", async () => {
    const llm = fakeLlm([]);
    await matchWriteFields(llm, { apiTitle: "Rentals", entity: PROPERTY, fields: [] });
    expect(llm.calls).toHaveLength(0);
  });

  it("carries the untrusted-data line and never the record's containers", () => {
    const prompt = buildMatchPrompt({ apiTitle: "Rentals", entity: PROPERTY, fields: UNMATCHED });
    expect(prompt).toContain("RentalManager.Id");
    expect(prompt).not.toMatch(/^- RentalManager \(/m);
  });
});
