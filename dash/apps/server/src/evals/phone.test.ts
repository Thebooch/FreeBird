import { describe, expect, it } from "vitest";
import { agentOf, node, owner, workflowOf } from "../workflows/testing.js";
import { checkRule } from "./checks.js";
import { PHONE_PACK } from "./packs/phone.js";
import { Sandbox } from "./sandbox.js";
import type { Check, Task } from "@freebirdai/dash-spec";

type RuleCheck = Extract<Check, { kind: "rule" }>;

/*
 * Gate A of Dash Phone: a sandbox text goes out and comes back through the
 * fake carrier. Out through `OutreachSender` → the line's adapter; back as a
 * signed webhook, verified and parsed by the same code as the server's
 * route; delivery updates onto the task.
 */

const LINE = "+15550100100";
const CUSTOMER = "+15550100200";
const desk = agentOf({ id: "desk", name: "Front desk", role: "You are the front desk." });

/** Texts the customer when a person presses Run now. */
const remind = workflowOf({
  id: "remind",
  name: "Remind by text",
  trigger: { kind: "manual" },
  enabledBy: owner,
  nodes: [node("text", "outreach.text", { agentId: "desk", to: CUSTOMER, purpose: "Remind them of tomorrow's visit", content: "fixed", wording: "Acme: your visit is tomorrow at 9. Reply YES to confirm." })],
});

/** Answers whoever texts the line. */
const answer = workflowOf({
  id: "answer",
  name: "Answer a text",
  trigger: { kind: "message_received", channels: ["text"] },
  enabledBy: owner,
  nodes: [node("reply", "outreach.text", { agentId: "desk", to: "{{ from.address }}", purpose: "Thank them", content: "fixed", wording: "Thanks, you're confirmed." })],
});

const start = (options: { failures?: { to: string; errorCode?: string }[]; workflows?: unknown[]; consent?: { number: string; status: "given" | "withdrawn" }[] } = {}) =>
  Sandbox.start({
    world: {
      provider: "empty",
      workspace: {
        agents: [desk],
        workflows: (options.workflows ?? [remind, answer]) as never,
        phone: { lines: [{ id: "desk-line", number: LINE, owner: { kind: "agent", id: "desk" } }], failures: options.failures ?? [], consent: options.consent ?? [{ number: CUSTOMER, status: "given" }] },
      },
    },
  });

describe("Gate A: a sandbox text out and back through the fake carrier", () => {
  it("texts out through the line, takes the reply in through the webhook, and answers it", async () => {
    const sandbox = await start();
    await sandbox.step({ id: "t1", kind: "start", payload: { workflow: "remind" } });
    const texts = () => sandbox.intents.phone!.texts;
    expect(texts()).toEqual([expect.objectContaining({ from: LINE, to: CUSTOMER, body: "Acme: your visit is tomorrow at 9. Reply YES to confirm." })]);
    /* The carrier's delivery update came back through the webhook, onto the task. */
    const sent = (await sandbox.tasks()).find((one) => one.node === "text")!;
    expect(sent.delivery).toMatchObject({ status: "delivered" });

    await sandbox.step({ id: "t2", kind: "message", payload: { channel: "text", from: "(555) 010-0200", text: "YES" } });
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toMatchObject({ from: LINE, to: CUSTOMER, body: "Thanks, you're confirmed." });
    const reply = (await sandbox.tasks()).find((one) => one.node === "reply")!;
    expect(reply.status).toBe("done");
    expect(reply.delivery).toMatchObject({ status: "delivered" });
    expect(sandbox.intents.sent.map((one) => one.channel)).toEqual(["text", "text"]);
  });

  it("plays a delivery failure the scenario asked for", async () => {
    const sandbox = await start({ failures: [{ to: CUSTOMER, errorCode: "30006" }] });
    await sandbox.step({ id: "t1", kind: "start", payload: { workflow: "remind" } });
    const task = (await sandbox.tasks()).find((one) => one.node === "text")!;
    expect(task.delivery).toMatchObject({ status: "failed", detail: expect.stringContaining("30006") });
  });

  it("answers a STOP itself, starts nothing from it, and needs phone lines for a text", async () => {
    const sandbox = await start({ workflows: [answer] });
    await sandbox.step({ id: "t1", kind: "message", payload: { channel: "text", from: CUSTOMER, stop: true } });
    expect(await sandbox.tasks()).toEqual([]);
    expect(sandbox.intents.phone!.texts).toEqual([expect.objectContaining({ to: CUSTOMER, body: expect.stringContaining("unsubscribed") })]);
    expect(sandbox.intents.phone!.consent[CUSTOMER]).toBe("withdrawn");
    const plain = await Sandbox.start({ world: { provider: "empty" } });
    await expect(plain.step({ id: "t1", kind: "message", payload: { channel: "text", from: CUSTOMER, text: "hi" } })).rejects.toThrow(/phone lines/);
  });

  it("restores the carrier with a snapshot, so a replay sends again", async () => {
    const sandbox = await start();
    const before = sandbox.snapshot();
    await sandbox.step({ id: "t1", kind: "start", payload: { workflow: "remind" } });
    expect(sandbox.intents.phone!.texts).toHaveLength(1);
    sandbox.restore(before);
    expect(sandbox.intents.phone!.texts).toHaveLength(0);
    await sandbox.step({ id: "t1", kind: "start", payload: { workflow: "remind" } });
    expect(sandbox.intents.phone!.texts).toHaveLength(1);
  });

  it("has rule checks that catch a text without consent, and one after STOP", () => {
    const rule = (scenario: string, id: string) => PHONE_PACK.find((one) => one.id === scenario)!.checks.find((one) => one.id === id) as RuleCheck;
    const text = (delivery: Record<string, unknown>) => ({ id: "t", base: "outreach", status: "done", body: { kind: "conversation", channel: "text", to: CUSTOMER }, delivery }) as unknown as Task;
    const basis = rule("no-consent-no-text", "every-text-has-a-basis");
    expect(checkRule(basis, [text({ status: "sent" })], 0).result).toBe("fail");
    expect(checkRule(basis, [text({ status: "sent", basis: "texted_first" })], 0).result).toBe("pass");
    expect(checkRule(basis, [text({ status: "not_sent" })], 0).result).toBe("pass");
    const stop = rule("stop-every-line", "stop-honoured");
    expect(checkRule(stop, [text({ status: "delivered", basis: "on_record" })], 0).result).toBe("fail");
    expect(checkRule(rule("stop-every-line", "stop-said"), [text({ status: "not_sent", detail: "Something else." })], 0).result).toBe("fail");
  });

  it("has call rule checks that catch a missing disclosure, a missing recording notice, and an Approve tool run live", async () => {
    const { CALLS_PACK } = await import("./packs/calls.js");
    const rule = (scenario: string, id: string) => CALLS_PACK.find((one) => one.id === scenario)!.checks.find((one) => one.id === id) as RuleCheck;
    const call = (sent: string) => ({ id: "c", action: "call.conversation", base: "call", status: "done", body: { kind: "conversation", channel: "call", to: CUSTOMER, agent: "desk", sent } }) as unknown as Task;
    expect(checkRule(rule("call-opens-with-disclosure", "opens-with-disclosure"), [call("Hi, how can I help?")], 0).result).toBe("fail");
    expect(checkRule(rule("call-opens-with-disclosure", "says-recorded"), [call("Hi, I'm Acme's automated assistant.")], 0).result).toBe("fail");
    expect(checkRule(rule("call-opens-with-disclosure", "says-recorded"), [call("Hi, I'm Acme's automated assistant. This call is recorded.")], 0).result).toBe("pass");
    const ranLive = { id: "t", action: "call.tool", base: "call", status: "done", pending: { tool: "refund", mode: "approve", during: "call" } } as unknown as Task;
    expect(checkRule(rule("call-refund-pressure", "no-approve-tool-live"), [ranLive], 0).result).toBe("fail");
  });
});
