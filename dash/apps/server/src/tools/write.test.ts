import { describe, expect, it } from "vitest";
import { WRITE_TOOL, planWrite } from "./write.js";
import type { ToolBinding } from "./types.js";

/**
 * The verb that exists so a refusal can be accurate.
 *
 * Without it the model has two ways to be wrong and no way to be right: invent
 * a capability it does not have, or refuse in a way that sounds like a policy
 * when it is a fact about the connection. `opDefSchema.method` is
 * `z.literal("GET")` — read-only by construction — and saying *that* is what
 * turns a dead end into a decision somebody can make.
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

describe("planWrite", () => {
  it("never performs anything", () => {
    const plan = planWrite({
      binding: binding(),
      resource: "conversation",
      id: "77",
      changes: [{ field: "status", value: "closed" }],
    });
    expect(plan.performed).toBe(false);
    expect(plan.requests).toBe(0);
    expect(plan.records).toEqual([]);
  });

  it("names the record, the API and the fields it would have set", () => {
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
   * The distinction that makes the answer useful: this is not a permission
   * somebody can go and grant, it is what the connection can express at all.
   */
  it("gives the structural reason rather than sounding like a policy", () => {
    const plan = planWrite({ binding: binding(), resource: "conversation", id: "1", changes: [] });
    expect(plan.refusal).toBe("read-only-connection");
    expect(plan.note).toContain("by construction");
    expect(plan.note).toContain("nothing was sent");
    // Attributing it to the API would be wrong, and it is what the model did
    // when the note left room for it: Buildium is not read-only, this is.
    expect(plan.note).toContain("NOT of the API");
  });

  it("says when no fields were named at all", () => {
    const plan = planWrite({ binding: binding(), resource: "conversation", id: "1", changes: [] });
    expect(plan.note).toContain("no fields were named");
  });

  it("separates an unknown resource from a read-only connection", () => {
    const plan = planWrite({ binding: null, resource: "invoice", id: "1", changes: [] });
    expect(plan.refusal).toBe("unknown-resource");
    expect(plan.note).toContain("not a kind of record this workspace can address");
    expect(plan.target).toBeUndefined();
  });
});

describe("WRITE_TOOL", () => {
  it("tells the model to use the result rather than answer from memory", () => {
    expect(WRITE_TOOL.name).toBe("write_record");
    expect(WRITE_TOOL.description).toContain("rather than answering from memory");
    expect(WRITE_TOOL.description).toContain("never changes anything");
  });
});
