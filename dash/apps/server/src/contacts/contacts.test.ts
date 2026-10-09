import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { Principal } from "@freebirdai/dash-spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryCalendarStore } from "../calendar/store.js";
import { MemoryMembershipStore } from "../identity/members.js";
import { rolePolicy } from "../identity/policy.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { openDashDb, type DashDb } from "../platform/db.js";
import { discover } from "../scheduling/discover.js";
import { SchedulingService } from "../scheduling/service.js";
import { MemorySchedulingStore } from "../scheduling/store.js";
import { ContactService, type ContactReads } from "./service.js";
import { DbContactStore, MemoryContactStore, type ContactStore } from "./store.js";

const NOW = Date.parse("2026-10-12T11:00:00Z");
const owner: Principal = { userId: "sam", workspaceId: "acme", role: "owner", kind: "member" };

/** Records of one type on one connection, read as anyone the test allows. */
const fakeReads = (state: { rows: Array<Record<string, unknown>>; complete: boolean; refuse?: string; fail?: Error; reads: Principal[] }): ContactReads => ({
  read: async (as) => {
    state.reads.push(as);
    if (state.fail) throw state.fail;
    if (state.refuse) return { refused: state.refuse };
    return { rows: state.rows.map((row) => structuredClone(row)), complete: state.complete };
  },
  idField: () => "Id",
  label: (_connection, _entity, row) => (row as Record<string, unknown>)["Name"] as string | undefined,
  describe: () => "Billing's clients",
});

const build = (store: ContactStore = new MemoryContactStore()) => {
  const state = { rows: [] as Array<Record<string, unknown>>, complete: true, refuse: undefined as string | undefined, fail: undefined as Error | undefined, reads: [] as Principal[] };
  let n = 0;
  const contacts = new ContactService({ store, reads: fakeReads(state), now: () => NOW, newId: () => `n${++n}` });
  return { contacts, state, store };
};

/** A segment field filled from the record's `Type` (mapped), and a service area people may give. */
const withFields = async (contacts: ContactService) => {
  await contacts.putField("segment", {
    label: "Segment",
    kind: "choice",
    choices: ["new", "existing"],
    trust: "record",
    sources: [{ connection: "billing", entity: "clients", field: "Type", map: { A: "existing", P: "new" } }],
  });
  await contacts.putField("serviceArea", { label: "Service area", kind: "text", askable: true, ask: "Which part of town is the visit in?" });
  await contacts.putMatchRule(null, { connection: "billing", entity: "clients", on: [{ contact: "email", record: "Contact.Email" }] }, owner);
};

describe("finding and making contacts", () => {
  it("finds one contact by a normalized email or phone, and fills in what it lacked", async () => {
    const { contacts } = build();
    const made = await contacts.findOrCreate({ email: " Ana@Example.COM ", name: "Ana", origin: "public_link" });
    expect(made).toMatchObject({ emails: ["ana@example.com"], name: "Ana", origin: "public_link", stats: { bookings: 0, firstContactAt: new Date(NOW).toISOString() } });

    const again = await contacts.findOrCreate({ email: "ana@example.com", phone: "(512) 555-0142", origin: "agent" });
    expect(again.id).toBe(made.id);
    expect(again.phones).toEqual(["+15125550142"]);
    expect((await contacts.findOrCreate({ phone: "+1 512 555 0142", origin: "agent" })).id).toBe(made.id);

    await expect(contacts.findOrCreate({ name: "Ana", origin: "agent" })).rejects.toThrow(/email or a phone/);
    await expect(contacts.findOrCreate({ phone: "555-0142", origin: "agent" })).rejects.toThrow(/area code/);
  });

  it("makes one contact when two people book with the same email at once", async () => {
    const { contacts, store } = build();
    const all = await Promise.all(Array.from({ length: 6 }, () => contacts.findOrCreate({ email: "ben@example.com", origin: "public_link" })));
    expect(new Set(all.map((one) => one.id)).size).toBe(1);
    expect((await store.list()).contacts).toHaveLength(1);
  });

  it("refuses to give one contact an email another has, naming who has it", async () => {
    const { contacts } = build();
    const ana = await contacts.findOrCreate({ email: "ana@example.com", name: "Ana", origin: "member" });
    const ben = await contacts.findOrCreate({ email: "ben@example.com", name: "Ben", origin: "member" });
    await expect(contacts.update(ben.id, { emails: ["ben@example.com", "ANA@example.com"] }, "sam")).rejects.toMatchObject({ status: 409, holder: ana.id, message: "Ana already has that email." });
    await expect(contacts.create({ name: "Ana again", emails: ["ana@example.com"] }, "sam")).rejects.toMatchObject({ status: 409, holder: ana.id });
    await expect(contacts.update(ben.id, { name: "Benjamin", revision: ben.revision + 5 }, "sam")).rejects.toMatchObject({ status: 409 });
  });
});

describe("linking to records", () => {
  it("links when exactly one record matches, copying mapped values once with where they came from", async () => {
    const { contacts, state } = build();
    await withFields(contacts);
    state.rows = [
      { Id: 41, Name: "Ana Lopez", Type: "A", Contact: { Email: "ANA@example.com" } },
      { Id: 42, Name: "Ben Ortiz", Type: "P", Contact: { Email: "ben@example.com" } },
    ];
    const ana = await contacts.findOrCreate({ email: "ana@example.com", origin: "public_link" });
    const { outcome, contact } = await contacts.matchWithDetail(ana.id);
    expect(outcome).toBe("linked");
    expect(contact.links).toEqual([expect.objectContaining({ connection: "billing", entity: "clients", recordId: "41", label: "Ana Lopez", matchedOn: ["email"], by: "match" })]);
    expect(contact.fields["segment"]?.record).toMatchObject({ value: "existing", ref: { connection: "billing", entity: "clients", recordId: "41", field: "Type" } });
    expect(state.reads).toEqual([owner]);

    /* Copied once: the record changing does nothing until Refresh. */
    state.rows[0]!["Type"] = "P";
    expect(await contacts.match(ana.id)).toBe("none");
    expect((await contacts.require(ana.id)).fields["segment"]?.record?.value).toBe("existing");
    const refreshed = await contacts.refreshWithDetail(ana.id, owner);
    expect(refreshed.problems).toEqual([]);
    expect(refreshed.contact.fields["segment"]?.record?.value).toBe("new");

    /* A value the record no longer has is dropped on Refresh. */
    delete state.rows[0]!["Type"];
    expect((await contacts.refreshWithDetail(ana.id)).contact.fields["segment"]).toBeUndefined();
  });

  it("leaves several matches to a member, and links the one they pick", async () => {
    const { contacts, state } = build();
    await withFields(contacts);
    state.rows = [
      { Id: 1, Name: "Ana (home)", Type: "A", Contact: { Email: "ana@example.com" } },
      { Id: 2, Name: "Ana (office)", Type: "P", Contact: { Email: "ana@example.com" } },
    ];
    const ana = await contacts.findOrCreate({ email: "ana@example.com", origin: "public_link" });
    const { outcome, contact } = await contacts.matchWithDetail(ana.id);
    expect(outcome).toBe("ambiguous");
    expect(contact.links).toEqual([]);
    expect(contact.lastMatch).toMatchObject({ outcome: "ambiguous", candidates: [{ recordId: "1", label: "Ana (home)" }, { recordId: "2", label: "Ana (office)" }] });

    const linked = await contacts.link(ana.id, { connection: "billing", entity: "clients", recordId: "2" }, owner);
    expect(linked.contact.links[0]).toMatchObject({ recordId: "2", by: "member", matchedOn: [] });
    expect(linked.contact.fields["segment"]?.record?.value).toBe("new");
    expect(linked.contact.lastMatch?.outcome).toBe("linked");

    const unlinked = await contacts.unlink(ana.id, { connection: "billing", entity: "clients", recordId: "2" });
    expect(unlinked.links).toEqual([]);
    expect(unlinked.fields["segment"]).toBeUndefined();
  });

  it("never takes a read that was refused, failed or unfinished for 'no such record'", async () => {
    const { contacts, state } = build();
    await withFields(contacts);
    const ana = await contacts.findOrCreate({ email: "ana@example.com", origin: "public_link" });

    state.refuse = "This connection has not been shared with you.";
    expect(await contacts.match(ana.id)).toBe("unavailable");
    expect((await contacts.require(ana.id)).lastMatch?.detail).toMatch(/may not read Billing's clients/);

    state.refuse = undefined;
    state.fail = new Error("Billing is rate limiting us.");
    expect(await contacts.match(ana.id)).toBe("unavailable");

    state.fail = undefined;
    state.complete = false;
    state.rows = [{ Id: 9, Contact: { Email: "someone@example.com" } }];
    expect(await contacts.match(ana.id)).toBe("unavailable");

    state.complete = true;
    expect(await contacts.match(ana.id)).toBe("none");
    expect((await contacts.require(ana.id)).lastMatch).toMatchObject({ outcome: "none", detail: "No record in Billing's clients has this email." });
  });
});

describe("what a contact's fields say", () => {
  it("takes a member's value over a record's over the person's, and trusts only the first two", async () => {
    const { contacts, state } = build();
    await withFields(contacts);
    const ana = await contacts.findOrCreate({ email: "ana@example.com", origin: "public_link" });

    await contacts.record(ana.id, "serviceArea", "north", "person");
    let facts = await contacts.facts(ana.id);
    expect(facts.scope["contact"]).toMatchObject({ serviceArea: "north", email: "ana@example.com", stats: { bookings: 0 } });
    expect(facts.trusted.has("contact.serviceArea")).toBe(false);

    await contacts.update(ana.id, { fields: { serviceArea: "east" } }, "sam");
    facts = await contacts.facts(ana.id);
    expect(facts.scope["contact"]).toMatchObject({ serviceArea: "east" });
    expect(facts.trusted.has("contact.serviceArea")).toBe(true);
    expect((await contacts.require(ana.id)).fields["serviceArea"]).toMatchObject({ person: { value: "north" }, member: { value: "east", by: "sam" } });

    /* The member's value taken back: the person's shows again, untrusted. */
    await contacts.update(ana.id, { fields: { serviceArea: null } }, "sam");
    expect((await contacts.facts(ana.id)).trusted.has("contact.serviceArea")).toBe(false);

    state.rows = [{ Id: 41, Type: "A", Contact: { Email: "ana@example.com" } }];
    await contacts.record(ana.id, "segment", "new", "person");
    await contacts.match(ana.id);
    facts = await contacts.facts(ana.id);
    expect(facts.scope["contact"]).toMatchObject({ segment: "existing" });
    expect(facts.trusted.has("contact.segment")).toBe(true);
    expect(facts.kinds?.get("contact.segment")).toBe("choice");

    await expect(contacts.record(ana.id, "segment", "vip", "person")).rejects.toThrow(/not one of its choices/);
    await expect(contacts.update(ana.id, { fields: { nope: 1 } }, "sam")).rejects.toThrow(/no field "nope"/);
  });

  it("refuses a field key the contact already uses, and one a match rule needs", async () => {
    const { contacts } = build();
    await expect(contacts.putField("email", { label: "Email" })).rejects.toThrow(/contact's own/);
    await expect(contacts.putField("tier", { label: "Tier", kind: "choice" })).rejects.toThrow(/needs its choices/);
    await contacts.putField("account", { label: "Account" });
    await contacts.putMatchRule(null, { connection: "billing", entity: "clients", on: [{ contact: "account", record: "AccountNo" }] }, owner);
    await expect(contacts.removeField("account")).rejects.toMatchObject({ status: 409 });
    await expect(contacts.putMatchRule(null, { connection: "billing", entity: "clients", on: [{ contact: "ghost", record: "x" }] }, owner)).rejects.toThrow(/no contact field "ghost"/);
  });
});

describe("discovery", () => {
  const CHICAGO = "America/Chicago";
  const scheduled = async () => {
    const { contacts, state } = build();
    await withFields(contacts);
    await contacts.putField("pets", { label: "Pets", kind: "boolean", askable: true });
    const scheduling = new SchedulingService({
      store: new MemorySchedulingStore(),
      calendar: new MemoryCalendarStore(),
      members: async () => [{ userId: "sam", email: "sam@acme.test", role: "owner" }],
      factKinds: () => contacts.factKinds(),
      contacts,
      now: () => NOW,
    });
    await scheduling.putProfile("sam", { displayName: "Sam", bookable: true, timezone: CHICAGO, outsideBlocks: "closed" });
    await scheduling.putBlock("north", { name: "North", rules: { all: [{ field: "contact.serviceArea", op: "in", values: ["north"] }] } });
    await scheduling.putBlock("regulars", { name: "Regulars", rules: { all: [{ field: "contact.segment", op: "in", values: ["existing"], trusted: true }] } });
    await scheduling.putPlacement(owner, "tue", { block: "north", target: { kind: "member", id: "sam" }, timezone: CHICAGO, start: "2026-10-13T08:00", end: "2026-10-13T12:00" });
    await scheduling.putPlacement(owner, "wed", { block: "regulars", target: { kind: "member", id: "sam" }, timezone: CHICAGO, start: "2026-10-14T08:00", end: "2026-10-14T12:00" });
    const type = await scheduling.putType("visit", { name: "Visit", slug: "visit", hosts: { members: ["sam"] }, settings: { length: "60m", slotStep: "60m", minNotice: "0m" } });
    return { contacts, state, scheduling, type, range: { from: NOW, to: NOW + 4 * 86_400_000 } };
  };

  it("asks only for fields that change the times, matches once for record fields, and leaves the rest unknown", async () => {
    const { contacts, state, scheduling, type, range } = await scheduled();
    state.rows = [];
    const ana = await contacts.findOrCreate({ email: "ana@example.com", origin: "public_link" });

    const first = await discover({ scheduling, contacts }, { type, contact: ana.id, range });
    expect(first.result.slots).toEqual([]);
    expect(first.matched).toBe("none");
    expect(first.needs).toEqual([{ field: "contact.serviceArea", question: "Which part of town is the visit in?", kind: "text" }]);
    expect(first.unknown).toEqual(["contact.segment"]);

    /* A record turns up: the next look links it, and the regulars' times open. */
    await contacts.record(ana.id, "serviceArea", "north", "person");
    state.rows = [{ Id: 41, Type: "A", Contact: { Email: "ana@example.com" } }];
    const second = await discover({ scheduling, contacts }, { type, contact: ana.id, range });
    expect(second.matched).toBe("linked");
    expect(second.needs).toEqual([]);
    expect(second.unknown).toEqual([]);
    expect(second.result.slots.length).toBe(8);
  });

  it("does not ask again for a field the person answered where a rule wants a record's value", async () => {
    const { contacts, state, scheduling, type, range } = await scheduled();
    await contacts.putField("segment", { label: "Segment", kind: "choice", choices: ["new", "existing"], askable: true, trust: "record" });
    state.refuse = "not shared";
    const ben = await contacts.findOrCreate({ email: "ben@example.com", origin: "public_link" });
    await contacts.record(ben.id, "segment", "existing", "person");
    await contacts.record(ben.id, "serviceArea", "south", "person");
    const found = await discover({ scheduling, contacts }, { type, contact: ben.id, range });
    expect(found.needs).toEqual([]);
    expect(found.unknown).toEqual(["contact.segment"]);
    expect(found.result.slots).toEqual([]);
  });

  it("previews what one real contact would be offered", async () => {
    const { contacts, scheduling } = await scheduled();
    const ana = await contacts.findOrCreate({ email: "ana@example.com", origin: "public_link" });
    await contacts.update(ana.id, { fields: { serviceArea: "north" } }, "sam");
    const preview = await scheduling.preview("visit", { contactId: ana.id, from: "2026-10-12T11:00:00Z", to: "2026-10-16T11:00:00Z" });
    expect(preview.slots.length).toBe(4);
    expect(preview.needs).toEqual(["contact.segment"]);
  });
});

describe("contacts in the database", () => {
  let db: DashDb;
  beforeAll(async () => {
    db = await openDashDb({ databaseUrl: undefined, inMemory: true });
  });
  afterAll(async () => {
    await db.close();
  });

  it("holds each email or phone for one contact, refuses stale saves, and pages newest first", async () => {
    const store = new DbContactStore(db, "acme");
    const { contacts } = build(store);
    const ana = await contacts.findOrCreate({ email: "ana@example.com", phone: "512-555-0142", name: "Ana", origin: "member" });
    expect((await store.byKey("phone:+15125550142"))?.id).toBe(ana.id);

    const all = await Promise.all(Array.from({ length: 4 }, () => contacts.findOrCreate({ email: "ben@example.com", name: "Ben", origin: "public_link" })));
    expect(new Set(all.map((one) => one.id)).size).toBe(1);
    const ben = all[0]!;

    expect(await store.put({ ...ben, emails: ["ben@example.com", "ana@example.com"], revision: ben.revision + 1 }, ben.revision)).toMatchObject({ ok: false, reason: "taken", holder: ana.id });
    expect((await store.get(ben.id))?.emails).toEqual(["ben@example.com"]);
    expect(await store.put({ ...ben, name: "Benjamin", revision: ben.revision + 1 }, ben.revision - 1)).toMatchObject({ ok: false, reason: "revision" });

    /* Dropping an email frees it for someone else. */
    await contacts.update(ana.id, { emails: [], phones: ["512-555-0142"] }, "sam");
    expect(await store.byKey("email:ana@example.com")).toBeNull();
    await contacts.update(ben.id, { emails: ["ben@example.com", "ana@example.com"] }, "sam");
    expect((await store.byKey("email:ana@example.com"))?.id).toBe(ben.id);

    expect((await store.list({ search: "ben" })).contacts.map((one) => one.id)).toEqual([ben.id]);
    expect((await store.list({ search: "5550142" })).contacts.map((one) => one.id)).toEqual([ana.id]);
    const first = await store.list({ limit: 1 });
    expect(first.contacts).toHaveLength(1);
    const second = await store.list({ limit: 1, after: first.next! });
    expect(second.contacts).toHaveLength(1);
    expect(second.contacts[0]!.id).not.toBe(first.contacts[0]!.id);
    expect(second.next).toBeUndefined();

    await contacts.forget(ana.id);
    expect(await store.byKey("phone:+15125550142")).toBeNull();
    expect(await new DbContactStore(db, "other").get(ben.id)).toBeNull();
  });

  it("keeps field definitions and match rules", async () => {
    const store = new DbContactStore(db, "acme");
    const { contacts } = build(store);
    await withFields(contacts);
    expect((await contacts.setup()).fields.map((one) => one.key).sort()).toEqual(["segment", "serviceArea"]);
    expect((await contacts.setup()).matchRules[0]).toMatchObject({ connection: "billing", savedBy: owner });
  });
});

describe("contact routes", () => {
  it("lets those who read records read contacts, and only contacts.manage change them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-contacts-"));
    try {
      const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
      const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
      const memberships = new MemoryMembershipStore();
      const member = (userId: string, role: Principal["role"]) => ({ workspaceId: "acme", userId, email: `${userId}@acme.test`, role, grants: [], joinedAt: "2026-10-06T00:00:00.000Z" });
      await memberships.putMember(member("ed", "editor"));
      await memberships.putMember(member("vi", "viewer"));
      const contacts = new MemoryContactStore();
      const as = (userId: string, role: Principal["role"]) => ({ resolve: () => ({ userId, workspaceId: "acme", role, kind: "member" as const }) });
      const editor = buildServer({ store, keys, contacts, policy: rolePolicy(memberships), identity: as("ed", "editor") });
      const viewer = buildServer({ store, keys, contacts, policy: rolePolicy(memberships), identity: as("vi", "viewer") });

      const made = await editor.inject({ method: "POST", url: "/api/contacts", payload: { name: "Ana", emails: ["Ana@Example.com"], phones: ["512 555 0142"] } });
      expect(made.statusCode).toBe(200);
      const ana = made.json();
      expect(ana).toMatchObject({ name: "Ana", emails: ["ana@example.com"], phones: ["+15125550142"], origin: "member" });

      const twice = await editor.inject({ method: "POST", url: "/api/contacts", payload: { name: "Ana", emails: ["ana@example.com"] } });
      expect(twice.statusCode).toBe(409);
      expect(twice.json().holder).toBe(ana.id);

      expect((await viewer.inject({ method: "GET", url: "/api/contacts?search=ana" })).json().contacts.map((one: { id: string }) => one.id)).toEqual([ana.id]);
      expect((await viewer.inject({ method: "GET", url: `/api/contacts/${ana.id}` })).json().name).toBe("Ana");
      const refused = await viewer.inject({ method: "PUT", url: `/api/contacts/${ana.id}`, payload: { name: "X" } });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().permission).toBe("contacts.manage");
      expect((await viewer.inject({ method: "GET", url: "/api/contacts/sources" })).statusCode).toBe(403);

      expect((await editor.inject({ method: "PUT", url: "/api/contacts/fields/serviceArea", payload: { label: "Service area", askable: true } })).statusCode).toBe(200);
      const changed = await editor.inject({ method: "PUT", url: `/api/contacts/${ana.id}`, payload: { fields: { serviceArea: "north" }, revision: ana.revision } });
      expect(changed.json().fields.serviceArea.member).toMatchObject({ value: "north", by: "ed" });
      const stale = await editor.inject({ method: "PUT", url: `/api/contacts/${ana.id}`, payload: { name: "Ana L", revision: ana.revision } });
      expect(stale.statusCode).toBe(409);
      expect((await editor.inject({ method: "GET", url: "/api/contacts/setup" })).json().fields.map((one: { key: string }) => one.key)).toEqual(["serviceArea"]);
      expect((await editor.inject({ method: "GET", url: "/api/contacts/sources" })).json()).toEqual([]);
      expect((await editor.inject({ method: "POST", url: `/api/contacts/${ana.id}/match` })).json()).toMatchObject({ outcome: "none" });
      expect((await editor.inject({ method: "DELETE", url: `/api/contacts/${ana.id}` })).statusCode).toBe(200);
      expect((await viewer.inject({ method: "GET", url: `/api/contacts/${ana.id}` })).statusCode).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
