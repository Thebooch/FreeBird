import type { EntityWritesView } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import type { RecordChangeRequest } from "../EntityRecordPage.jsx";
import { addLabel, changeRowActions, recordChangeRequests, recordToolbar } from "./requests.js";

const kind = (op: string, mode: "create" | "replace" | "merge" | "upsert" | "delete" | "action", title: string) => ({
  op,
  mode,
  title,
  confidence: "declared" as const,
  confirmed: true,
  verified: false,
});

const PROPERTY: EntityWritesView = {
  create: kind("create_rental", "create", "Create a property"),
  update: kind("update_rental", "replace", "Update a property"),
  remove: kind("delete_rental", "delete", "Delete a property"),
  actions: [
    { ...kind("inactivate", "action", "Inactivate a property"), id: "inactivationrequest", danger: false },
    { ...kind("purge", "action", "Purge a property"), id: "purge", danger: true },
  ],
};

const BASE = { connection: "rentals", entity: "rental", entityName: "Property", id: "42" };

describe("what can be done to one record", () => {
  it("is edit, then its actions, then delete — never a create", () => {
    const requests = recordChangeRequests(BASE, PROPERTY);
    expect(requests.map((request) => [request.kind, request.title])).toEqual([
      ["update", "Edit"],
      ["action", "Inactivate a property"],
      ["action", "Purge a property"],
      ["delete", "Delete"],
    ]);
    expect(requests.every((request) => request.id === "42" && request.entityName === "Property")).toBe(true);
  });

  it("says what the endpoint does where it has no name to say it under", () => {
    const { entityName: _unnamed, ...unnamed } = BASE;
    const titles = recordChangeRequests(unnamed, PROPERTY).map((request) => request.title);
    expect(titles[0]).toBe("Update a property");
    expect(titles.at(-1)).toBe("Delete a property");
  });

  it("offers nothing the server did not allow, and no in-place edit of something that exists once", () => {
    expect(recordChangeRequests(BASE, undefined)).toEqual([]);
    expect(recordChangeRequests(BASE, { actions: [] })).toEqual([]);
    const listing: EntityWritesView = { update: kind("upsert_listing", "upsert", "Create/Update a listing"), actions: [] };
    expect(recordChangeRequests(BASE, listing)).toEqual([]);
  });

  it("becomes a row's menu, the ones that cannot be taken back marked", () => {
    const opened: RecordChangeRequest[] = [];
    const actions = changeRowActions(recordChangeRequests(BASE, PROPERTY), (request) => opened.push(request));
    expect(actions.map((action) => [action.id, action.label, action.tone])).toEqual([
      ["change-update", "Edit", "default"],
      ["change-action-inactivationrequest", "Inactivate a property", "default"],
      ["change-action-purge", "Purge a property", "danger"],
      ["change-delete", "Delete", "danger"],
    ]);
    actions[3]!.onSelect();
    expect(opened).toMatchObject([{ kind: "delete", id: "42", entity: "rental" }]);
  });
});

describe("a record page's toolbar", () => {
  const LEASE = { connection: "rentals", entity: "lease", entityName: "Lease", id: "9" };
  const act = (id: string, title: string, extra: { creates?: boolean; danger?: boolean } = {}) => ({
    ...kind(id, "action", title),
    id,
    danger: extra.danger ?? false,
    ...(extra.creates ? { creates: true } : {}),
  });
  const own = recordChangeRequests(LEASE, {
    update: kind("update_lease", "replace", "Update a lease"),
    remove: kind("delete_lease", "delete", "Delete a lease"),
    actions: [
      act("credits", "Create a credit", { creates: true }),
      act("payments", "Create a payment (auto allocated)", { creates: true }),
      act("terminate", "Terminate a lease", { danger: true }),
    ],
  });
  const under = (entity: string, request: Omit<RecordChangeRequest, "connection" | "entity">) => ({
    section: { entity },
    requests: [{ connection: "rentals", entity, ...request }],
  });
  const sections = [
    under("lease-charge", { kind: "create", title: "Create a charge" }),
    under("lease-note", { kind: "create", title: "Create a note" }),
    under("lease-epay", { kind: "update", title: "Update ePay settings", singleton: true }),
  ];

  it("keeps Edit on its own, and puts everything that makes something new under Add", () => {
    const toolbar = recordToolbar(own, sections)!;
    expect(toolbar.edit?.title).toBe("Edit");
    expect(toolbar.add.map((entry) => [entry.id, entry.label, entry.separated ?? false])).toEqual([
      ["record-change-action-credits", "Credit", false],
      ["record-change-action-payments", "Payment (auto allocated)", false],
      // Where the record's own end and what lives under it begins.
      ["section-change-lease-charge-create", "Charge", true],
      ["section-change-lease-note-create", "Note", false],
    ]);
  });

  it("puts every other change in the other menu, deleting the record last", () => {
    const toolbar = recordToolbar(own, sections)!;
    expect(toolbar.more.map((entry) => [entry.label, entry.tone, entry.separated ?? false])).toEqual([
      ["Terminate a lease", "danger", false],
      ["Update ePay settings", "default", false],
      ["Delete", "danger", true],
    ]);
    // Each entry opens the very request a button used to.
    expect(toolbar.more[1]!.request).toMatchObject({ entity: "lease-epay", kind: "update", singleton: true });
  });

  it("is nothing at all when nothing can be changed", () => {
    expect(recordToolbar([], [])).toBeUndefined();
    expect(recordToolbar([], [{ section: { entity: "x" }, requests: [] }])).toBeUndefined();
  });

  it("drops only the verb an Add menu already says", () => {
    expect(addLabel("Create a payment reversal")).toBe("Payment reversal");
    expect(addLabel("Add an owner")).toBe("Owner");
    expect(addLabel("New recurring charge")).toBe("Recurring charge");
    expect(addLabel("Record a payment")).toBe("Record a payment");
    expect(addLabel("Create")).toBe("Create");
  });
});
