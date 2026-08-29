import { describe, expect, it } from "vitest";
import { readRoster } from "./roster.js";
import type { ToolBinding } from "./types.js";

/**
 * The line the assistant reads before deciding whether a field is unavailable.
 *
 * Paid for on every turn, so it stays one line per resource — the lesson
 * already learnt here is that tool descriptions are prompt tokens.
 */

const binding = (over: Partial<ToolBinding> = {}): ToolBinding => ({
  verb: "read",
  id: "conversation",
  connection: "helpdesk",
  connectionTitle: "Helpdesk",
  resource: "conversation",
  title: "Conversation",
  op: "tickets.get",
  describes: "Support threads",
  idParam: "ref",
  idField: "reference",
  listOp: "tickets.list",
  ...over,
});

describe("readRoster", () => {
  it("names each record, what identifies it, and which API it is on", () => {
    const roster = readRoster([binding()]);
    expect(roster).toContain("Helpdesk:");
    expect(roster).toContain("conversation (identified by reference)");
    expect(roster).toContain("Support threads");
  });

  it("groups by connection, so a cross-source question can tell them apart", () => {
    const roster = readRoster([
      binding(),
      binding({ id: "job", connectionTitle: "Field Ops", connection: "field-ops" }),
    ]);
    expect(roster.indexOf("Helpdesk:")).toBeGreaterThanOrEqual(0);
    expect(roster.indexOf("Field Ops:")).toBeGreaterThanOrEqual(0);
  });

  it("keeps to one line per record", () => {
    const roster = readRoster([binding(), binding({ id: "b" }), binding({ id: "c" })]);
    const entries = roster.split("\n").filter((line) => line.startsWith("    "));
    expect(entries).toHaveLength(3);
  });

  /*
   * The honest empty case. An assistant told it can open records, on an API
   * that exposes none, would promise a lookup it cannot perform.
   */
  it("says plainly when nothing can be opened", () => {
    const roster = readRoster([]);
    expect(roster).toContain("none");
    expect(roster).toContain("Say that rather than implying");
  });

  /*
   * An API's description of a collection is often a paragraph with its
   * permission requirements appended. Forty of those is a prompt cost paid on
   * every single turn, for far more than is needed to pick the right noun.
   */
  it("keeps a long API description to its first sentence", () => {
    const roster = readRoster([
      binding({
        describes:
          "Retrieves a list of all task types. Note, the response payload only contains " +
          "fields common across all of the request types. Required permission(s):Tasks - View",
      }),
    ]);
    expect(roster).toContain("Retrieves a list of all task types.");
    expect(roster).not.toContain("Required permission");
  });

  it("truncates a single sentence that is a paragraph on its own", () => {
    const roster = readRoster([binding({ describes: "x".repeat(300) })]);
    const line = roster.split("\n").find((entry) => entry.includes("conversation"));
    expect(line?.length).toBeLessThan(160);
  });
});
