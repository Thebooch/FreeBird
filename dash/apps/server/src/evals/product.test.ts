import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore, KeyStore, LocalAesVault, MemoryJournal } from "@freebirdai/connect/host";
import { chainEdges, taskLabel, type RunEvent } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { WorkflowService } from "../workflows/service.js";
import { TaskError } from "../workflows/tasks.js";
import { agentOf, byHand, fake, node, owner, workflowOf } from "../workflows/testing.js";
import { EvalService } from "./service.js";
import { MemoryEvalRunStore } from "./store.js";

/** Phase 1 of Dash Evals: approval edits, verdicts on live tasks, test sessions, and leaving trial on evidence. */

const email = (extra: Record<string, unknown> = {}) =>
  node("say", "outreach.email", { agentId: "maint", to: "dana@example.com", subject: "Hi", purpose: "Say hi", content: "fixed", wording: "Hello" }, { mode: "auto", ...extra });

const setup = (options: { graduation?: boolean } = {}) => {
  const f = fake({ sender: true, ...options });
  f.agents.set("maint", agentOf());
  const runs = new MemoryEvalRunStore();
  const evals = new EvalService({ env: f.env, runs, cleanCases: 2 });
  return { f, runs, evals };
};

describe("approving after editing", () => {
  it("runs with the changed settings, records what changed, and labels it partly wrong", async () => {
    const { f } = setup();
    const workflow = workflowOf({ trigger: { kind: "manual" }, trial: 3, nodes: [email()] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    const { task } = await f.tasks.approve(owner, waiting!.id, { edits: { wording: "Hello, Dana" } });
    expect(f.sent.map((one) => one.text)).toEqual(["Hello, Dana"]);
    expect(task.edited).toMatchObject({ by: owner.userId, changes: [{ key: "wording", before: "Hello", after: "Hello, Dana" }] });
    expect(taskLabel(task)).toBe("partly_wrong");
  });

  it("labels an approval as proposed good, and refuses a setting the step does not have", async () => {
    const { f } = setup();
    const workflow = workflowOf({ trigger: { kind: "manual" }, trial: 3, nodes: [email()] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    await byHand(f, workflow);
    const [one, two] = await f.env.tasks.list({ status: "waiting_approval" });
    await expect(f.tasks.approve(owner, one!.id, { edits: { colour: "red" } })).rejects.toBeInstanceOf(TaskError);
    expect(taskLabel((await f.tasks.approve(owner, one!.id, { edits: { wording: "Hello" } })).task)).toBe("good");
    expect(taskLabel(await f.tasks.decline(owner, two!.id))).toBe("wrong");
  });
});

describe("verdicts on live tasks", () => {
  it("scores a finished task with the workflow's standing checks", async () => {
    const { f } = setup();
    const checks = [
      { kind: "rule", id: "to-dana", dimension: "correctness", where: 'base == "outreach"', expect: "all", expr: 'body.to == "dana@example.com"' },
      { kind: "rule", id: "some-run", dimension: "completion", expect: "some", expr: "true" },
    ];
    const workflow = workflowOf({ trigger: { kind: "manual" }, checks, nodes: [email({ settings: { agentId: "maint", to: "sam@example.com", subject: "Hi", purpose: "Say hi", content: "fixed", wording: "Hello" } })] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    const [task] = await f.env.tasks.list();
    /* `some` speaks about a whole run, so only the `all` rule scores one task. */
    expect(task?.eval).toEqual([expect.objectContaining({ check: "to-dana", result: "fail", said: false })]);
  });

  it("puts a graduated step back on Approve when its task fails a check, and says why", async () => {
    const { f } = setup({ graduation: true });
    const checks = [{ kind: "rule", id: "to-dana", dimension: "correctness", where: 'base == "outreach"', expect: "all", expr: 'body.to == "dana@example.com"' }];
    const wrong = email({ settings: { agentId: "maint", to: "sam@example.com", subject: "Hi", purpose: "Say hi", content: "fixed", wording: "Hello" }, graduated: { at: "2026-10-01T00:00:00.000Z", by: "local" } });
    const workflow = workflowOf({ trigger: { kind: "manual" }, trial: 3, checks, nodes: [wrong] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    /* Graduated: it ran in trial without asking. */
    expect(f.sent).toHaveLength(1);
    const after = await f.env.store.get("wf");
    expect(after?.nodes[0]).toMatchObject({ mode: "approve", demoted: { reason: expect.stringContaining("to-dana") } });
    expect(after?.nodes[0]?.graduated).toBeUndefined();
  });
});

describe("test sessions", () => {
  it("plays a workflow's pack turn by turn, streams its events, and keeps the run", async () => {
    const { f, evals, runs } = setup();
    const workflow = workflowOf({ trigger: { kind: "manual" }, trial: 3, nodes: [email()] });
    await f.env.store.put(workflow);
    const started = await evals.start(owner, "wf");
    expect(started.turns).toBe(1);
    const seen: RunEvent[] = [];
    const stop = evals.watch(started.id, 0, (event) => seen.push(event));
    const first = await evals.step(started.id);
    expect(first.remaining).toBe(0);
    expect(first.events.map((event) => event.kind)).toContain("task");
    const last = await evals.step(started.id);
    stop();
    expect(last.run?.verdicts.filter((verdict) => verdict.result === "fail")).toEqual([]);
    expect(last.run?.verdicts.map((verdict) => verdict.check)).toEqual(["did-something", "no-failed-step", "asks-in-trial"]);
    expect(seen.at(-1)?.kind).toBe("ended");
    expect(await runs.list({ workflow: "wf" })).toHaveLength(1);
    /* Nothing in the workspace moved: the test played in its own sandbox. */
    expect(f.sent).toEqual([]);
    expect(await f.env.tasks.list()).toEqual([]);
    await expect(evals.step(started.id)).rejects.toThrow(/ended/);
  });
});

describe("leaving trial on evidence", () => {
  it("proposes Auto once the scenarios pass and enough trial cases were approved as proposed, and runs it in trial after", async () => {
    const { f, evals } = setup({ graduation: true });
    const workflow = workflowOf({ trigger: { kind: "manual" }, trial: 3, nodes: [email()] });
    await f.env.store.put(workflow);
    expect((await evals.graduation("wf")).steps[0]).toMatchObject({ ready: false, scenarios: "none", clean: 0, needed: 2 });
    await evals.test("wf");
    for (let i = 0; i < 2; i++) {
      await byHand(f, (await f.env.store.get("wf"))!);
      const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
      await f.tasks.approve(owner, waiting!.id);
    }
    /* The count does not go down: trial ends step by step. */
    expect((await f.env.store.get("wf"))?.trial).toBe(3);
    const step = (await evals.graduation("wf")).steps[0];
    expect(step).toMatchObject({ ready: true, scenarios: "pass", clean: 2, blockers: [] });
    const graduated = await evals.graduate(owner, "wf", "say");
    expect(graduated.nodes[0]).toMatchObject({ mode: "auto", graduated: { by: owner.userId } });
    /* Its only outside step graduated: nothing is left to ask in trial. */
    expect(graduated.trial).toBe(0);
    await byHand(f, graduated);
    expect(f.sent).toHaveLength(3);
  });

  it("names what stops a step, and refuses to graduate it", async () => {
    const { f, evals } = setup({ graduation: true });
    const workflow = workflowOf({ trigger: { kind: "manual" }, trial: 3, nodes: [email()] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    await f.tasks.approve(owner, waiting!.id, { edits: { wording: "Changed" } });
    const step = (await evals.graduation("wf")).steps[0]!;
    expect(step.blockers.join(" ")).toMatch(/not run.*0 of 2 trial cases/);
    await expect(evals.graduate(owner, "wf", "say")).rejects.toThrow(/not ready/);
  });

  it("keeps a step's graduation through a save, and drops it when the step changes", async () => {
    const { f } = setup({ graduation: true });
    const service = new WorkflowService({ store: f.env.store, policy: { can: () => ({ ok: true }) }, agents: { list: async () => [agentOf()] }, hasConnection: () => true });
    const made = await service.create(owner, { name: "Hi", trigger: { kind: "manual" }, trial: 3, nodes: [email()], edges: chainEdges([{ id: "say" }]) } as never);
    await f.env.store.put({ ...made, nodes: made.nodes.map((one) => ({ ...one, graduated: { at: "2026-10-01T00:00:00.000Z", by: "local" } })) });
    /* A save from an editor opened before it graduated, and one that tries to graduate a step itself, change nothing. */
    const stale = await service.update(owner, made.id, { name: "Hi again", trigger: { kind: "manual" }, trial: 3, nodes: [email()], edges: made.edges } as never);
    expect(stale.nodes[0]?.graduated).toMatchObject({ by: "local" });
    const reworded = await service.update(owner, made.id, { name: "Hi again", trigger: { kind: "manual" }, trial: 3, nodes: [email({ settings: { agentId: "maint", to: "dana@example.com", subject: "Hi", purpose: "Say hi", content: "fixed", wording: "Hey" } })], edges: made.edges } as never);
    expect(reworded.nodes[0]?.graduated).toBeUndefined();
    const forged = await service.update(owner, made.id, { name: "Hi again", trigger: { kind: "manual" }, trial: 3, nodes: [{ ...reworded.nodes[0]!, graduated: { at: "2026-10-01T00:00:00.000Z", by: "me" } }], edges: made.edges } as never);
    expect(forged.nodes[0]?.graduated).toBeUndefined();
  });

  it("is off unless the server turns it on", async () => {
    const { f, evals } = setup();
    await f.env.store.put(workflowOf({ trigger: { kind: "manual" }, trial: 3, nodes: [email()] }));
    expect((await evals.graduation("wf")).enabled).toBe(false);
    await expect(evals.graduate(owner, "wf", "say")).rejects.toThrow(/DASH_EVAL_GRADUATION/);
  });
});

describe("evals over HTTP", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-evals-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("tests a saved workflow in a session, and lists the run without its log", async () => {
    const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
    const catalog = new CatalogStore(join(dir, "seed"), join(dir, ".dash", "catalog"));
    const app = buildServer({ store, keys, catalog, journal: new MemoryJournal() });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/workflows/new",
      payload: { name: "Note it", trigger: { kind: "manual" }, nodes: [{ id: "n", action: "create.note", settings: { text: "hi" } }], edges: [{ id: "a", from: "trigger", to: "n" }] },
    });
    expect(saved.statusCode).toBe(200);
    const id = saved.json().id as string;
    const started = await app.inject({ method: "POST", url: "/api/evals/sessions", payload: { workflow: id } });
    expect(started.statusCode).toBe(200);
    const session = started.json().id as string;
    expect((await app.inject({ method: "POST", url: `/api/evals/sessions/${session}/step` })).json()).toMatchObject({ remaining: 0 });
    const finished = (await app.inject({ method: "POST", url: `/api/evals/sessions/${session}/finish` })).json();
    expect(finished.verdicts.every((verdict: { result: string }) => verdict.result === "pass")).toBe(true);
    const listed = (await app.inject({ method: "GET", url: `/api/evals/runs?workflow=${id}` })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].events).toBeUndefined();
    expect((await app.inject({ method: "GET", url: `/api/evals/runs/${listed[0].id}` })).json().events.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: `/api/workflows/${id}/graduation` })).json()).toEqual({ enabled: false, steps: [] });
    await app.close();
  });
});
