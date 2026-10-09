import { describe, expect, it } from "vitest";
import { contactColor, contactTitle, fieldValues, formatPhone, initials, keyOfLabel, relativeTime, sourceWords, valueWords } from "./model.js";

const NOW = Date.parse("2026-10-08T15:20:00Z");

describe("contact words", () => {
  it("names a contact by its name, else its email, else its phone", () => {
    expect(contactTitle({ name: "Ana Lopez", emails: ["a@x.test"], phones: [] })).toBe("Ana Lopez");
    expect(contactTitle({ name: " ", emails: ["a@x.test"], phones: [] })).toBe("a@x.test");
    expect(contactTitle({ name: "", emails: [], phones: ["+15125550142"] })).toBe("(512) 555-0142");
    expect(initials({ name: "Ana María Lopez", emails: [], phones: [] })).toBe("AL");
    expect(initials({ name: "", emails: ["gus@x.test"], phones: [] })).toBe("G");
  });

  it("shows North American numbers the usual way and others in groups", () => {
    expect(formatPhone("+15125550142")).toBe("(512) 555-0142");
    expect(formatPhone("+442079460958")).toBe("+44 2079 460 958");
  });

  it("keeps a contact's colour the same every time", () => {
    expect(contactColor("ct-ana")).toBe(contactColor("ct-ana"));
    expect(contactColor("ct-ana")).toBeGreaterThanOrEqual(1);
    expect(contactColor("ct-ana")).toBeLessThanOrEqual(8);
  });

  it("lists a field's values strongest first, and reads an address as a line", () => {
    const field = { person: { value: "north", at: "2026-10-07T00:00:00Z" }, member: { value: "east", by: "sam", at: "2026-10-08T00:00:00Z" } };
    expect(fieldValues(field).map((one) => one.from)).toEqual(["member", "person"]);
    expect(valueWords({ line1: "1208 W 34th St", city: "Austin", region: "TX", postalCode: "78705" })).toBe("1208 W 34th St, Austin, TX 78705");
    expect(valueWords(false)).toBe("No");
    expect(valueWords(undefined)).toBe("—");
  });

  it("makes a field key from its name", () => {
    expect(keyOfLabel("Service area")).toBe("serviceArea");
    expect(keyOfLabel("  Pets on-site? ")).toBe("petsOnSite");
    expect(keyOfLabel("2nd phone")).toBe("field2ndPhone");
  });

  it("says where a source is, from what the connections list knows", () => {
    const sources = [{ connection: "billing", title: "Billing", entities: [{ entity: "clients", name: "Client", fields: [{ path: "Type", label: "Client type", samples: ["A", "P"] }] }] }];
    expect(sourceWords({ connection: "billing", entity: "clients", field: "Type" }, sources)).toBe("Billing · Client · Client type");
    expect(sourceWords({ connection: "gone", entity: "x", field: "y" }, sources)).toBe("gone · x · y");
  });

  it("says how long ago, briefly", () => {
    expect(relativeTime("2026-10-08T15:19:50Z", NOW)).toBe("just now");
    expect(relativeTime("2026-10-08T14:35:00Z", NOW)).toBe("45 min ago");
    expect(relativeTime("2026-10-08T10:20:00Z", NOW)).toBe("5 h ago");
    expect(relativeTime("2026-10-07T10:20:00Z", NOW)).toBe("yesterday");
  });
});
