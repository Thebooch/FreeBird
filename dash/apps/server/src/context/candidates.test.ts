import type { ConciergeContext } from "@freebirdai/dash-agent";
import { emptyContext } from "@freebirdai/dash-agent";
import { describe, expect, it } from "vitest";
import { buildCandidates, narrowTo, unreadableConnections } from "./candidates.js";
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

/**
 * A connection with no key answers 401 to everything.
 *
 * Offering its endpoints to the ranker spends a source slot — a quarter of the
 * whole turn — proving what the server already knew, and the user hears it as
 * "I could not find that" rather than "reconnect this account".
 */
describe("unreadable connections", () => {
  const context = (
    readPlans: ConciergeContext["readPlans"],
    ops: ConciergeContext["ops"] = [
      { id: "list_deals", title: "Deals", connection: "acme-crm" },
      { id: "list_tickets", title: "Tickets", connection: "helpdesk" },
    ],
  ): ConciergeContext => ({
    ...emptyContext,
    connections,
    ops,
    readPlans,
  });

  const plan = (connection: string, needsKey: boolean) => ({
    connection,
    requests: 1,
    estimatedMs: 100,
    alreadyRead: true,
    stale: false,
    needsKey,
  });

  const build = (ctx: ConciergeContext, isCached: (key: string) => boolean = () => false) =>
    buildCandidates({
      handles: [],
      context: ctx,
      resolved: { filters: {} } as never,
      isCached,
    });

  it("names the connections that hold no key", () => {
    const found = unreadableConnections(
      context([plan("acme-crm", false), plan("helpdesk", true)]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.connection).toBe("helpdesk");
    // The title, because that is the name the user gave it and the only one
    // they would recognise in a reply.
    expect(found[0]?.title).toBe("Helpdesk");
    expect(found[0]?.reason).toContain("no key");
  });

  it("leaves their endpoints out of the candidate list", () => {
    const built = build(context([plan("acme-crm", false), plan("helpdesk", true)]));
    expect(built.map((entry) => entry.op)).toEqual(["list_deals"]);
  });

  /*
   * The default that keeps this from changing behaviour anywhere it should
   * not. `hasKey` is optional upstream and its absence means "assume it is
   * fine" — refusing on a guess would be worse than trying and being told no.
   */
  it("changes nothing when the caller was not in a position to know", () => {
    const built = build(context([plan("acme-crm", false), plan("helpdesk", false)]));
    expect(built).toHaveLength(2);
    expect(unreadableConnections(context([]))).toEqual([]);
  });
});
