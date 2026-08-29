import { describe, expect, it } from "vitest";
import { narrowTo } from "./candidates.js";
import type { Candidate } from "./types.js";

/**
 * "In my platform X conversations, has anyone mentioned running late?"
 *
 * Naming a place is a hard constraint, not a hint: reading somewhere they did
 * not ask about spends their API quota to answer a question nobody asked. But
 * people name a connection, a tab or a widget interchangeably and by title far
 * more often than by id, so the matching has to be generous about *how* it was
 * named while staying strict about *whether* it was.
 */

const candidate = (over: Partial<Candidate>): Candidate => ({
  kind: "widget",
  id: "x",
  title: "X",
  describes: "",
  connection: "acme",
  op: "list_things",
  fields: [],
  cached: false,
  ...over,
});

const connections = [
  { id: "acme-crm", title: "Acme CRM" },
  { id: "helpdesk", title: "Helpdesk" },
];

const all = [
  candidate({ id: "deals", title: "Open deals", connection: "acme-crm", tab: "Sales" }),
  candidate({ id: "contacts", title: "Contacts", connection: "acme-crm", tab: "Sales" }),
  candidate({ id: "tickets", title: "Conversations", connection: "helpdesk", tab: "Support" }),
];

describe("narrowTo", () => {
  it("restricts to a connection named by its title", () => {
    expect(narrowTo(all, "Helpdesk", connections).map((entry) => entry.id)).toEqual(["tickets"]);
  });

  it("restricts to a connection named by its id", () => {
    expect(narrowTo(all, "acme-crm", connections).map((entry) => entry.id)).toEqual([
      "deals",
      "contacts",
    ]);
  });

  /* People say "my Acme conversations", not "the acme-crm connection". */
  it("matches a partial name in either direction", () => {
    expect(narrowTo(all, "Acme", connections)).toHaveLength(2);
    expect(narrowTo(all, "my Helpdesk account", connections)).toHaveLength(1);
  });

  it("restricts to one widget when that is what was named", () => {
    expect(narrowTo(all, "Open deals", connections).map((entry) => entry.id)).toEqual(["deals"]);
  });

  it("restricts to a tab", () => {
    expect(narrowTo(all, "Support", connections).map((entry) => entry.id)).toEqual(["tickets"]);
  });

  it("is case-insensitive, because nobody types an id exactly", () => {
    expect(narrowTo(all, "HELPDESK", connections)).toHaveLength(1);
  });

  /*
   * A name that resolves to nothing is a reason to search normally and say
   * where it looked. Refusing outright would turn a slightly-off name into a
   * dead end, which is a worse answer than a wider one.
   */
  it("falls back to everything rather than nothing when the name resolves to nothing", () => {
    expect(narrowTo(all, "Salesforce", connections)).toHaveLength(3);
  });

  it("is everything when no place was named", () => {
    expect(narrowTo(all, "", connections)).toHaveLength(3);
    expect(narrowTo(all, "   ", connections)).toHaveLength(3);
  });
});
