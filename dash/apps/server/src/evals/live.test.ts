import type { EmailAdapter } from "@freebirdai/core";
import { fakeLlm } from "@freebirdai/dash-agent";
import { scenarioSchema, type Task } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { agentOf, byHand, fake, node, owner, workflowOf } from "../workflows/testing.js";
import { calibrate, modelJudge, rubricKey, toneCheck, TONE_RUBRIC } from "./judge.js";
import { Redactor } from "./redact.js";
import { runScenario } from "./runner.js";
import { EvalService } from "./service.js";
import { MemoryEvalRunStore } from "./store.js";

/** Phase 3 of Dash Evals: the Tone judge and its calibration, saving a task as a scenario, the weekly summary. */

const sent = (id: string, text: string, fields: Partial<Task> = {}): Task =>
  ({
    id,
    action: "outreach.email",
    base: "outreach",
    title: "Email",
    status: "done",
    approvedBy: "local",
    body: { kind: "conversation", channel: "email", to: "dana@example.com", agent: "desk", sent: text },
    links: {},
    createdAt: "2026-11-01T00:00:00.000Z",
    ...fields,
  }) as Task;

describe("the Tone judge", () => {
  it("measures its agreement with the team: approved as proposed should pass, edited or declined should not", async () => {
    const tasks = [
      sent("a", "Hi Dana, see you Tuesday at 9."),
      sent("b", "See you Tuesday.", { edited: { by: "local", at: "2026-11-01T00:00:00.000Z", changes: [{ key: "wording", before: "WE WILL BE THERE WHENEVER.", after: "See you Tuesday." }] } }),
      sent("c", "Whatever.", { status: "dismissed", body: { kind: "notice", text: "" }, pending: { wording: "Whatever." } }),
    ];
    /* A judge that passes everything agrees on the one good message only. */
    const lenient = await calibrate(fakeLlm([{ args: { result: "pass", reason: "fine" } }]), TONE_RUBRIC, tasks, Date.parse("2026-11-05T00:00:00.000Z"));
    expect(lenient).toMatchObject({ rubric: rubricKey(TONE_RUBRIC), examples: 3 });
    expect(lenient.agreement).toBeCloseTo(1 / 3);
  });

  it("stays unsure until calibrated, then gives its verdict with how often it agrees", async () => {
    const llm = fakeLlm([{ args: { result: "fail", reason: "It promises a time the booking does not say." } }]);
    const uncalibrated = modelJudge(llm, async () => null);
    expect(await uncalibrated(toneCheck, [sent("a", "We'll be there at 7am sharp, guaranteed!")])).toMatchObject({ result: "unsure", note: expect.stringContaining("Not calibrated") });
    const weak = modelJudge(llm, async (rubric) => ({ rubric, agreement: 0.6, examples: 20, at: "x" }));
    expect((await weak(toneCheck, [sent("a", "x")])).note).toMatch(/60% of 20/);
    const trusted = modelJudge(llm, async (rubric) => ({ rubric, agreement: 0.9, examples: 20, at: "x" }));
    expect(await trusted(toneCheck, [sent("a", "We'll be there at 7am sharp, guaranteed!")])).toEqual({ result: "fail", note: "It promises a time the booking does not say. (This judge agrees with your team 90% of 20 times.)" });
  });

  it("never gates: a failing judge is a verdict beside the rules, and the rules still decide", async () => {
    const run = await runScenario(
      {
        id: "tone",
        name: "Tone",
        direction: "outbound",
        target: { workflow: "wf" },
        world: { provider: "property-maintenance", workspace: { workflows: [workflowOf({ trigger: { kind: "manual" }, nodes: [node("say", "outreach.email", { agentId: "desk", to: "dana@example.com", subject: "Hi", purpose: "Hi", content: "fixed", wording: "whatever" })] })] } },
        turns: [{ id: "go", kind: "start", payload: {} }],
        checks: [{ kind: "rule", id: "sent", dimension: "completion", expect: "some", expr: "true" }, toneCheck],
      },
      { judge: async () => ({ result: "fail", note: "rude" }) },
    );
    expect(run.verdicts.map((verdict) => [verdict.check, verdict.result])).toEqual([
      ["sent", "pass"],
      ["tone", "fail"],
    ]);
  });
});

describe("Redactor", () => {
  it("replaces people with stand-ins, the same one each time, and leaves dates and words alone", () => {
    const redact = new Redactor(["Dana Ruiz"]);
    const out = redact.value({
      from: { address: "Dana.Ruiz@Example.com", name: "Dana Ruiz" },
      text: "Hi, this is Dana Ruiz (512) 555-0142, card 4111111111111111. Reply to dana.ruiz@example.com before 2026-10-13T09:00:00.000Z. https://x.example/pay?token=abc123&x=1",
      phone: "+15125550142",
    });
    expect(out.from).toEqual({ address: "person1@example.com", name: "Person 1" });
    expect(out.text).toBe("Hi, this is Person 1 +15550100001, card 0000000000000000. Reply to person1@example.com before 2026-10-13T09:00:00.000Z. https://x.example/pay?token=REDACTED&x=1");
    expect(out.phone).toBe("+15550100002");
  });
});

describe("saving a task as a scenario", () => {
  it("keeps what started the case, redacts its people, and adds a check that a declined step never runs unattended again", async () => {
    const f = fake({ sender: true });
    f.agents.set("maint", agentOf());
    const workflow = workflowOf({
      trigger: { kind: "message_received", channels: ["email"] },
      trial: 2,
      nodes: [node("say", "outreach.email", { agentId: "maint", to: "{{ from.address }}", subject: "Re: {{ subject }}", purpose: "Answer", content: "fixed", wording: "Thanks!" }, { mode: "auto" })],
    });
    await f.env.store.put(workflow);
    const row = { mailbox: "inbox", id: "m1", from: { address: "lee.park@example.org", name: "Lee Park" }, subject: "Leak", text: "Lee Park here, call 512-555-0199.", channel: "email" };
    await f.engine.open(workflow, { id: "mr-1", row, start: { kind: "message", message: "inbox:m1" } });
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    const declined = await f.tasks.decline(owner, waiting!.id);
    const evals = new EvalService({ env: f.env, runs: new MemoryEvalRunStore() });
    const saved = scenarioSchema.parse(await evals.saveTask(declined.id));
    expect(saved.turns[0]).toMatchObject({ kind: "message", payload: { from: "person1@example.com", name: "Person 1", subject: "Leak", text: "Person 1 here, call +15550100001." } });
    expect(JSON.stringify(saved).match(/.{40}(lee|park|555-0199).{40}/gi)).toBeNull();
    expect(saved.checks.at(-1)).toMatchObject({ id: "not-again", expect: "none" });
    /* It is part of the workflow's pack now, and it passes: in trial the step still asks. */
    expect((await evals.pack("wf")).map((one) => one.id)).toContain(saved.id);
    expect((await runScenario(saved)).verdicts.filter((verdict) => verdict.result === "fail")).toEqual([]);
  });
});

describe("the weekly summary", () => {
  it("goes to the team once a week when it is on, with the week's tests, checks and approvals", async () => {
    const f = fake({ sender: true });
    f.agents.set("maint", agentOf());
    const outbox: Array<{ to: string; subject: string; text: string }> = [];
    const email = { send: async (message: { to: string; subject: string; text: string }) => void outbox.push(message) } as unknown as EmailAdapter;
    const runs = new MemoryEvalRunStore();
    const evals = new EvalService({ env: f.env, runs, report: { email: () => email, team: async () => ["ed@acme.test", ""], inbound: async () => ({ screened: 4, wouldHold: 1, held: 0 }) } });
    const workflow = workflowOf({ trigger: { kind: "manual" }, trial: 2, nodes: [node("say", "outreach.email", { agentId: "maint", to: "dana@example.com", subject: "Hi", purpose: "Hi", content: "fixed", wording: "Hello" }, { mode: "auto" })] });
    await f.env.store.put(workflow);
    await evals.test("wf");
    await byHand(f, workflow);
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    await f.tasks.approve(owner, waiting!.id);

    expect(await evals.sendWeekly()).toBe(0);
    await evals.putSettings({ weekly: { enabled: true } });
    expect(await evals.sendWeekly()).toBe(1);
    expect(outbox[0]).toMatchObject({ to: "ed@acme.test", subject: "Dash evals: the week" });
    expect(outbox[0]!.text).toContain("Tests run: 1.");
    expect(outbox[0]!.text).toContain("Work orders: completion");
    expect(outbox[0]!.text).toContain("1 approved as proposed");
    expect(outbox[0]!.text).toContain("Inbound screen: 4 screened, 1 a rule flagged, 0 held.");
    expect(await evals.sendWeekly()).toBe(0);
    f.clock.now += 7 * 86_400_000;
    expect(await evals.sendWeekly()).toBe(1);
  });
});
