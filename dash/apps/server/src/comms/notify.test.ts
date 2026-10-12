import type { EmailAdapter } from "@freebirdai/core";
import { commsSettingsSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { emailHighlightNotifier, emailTeamNotifier, type NoticeDeps } from "./notify.js";
import { MemoryCommsStore } from "./store.js";

const setUp = async (over: { noticesTo?: string; email?: boolean; team?: string[] } = {}) => {
  const sent: { to: string; subject: string }[] = [];
  const email = { send: async (message: { to: string; subject: string }) => void sent.push({ to: message.to, subject: message.subject }) } as unknown as EmailAdapter;
  const store = new MemoryCommsStore();
  await store.putSettings(commsSettingsSchema.parse(over.noticesTo ? { noticesTo: over.noticesTo } : {}));
  const deps: NoticeDeps = {
    email: () => (over.email === false ? null : email),
    settings: () => store.settings(),
    claim: (key, at) => store.claimNotice(key, at),
    release: (key) => store.releaseNotice(key),
    team: async () => (over.team ?? []).map((address) => ({ email: address })),
    now: () => Date.UTC(2026, 9, 11),
  };
  return { sent, deps };
};

const notice = (email: string, key = "k1") => ({
  kind: "approval_request" as const,
  member: { id: "m1", email, name: "Sam" },
  subject: "Approve a booking",
  html: "<p>Approve</p>",
  text: "Approve",
  key,
});

describe("team notices by email", () => {
  it("goes to the member's own email, once per key", async () => {
    const { sent, deps } = await setUp();
    const notifier = emailTeamNotifier(deps);
    expect(await notifier.notify(notice("sam@example.com"))).toEqual({ status: "sent" });
    await notifier.notify(notice("sam@example.com"));
    expect(sent).toEqual([{ to: "sam@example.com", subject: "Approve a booking" }]);
  });

  it("goes to the notices address for a member with no email, and says so when there is none", async () => {
    const without = await setUp();
    expect((await emailTeamNotifier(without.deps).notify(notice(""))).status).toBe("not_sent");
    const withAddress = await setUp({ noticesTo: "office@example.com" });
    await emailTeamNotifier(withAddress.deps).notify(notice(""));
    expect(withAddress.sent.map((one) => one.to)).toEqual(["office@example.com"]);
  });

  it("sends nothing without system email, and can send later", async () => {
    const { deps } = await setUp({ email: false });
    expect((await emailTeamNotifier(deps).notify(notice("sam@example.com"))).status).toBe("not_sent");
  });

  it("tells every member about a highlight", async () => {
    const { sent, deps } = await setUp({ team: ["a@example.com", "b@example.com"] });
    await emailHighlightNotifier(deps).notify({ agent: { id: "leasing", name: "Leasing", color: 3 }, matches: [{ highlight: "h1", title: "Legal threat", reason: "They mention a lawyer." }], conversation: "gmail:g1", message: "I will call my lawyer." });
    expect(sent.map((one) => one.to)).toEqual(["a@example.com", "b@example.com"]);
    expect(sent[0]?.subject).toBe("Leasing flagged a message: Legal threat");
  });
});
