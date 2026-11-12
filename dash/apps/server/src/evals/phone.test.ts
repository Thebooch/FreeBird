import { describe, expect, it } from "vitest";
import { agentOf, node, owner, workflowOf } from "../workflows/testing.js";
import { Sandbox } from "./sandbox.js";

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

const start = (options: { failures?: { to: string; errorCode?: string }[]; workflows?: unknown[] } = {}) =>
  Sandbox.start({
    world: {
      provider: "empty",
      workspace: {
        agents: [desk],
        workflows: (options.workflows ?? [remind, answer]) as never,
        phone: { lines: [{ id: "desk-line", number: LINE, owner: { kind: "agent", id: "desk" } }], failures: options.failures ?? [] },
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

  it("carries a STOP reply in, as a text like any other, and a text needs phone lines", async () => {
    const sandbox = await start({ workflows: [answer] });
    await sandbox.step({ id: "t1", kind: "message", payload: { channel: "text", from: CUSTOMER, stop: true } });
    const [task] = await sandbox.tasks();
    expect(task).toBeDefined();
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
});
