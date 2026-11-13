import { scenarioSchema, verdictsByDimension, type ScenarioInput } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { node, workflowOf } from "../workflows/testing.js";
import { checkRule } from "./checks.js";
import { PACKS } from "./packs/index.js";
import { runScenario, ScenarioError } from "./runner.js";
import { Sandbox } from "./sandbox.js";
import { telnyxSandboxCarrier } from "./testing-carriers.js";

const confirm = (to: string) =>
  workflowOf({
    id: "confirm",
    name: "Confirm",
    trigger: { kind: "booking", events: ["confirmed"] },
    nodes: [node("say", "outreach.email", { agentId: "desk", to, subject: "Confirmed", purpose: "Confirm", content: "fixed", wording: "See you then." })],
  });

const scenario = (to: string): ScenarioInput => ({
  id: "confirm",
  name: "Confirm",
  direction: "outbound",
  target: { workflow: "confirm" },
  world: { provider: "property-maintenance", workspace: { workflows: [confirm(to)] } },
  turns: [{ id: "b", kind: "booking", payload: { event: "confirmed", row: { id: "b1", contact: { email: "dana@example.com" } } } }],
  checks: [{ kind: "rule", id: "right-person", dimension: "correctness", where: 'base == "outreach"', expr: 'body.to == "dana@example.com"' }],
});

describe("scenario packs", () => {
  for (const [pack, scenarios] of Object.entries(PACKS)) {
    for (const one of scenarios) {
      it(`${pack}: ${one.name} passes its rule checks`, async () => {
        const run = await runScenario(one);
        const failed = run.verdicts.filter((verdict) => verdict.result === "fail");
        expect(failed).toEqual([]);
        expect(run.verdicts.every((verdict) => verdict.result !== "unsure" || one.checks.find((check) => check.id === verdict.check)?.kind === "judge")).toBe(true);
      });
    }
  }
});

/* Dash Phone, Phase 4: the phone and call packs, unchanged, with the world's lines on Telnyx's simulator instead of the fake carrier. */
describe("scenario packs on Telnyx", () => {
  for (const pack of ["phone", "calls"] as const) {
    for (const one of PACKS[pack]!) {
      it(`${pack}: ${one.name} passes its rule checks on Telnyx`, async () => {
        const onFake = await runScenario(one);
        const onTelnyx = await runScenario(one, { phoneCarrier: telnyxSandboxCarrier });
        expect(onTelnyx.verdicts.filter((verdict) => verdict.result === "fail")).toEqual([]);
        expect(onTelnyx.verdicts.map((verdict) => [verdict.check, verdict.result])).toEqual(onFake.verdicts.map((verdict) => [verdict.check, verdict.result]));
      });
    }
  }
});

describe("runScenario", () => {
  it("fails a workflow that writes to the wrong person, and says it was not said", async () => {
    const run = await runScenario(scenario("someone@else.com"));
    expect(run.verdicts).toEqual([expect.objectContaining({ check: "right-person", result: "fail", said: false })]);
    expect(run.verdicts[0]!.evidence).toHaveLength(1);
    expect(verdictsByDimension(run.verdicts)).toEqual({ correctness: { pass: 0, fail: 0, silent: 1, unsure: 0 } });
  });

  it("counts a failure a person was asked about as said", async () => {
    const workflow = { ...confirm("someone@else.com"), trial: 2 };
    const run = await runScenario({ ...scenario(""), world: { provider: "empty", workspace: { workflows: [workflow] } }, checks: [{ kind: "rule", id: "auto", dimension: "friction", expect: "none", expr: 'status == "waiting_approval"' }] });
    expect(run.verdicts[0]).toMatchObject({ result: "fail", said: true });
  });

  it("logs every turn, task, snapshot and verdict in order, and plays the same way twice", async () => {
    const first = await runScenario(scenario("{{ contact.email }}"));
    const second = await runScenario(scenario("{{ contact.email }}"));
    expect(first).toEqual(second);
    expect(first.events.map((event) => event.seq)).toEqual(first.events.map((_, index) => index));
    const kinds = first.events.map((event) => event.kind);
    expect(kinds[0]).toBe("turn");
    expect(kinds).toContain("task");
    expect(kinds).toContain("snapshot");
    expect(kinds.filter((kind) => kind === "verdict")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("ended");
    expect(first.targetVersion).toBe(1);
  });

  it("plays only scripted scenarios for now, and refuses a target its world lacks", async () => {
    await expect(runScenario({ ...scenario("x"), persona: { id: "p", kind: "agent", goal: "Book", driver: "model" } })).rejects.toBeInstanceOf(ScenarioError);
    await expect(runScenario({ ...scenario("x"), target: { workflow: "nope" } })).rejects.toThrow(/does not have/);
  });
});

describe("scenarioSchema", () => {
  it("refuses a check that does not parse, and a turn that follows one after it", () => {
    expect(scenarioSchema.safeParse({ ...scenario("x"), checks: [{ kind: "rule", id: "c", dimension: "completion", expr: "status ==" }] }).success).toBe(false);
    const turns = [
      { id: "a", kind: "clock", payload: { ms: 1 }, after: "b" },
      { id: "b", kind: "clock", payload: { ms: 1 } },
    ];
    expect(scenarioSchema.safeParse({ ...scenario("x"), turns }).success).toBe(false);
  });
});

describe("checkRule", () => {
  const task = (id: string, status: string) => ({ id, action: "create.note", base: "create", title: "t", status, body: { kind: "notice", text: "" }, links: {}, createdAt: "2026-10-06T12:00:00.000Z" }) as never;

  it("fails `all` with nothing to check, and `one` when two match", () => {
    expect(checkRule({ kind: "rule", id: "c", dimension: "completion", expect: "all", expr: "true" }, [], 0)).toMatchObject({ result: "fail", note: "No task was there to check." });
    expect(checkRule({ kind: "rule", id: "c", dimension: "completion", expect: "one", expr: 'status == "done"' }, [task("a", "done"), task("b", "done")], 0)).toMatchObject({ result: "fail", evidence: ["a", "b"] });
  });
});

describe("Sandbox", () => {
  it("restores a snapshot, clock and model included, and plays the next turn the same way again", async () => {
    const workflow = workflowOf({
      id: "confirm",
      name: "Confirm",
      trigger: { kind: "booking", events: ["confirmed"] },
      nodes: [node("say", "outreach.email", { agentId: "desk", to: "{{ contact.email }}", subject: "Hi", purpose: "Confirm" })],
    });
    const sandbox = await Sandbox.start({ world: { provider: "property-maintenance", workspace: { agents: [], workflows: [workflow], records: [] } }, model: [{ text: "First." }, { text: "Second." }] });
    const booking = (id: string) => ({ id, kind: "booking" as const, payload: { event: "confirmed", row: { id, contact: { email: `${id}@example.com` } } } });
    await sandbox.step({ id: "clock", kind: "clock", payload: { ms: 60_000 } });
    const saved = sandbox.snapshot();
    const clock = sandbox.now;
    await sandbox.step(booking("one"));
    const before = await sandbox.tasks();
    expect(sandbox.intents.sent.map((one) => one.text)).toEqual(["First."]);
    expect(sandbox.restore(saved)).toMatchObject({ status: "paused", clock });
    expect(await sandbox.tasks()).toEqual([]);
    expect(sandbox.intents.sent).toEqual([]);
    await sandbox.step(booking("one"));
    expect(await sandbox.tasks()).toEqual(before);
    expect(sandbox.intents.sent.map((one) => one.text)).toEqual(["First."]);
    expect(sandbox.stop().status).toBe("ended");
    await expect(sandbox.step(booking("two"))).rejects.toThrow(/ended/);
  });
});
