import type { MailboxView, MailMessage } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { areaGroups, filterShown, ticked, toggle } from "./model.js";

const box = (id: string, owner: MailboxView["owner"]): MailboxView => ({ id, title: id, provider: "gmail", owner, status: "ready", kept: 0 });
const message = (id: string, from: string, subject: string, extra: Partial<MailMessage> = {}): MailMessage => ({
  id,
  threadId: id,
  mailbox: "m",
  from: { address: from },
  to: [],
  cc: [],
  subject,
  snippet: "",
  at: "2026-10-10T12:00:00.000Z",
  unread: false,
  sent: false,
  labels: [],
  hasAttachments: false,
  ...extra,
});

describe("areaGroups", () => {
  it("puts the team's mailboxes in Your comms and each agent's in its own area", () => {
    const groups = areaGroups(
      [box("a", { kind: "team" }), box("b", { kind: "agent", id: "z" }), box("c", { kind: "agent", id: "y" }), box("d", { kind: "agent", id: "z" })],
      [{ id: "z", name: "Zed", color: 2 }, { id: "y", name: "Ann", color: 5 }],
    );
    expect(groups.team.mailboxes.map((one) => one.id)).toEqual(["a"]);
    expect(groups.agents.map((one) => [one.key, one.label, one.mailboxes.map((m) => m.id)])).toEqual([
      ["agent:y", "Ann", ["c"]],
      ["agent:z", "Zed", ["b", "d"]],
    ]);
  });
});

describe("selection", () => {
  const group = areaGroups([box("a", { kind: "team" }), box("b", { kind: "team" })], []).team;
  it("is every mailbox until some are ticked, and forgets ones that are gone", () => {
    expect(ticked(group, undefined)).toEqual(["a", "b"]);
    expect(ticked(group, ["b", "gone"])).toEqual(["b"]);
    expect(ticked(group, ["gone"])).toEqual(["a", "b"]);
  });
  it("never unticks the last one", () => {
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
    expect(toggle(["b"], "b")).toEqual(["b"]);
    expect(toggle(["b"], "a")).toEqual(["b", "a"]);
  });
});

describe("filterShown", () => {
  it("filters what shows by words, sender and flags", () => {
    const shown = [message("1", "pat@example.com", "Leak in 4B", { unread: true }), message("2", "sam@example.net", "Showing")];
    expect(filterShown(shown, "leak").map((one) => one.id)).toEqual(["1"]);
    expect(filterShown(shown, "from:sam").map((one) => one.id)).toEqual(["2"]);
    expect(filterShown(shown, "is:unread").map((one) => one.id)).toEqual(["1"]);
    expect(filterShown(shown, "").map((one) => one.id)).toEqual(["1", "2"]);
  });
});
