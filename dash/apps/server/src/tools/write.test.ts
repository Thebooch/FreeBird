import { describe, expect, it } from "vitest";
import { WRITE_TOOL, planWrite, type WriteOffer } from "./write.js";
import type { ToolBinding } from "./types.js";

/**
 * The verb that exists so an answer about changing a record can be accurate.
 *
 * Without it the model has two ways to be wrong: invent a capability it does
 * not have, or refuse in a way that sounds like a policy when it is a fact
 * about the connection. It describes; `change_record` proposes; a person
 * approves. It never sends anything itself.
 */

const binding = (over: Partial<ToolBinding> = {}): ToolBinding => ({
  verb: "read",
  id: "conversation",
  connection: "helpdesk",
  connectionTitle: "Helpdesk",
  resource: "conversation",
  title: "Conversation",
  op: "tickets.get",
  describes: "",
  idParam: "ref",
  idField: "reference",
  ...over,
});

const OFFER: WriteOffer = {
  connection: "helpdesk",
  entity: "conversation",
  entityName: "Conversation",
  allowed: true,
  parents: [],
  singleton: false,
  changes: [
    {
      kind: "update",
      title: "Update a conversation",
      fields: [{ field: "status", label: "Status", type: "string", required: false, options: ["open", "closed"] }],
    },
    { kind: "delete", title: "Delete a conversation", danger: true, fields: [] },
  ],
};

describe("planWrite", () => {
  it("never performs anything, whatever the answer", () => {
    for (const offer of [undefined, { ...OFFER, allowed: false }, OFFER]) {
      const plan = planWrite({
        binding: binding(),
        resource: "conversation",
        id: "77",
        changes: [{ field: "status", value: "closed" }],
        offer,
      });
      expect(plan.performed).toBe(false);
      expect(plan.requests).toBe(0);
      expect(plan.records).toEqual([]);
    }
  });

  it("names the record, the API and the fields it would set", () => {
    const plan = planWrite({
      binding: binding(),
      resource: "conversation",
      id: "77",
      changes: [
        { field: "status", value: "closed" },
        { field: "owner", value: "sam" },
      ],
    });
    expect(plan.target).toEqual({
      resource: "conversation",
      connection: "Helpdesk",
      id: "77",
      fields: ["status", "owner"],
    });
    expect(plan.note).toContain("conversation 77 on Helpdesk");
    expect(plan.note).toContain("status, owner");
  });

  /*
   * The distinction that makes the answer useful: a connection that describes
   * no such endpoint is a fact about it, not a permission somebody can grant.
   */
  it("says when the connection describes no way to do it, without sounding like a policy", () => {
    const plan = planWrite({ binding: binding(), resource: "conversation", id: "1", changes: [] });
    expect(plan.refusal).toBe("not-offered");
    expect(plan.note).toContain("nothing was sent".replace(/^n/, "N"));
    expect(plan.note).toContain("NOT a permission");
    expect(plan.note).toContain("Read write endpoints");
  });

  it("says who decides when the API can but the person asking may not", () => {
    const plan = planWrite({
      binding: binding(),
      resource: "conversation",
      id: "1",
      changes: [],
      offer: { ...OFFER, allowed: false },
    });
    expect(plan.refusal).toBe("not-allowed");
    expect(plan.note).toContain("whoever manages this workspace decides");
    expect(plan.offered?.changes).toHaveLength(2);
  });

  it("says how to propose it for approval when it can be done", () => {
    const plan = planWrite({
      binding: binding(),
      resource: "conversation",
      id: "1",
      changes: [{ field: "status", value: "closed" }],
      offer: OFFER,
    });
    expect(plan.refusal).toBeUndefined();
    expect(plan.offered?.changes[0]?.fields[0]).toMatchObject({ field: "status", options: ["open", "closed"] });
    // The call itself, ready to make: instructions alone got described rather than made.
    expect(plan.next).toEqual({
      tool: "change_record",
      args: {
        connection: "helpdesk",
        entity: "conversation",
        kind: "update",
        id: "1",
        values: [{ field: "status", value: "closed" }],
      },
    });
    expect(plan.note).toContain("Call change_record NOW");
    expect(plan.note).toContain("no card is showing");
  });

  /*
   * The engine quotes only the first six hundred characters of a tool's result
   * back to the model; instructions after a long field listing never arrive.
   */
  it("leads with the note and the next call, whatever else it carries", () => {
    for (const offer of [undefined, { ...OFFER, allowed: false }, OFFER]) {
      const plan = planWrite({ binding: binding(), resource: "conversation", id: "1", changes: [{ field: "status", value: "closed" }], offer });
      const keys = Object.keys(plan);
      expect(keys[0]).toBe("note");
      if (plan.next) expect(keys[1]).toBe("next");
      expect(JSON.stringify(plan).slice(0, 600)).toContain(JSON.stringify(plan.note).slice(1, 150));
    }
  });

  it("says when no fields were named at all", () => {
    const plan = planWrite({ binding: binding(), resource: "conversation", id: "1", changes: [] });
    expect(plan.note).toContain("no fields were named");
  });

  it("separates an unknown resource from everything else", () => {
    const plan = planWrite({ binding: null, resource: "invoice", id: "1", changes: [] });
    expect(plan.refusal).toBe("unknown-resource");
    expect(plan.note).toContain("not a kind of record this workspace can address");
    expect(plan.target).toBeUndefined();
  });
});

describe("WRITE_TOOL", () => {
  it("is named and described as a question, so a request to change is not answered with it", () => {
    expect(WRITE_TOOL.name).toBe("can_change_record");
    expect(WRITE_TOOL.description).toContain("ONLY for questions");
    expect(WRITE_TOOL.description).toContain("NEVER proposes or changes anything");
    expect(WRITE_TOOL.description).toContain("start the change_record action");
  });
});
