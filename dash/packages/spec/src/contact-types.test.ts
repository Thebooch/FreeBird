import { describe, expect, it } from "vitest";
import { contactTypes } from "./contact.js";
import { passes } from "./workflow-expr.js";

const rule = (connection: string, entity: string, type?: string) => ({ connection, entity, ...(type ? { type } : {}) });
const link = (connection: string, entity: string) => ({ connection, entity, recordId: "1", by: "match" as const, matchedOn: ["email"], syncedAt: "2026-10-11T00:00:00.000Z" });

describe("contact types", () => {
  const rules = [rule("rv", "tenant", "Tenant"), rule("bill", "vendor", "Vendor"), rule("rv", "owner")];
  it("come from the rules whose record type the contact is linked to, each once", () => {
    expect(contactTypes({ links: [link("rv", "tenant")] }, rules)).toEqual(["Tenant"]);
    expect(contactTypes({ links: [link("bill", "vendor"), link("rv", "tenant")] }, rules)).toEqual(["Tenant", "Vendor"]);
    expect(contactTypes({ links: [link("rv", "owner")] }, rules)).toEqual([]);
    expect(contactTypes({ links: [] }, rules)).toEqual([]);
  });
  it("take a workflow's path: a known type, two types, and someone unknown", () => {
    const at = Date.UTC(2026, 9, 11);
    expect(passes('contains(contact.types, "Tenant")', { contact: { types: ["Tenant"] } }, at)).toBe(true);
    expect(passes('contains(contact.types, "Vendor")', { contact: { types: ["Tenant", "Vendor"] } }, at)).toBe(true);
    expect(passes('contains(contact.types, "Tenant")', { contact: { types: [] } }, at)).toBe(false);
    expect(passes("len(contact.types) == 0", { contact: { types: [] } }, at)).toBe(true);
  });
});
