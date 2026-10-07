import { WriteError } from "@freebirdai/connect/host";
import { chainEdges, type Principal, type WorkflowSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { openDashDb } from "../platform/db.js";
import { CaseBusy, STALL_MS } from "./engine.js";
import { WorkflowRunner } from "./runner.js";
import { WorkflowService } from "./service.js";
import { StartError, startWorkflow } from "./start.js";
import { DeliveryError, deliveryErrorOf } from "./env.js";
import { DbSignalStore, DbWorkflowStore } from "./store.js";
import { ORDERS, agentOf, byHand, every, fake, node, owner, run, source, workflowOf, type Fake } from "./testing.js";

/**
 * The engine under interruption, concurrency, edits, revoked access,
 * incomplete reads, retries, early signals and workflows that start
 * workflows. Each case here was reproduced against the engine before it was
 * fixed.
 */

/** Make the next write that matches fail, as if the server stopped right there. */
const crashOn = (f: Fake, store: "tasks" | "cases", when: (value: never) => boolean): void => {
  const target = f.env[store] as unknown as { put: (value: never, ...rest: unknown[]) => Promise<unknown> };
  const put = target.put.bind(target);
  let armed = true;
  target.put = async (value: never, ...rest: unknown[]) => {
    if (armed && when(value)) {
      armed = false;
      throw new Error("The server stopped.");
    }
    return put(value, ...rest);
  };
};

const later = (f: Fake, ms = STALL_MS + 1000): void => {
  f.clock.now += ms;
};

const manual = { kind: "manual" } as const;
const webhookIdempotent = (extra: Record<string, unknown> = {}) => node("send", "send.webhook", { url: "https://hooks.example.com/in", body: {}, idempotent: true }, extra);
const hook = (extra: Record<string, unknown> = {}) => node("send", "send.webhook", { url: "https://hooks.example.com/in", body: { id: "{{ input.id }}" } }, extra);

/* ── 1. interrupted steps are recovered without acting twice ─────────── */

describe("recovery", () => {
  it("asks a person, and never sends again by itself, when it stopped right after a webhook went out", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: manual, nodes: [hook(), node("note", "create.note", { text: "after" })] });
    await f.env.store.put(workflow);
    crashOn(f, "tasks", (task: { action?: string; status?: string }) => task.action === "send.webhook" && task.status === "done");
    await byHand(f, workflow);
    expect(f.posts).toHaveLength(1);
    const [stuck] = await f.env.cases.list();
    expect(stuck).toMatchObject({ status: "running", attempt: { node: "send", executing: true } });

    later(f);
    await new WorkflowRunner(f.starter).tick();
    expect(f.posts).toHaveLength(1);
    const asked = (await f.env.tasks.list({ status: "waiting_approval" }))[0]!;
    expect(asked).toMatchObject({ uncertain: true, action: "send.webhook" });
    expect((await f.env.cases.get(stuck!.id))?.waiting?.kind).toBe("uncertain");

    /* It happened: the case goes on, and nothing is sent again. */
    await f.tasks.settle(owner, asked.id);
    expect(f.posts).toHaveLength(1);
    expect(await f.env.cases.get(stuck!.id)).toMatchObject({ status: "done" });
    expect((await f.env.tasks.get(asked.id))?.status).toBe("done");
  });

  it("sends again only when a person says so, with the same operation id", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: manual, nodes: [hook()] });
    await f.env.store.put(workflow);
    crashOn(f, "tasks", (task: { action?: string; status?: string }) => task.action === "send.webhook" && task.status === "done");
    await byHand(f, workflow);
    later(f);
    await f.engine.recover();
    const asked = (await f.env.tasks.list({ status: "waiting_approval" }))[0]!;
    await f.tasks.approve(owner, asked.id);
    expect(f.posts).toHaveLength(2);
    expect(f.posts[0]!.key).toBeTruthy();
    expect(f.posts[1]!.key).toBe(f.posts[0]!.key);
  });

  it("moves on from what the task recorded, without acting again, when it stopped after writing the task", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: manual, nodes: [hook(), node("note", "create.note", { text: "after" })] });
    await f.env.store.put(workflow);
    /* The task is written done; the case's next save is lost. */
    crashOn(f, "cases", (one: { at?: string; attempt?: unknown }) => one.at === "note" && one.attempt === undefined);
    await byHand(f, workflow);
    later(f);
    await f.engine.recover();
    expect(f.posts).toHaveLength(1);
    const [one] = await f.env.cases.list();
    expect(one).toMatchObject({ status: "done" });
    expect((await f.env.tasks.list()).map((task) => task.title)).toContain("after");
  });

  it("runs an internal step again after an interruption, and makes one calendar entry", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: manual, nodes: [node("cal", "create.calendar", { title: "Inspect", at: "2026-10-09" })] });
    await f.env.store.put(workflow);
    crashOn(f, "tasks", (task: { action?: string; status?: string }) => task.action === "create.calendar" && task.status === "done");
    await byHand(f, workflow);
    later(f);
    await f.engine.recover();
    expect(await f.env.calendar.list()).toHaveLength(1);
    expect((await f.env.cases.list())[0]?.status).toBe("done");
  });

  it("leaves a case alone while another call is working on it", async () => {
    const f = fake({ leases: true });
    const workflow = workflowOf({ trigger: manual, nodes: [node("wait", "wait.duration", { duration: "1h" })] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const id = done.cases[0]!;
    /* The same server, two calls: the lease is per call, not per server. */
    const first = f.engine.advance(id, { retry: true });
    await expect(f.engine.advance(id, { retry: true })).rejects.toBeInstanceOf(CaseBusy);
    await first;
  });
});

/* ── 1b. two starts never act twice on one record ────────────────────── */

describe("concurrent starts", () => {
  it("refuses a second start of the same workflow on the same server while the first runs", async () => {
    const f = fake({ leases: true });
    f.rows = ORDERS;
    const workflow = workflowOf({ trigger: every, source, nodes: [node("n", "create.note", { text: "{{ id }}" })] });
    await f.env.store.put(workflow);
    const results = await Promise.allSettled([run(f, workflow), run(f, workflow)]);
    expect(results.filter((one) => one.status === "rejected").map((one) => (one as PromiseRejectedResult).reason)).toEqual([expect.any(StartError)]);
    expect(await f.env.cases.list()).toHaveLength(3);
  });

  it("opens one case per record even when two runs race without a lease", async () => {
    const f = fake();
    f.rows = ORDERS;
    const workflow = workflowOf({ trigger: every, source, nodes: [node("n", "create.note", { text: "{{ id }}" })] });
    await f.env.store.put(workflow);
    await Promise.all([run(f, workflow), run(f, workflow)]);
    const cases = await f.env.cases.list();
    expect(cases).toHaveLength(3);
    expect(new Set(cases.map((one) => one.rowKey)).size).toBe(3);
  });
});

/* ── 2. a case keeps the workflow it opened on ───────────────────────── */

describe("versions", () => {
  it("sends what was approved: an email stays an email after the step is changed to a text", async () => {
    const f = fake({ sender: true });
    f.agents.set("maint", agentOf());
    const email = node("say", "outreach.email", { agentId: "maint", to: "a@example.com", subject: "Hi", purpose: "Hello", content: "fixed", wording: "Hello" }, { mode: "approve" });
    const workflow = workflowOf({ trigger: manual, nodes: [email] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });

    await f.env.store.put({ ...workflow, version: 2, nodes: [{ ...email, action: "outreach.text" }] });
    await f.tasks.approve(owner, waiting!.id);
    expect(f.sent.map((one) => one.channel)).toEqual(["email"]);

    /* A new case follows the new version. */
    await byHand(f, (await f.env.store.get("wf"))!);
    const [next] = await f.env.tasks.list({ status: "waiting_approval" });
    expect(next?.action).toBe("outreach.text");
  });

  it("refuses an approval for a step the case has already left", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: manual, nodes: [hook({ mode: "approve" })] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    await f.engine.cancel(done.cases[0]!);
    await expect(f.tasks.approve(owner, waiting!.id)).rejects.toMatchObject({ status: 409 });
    expect(f.posts).toHaveLength(0);
  });

  it("moves the version on when the steps change, and not otherwise", async () => {
    const f = fake();
    const service = new WorkflowService({ store: f.env.store, policy: { can: () => ({ ok: true }) }, agents: { list: async () => [] }, hasConnection: () => true });
    const made = await service.create(owner, { name: "V", trigger: manual, nodes: [node("a", "create.note", { text: "a" })], edges: chainEdges([{ id: "a" }]) } as never);
    expect(made.version).toBe(1);
    const same = await service.update(owner, made.id, { name: "V renamed", trigger: manual, nodes: made.nodes, edges: made.edges } as never);
    expect(same.version).toBe(1);
    const changed = await service.update(owner, made.id, { name: "V", trigger: manual, nodes: [node("a", "create.note", { text: "b" })], edges: made.edges } as never);
    expect(changed.version).toBe(2);
  });
});

/* ── 3. background reads ask who may read, every time ───────────────── */

describe("authorization on background reads", () => {
  const watching = (f: Fake): WorkflowSpec => {
    const nodes = [node("wait", "wait.for", { event: "record_change", condition: 'status == "scheduled"', timeout: "3d" }), node("done", "create.note", { text: "scheduled" })];
    return workflowOf({ trigger: every, source, nodes, edges: [...chainEdges(nodes.slice(0, 1)), { id: "h", from: "wait", outcome: "happened", to: "done" }] });
    void f;
  };

  it("stops reading a watched record once the person it runs as may no longer read it", async () => {
    let allowed = true;
    const f = fake({ policy: { can: () => (allowed ? { ok: true } : { ok: false, reason: "Access was removed." }) } });
    f.rows = [ORDERS[0]!];
    const workflow = watching(f);
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [waiting] = await f.env.cases.list();
    expect(waiting?.status).toBe("waiting");

    allowed = false;
    const reads = f.reads.length;
    await new WorkflowRunner(f.starter).tick();
    expect(f.reads.length).toBe(reads);
    expect((await f.env.store.get("wf"))?.parked?.reason).toMatch(/may no longer read/);
    expect((await f.env.cases.get(waiting!.id))?.status).toBe("failed");
  });

  it("does not read when entering a wait without access", async () => {
    let allowed = true;
    const f = fake({ policy: { can: () => (allowed ? { ok: true } : { ok: false, reason: "No." }) } });
    f.rows = [ORDERS[0]!];
    const nodes = [node("pause", "wait.duration", { duration: "1h" }), node("wait", "wait.for", { event: "record_change", condition: 'status == "scheduled"', timeout: "3d" })];
    const workflow = workflowOf({ trigger: every, source, nodes });
    await f.env.store.put(workflow);
    await run(f, workflow);
    allowed = false;
    const reads = f.reads.length;
    later(f, 3_600_000);
    await f.engine.timeouts();
    expect(f.reads.length).toBe(reads);
    expect((await f.env.store.get("wf"))?.parked).toBeTruthy();
  });

  it("tells an agent that was removed from no agent at all", async () => {
    const f = fake();
    f.agents.set("maint", agentOf());
    const workflow = workflowOf({ trigger: manual, nodes: [node("note", "create.note", { text: "x" }, { agentId: "maint" })] });
    await f.env.store.put(workflow);
    f.agents.delete("maint");
    await byHand(f, workflow);
    expect((await f.env.store.get("wf"))?.parked?.reason).toMatch(/"maint" it acts for no longer exists/);
    const plain = workflowOf({ id: "plain", trigger: manual, nodes: [node("note", "create.note", { text: "x" })] });
    await f.env.store.put(plain);
    await startWorkflow(f.starter, plain, { kind: "manual" }, { actor: owner });
    expect((await f.env.cases.list({ workflow: "plain" }))[0]?.status).toBe("done");
  });
});

/* ── 4. not reached is not the same as not there ─────────────────────── */

describe("incomplete reads", () => {
  it("keeps taking note until one read reaches every record, so older records never look new", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: { kind: "record_created", connection: "pms", record: "work_order" }, nodes: [node("n", "create.note", { text: "new {{ unit }}" })] });
    await f.env.store.put(workflow);
    f.rows = ORDERS.slice(0, 1);
    f.complete = false;
    expect((await run(f, workflow)).run.summary).toMatch(/not every record was reached/);
    f.rows = ORDERS.slice(0, 2);
    f.complete = true;
    expect((await run(f, workflow)).run.status).toBe("seeded");
    expect(await f.env.cases.list()).toHaveLength(0);
    f.rows = ORDERS;
    expect((await run(f, workflow)).run.matched).toBe(1);
    expect((await f.env.tasks.list()).map((one) => one.title)).toEqual(["new 3C"]);
  });

  it("never lets an Only if still change through on a read that did not reach the record", async () => {
    const f = fake();
    f.rows = [];
    f.complete = false;
    const workflow = workflowOf({ trigger: manual, nodes: [node("fix", "update.record", { connection: "pms", entity: "work_order", recordId: "7", values: { status: "closed" }, onlyIf: 'status == "open"' })] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    expect(f.committed).toHaveLength(0);
    expect((await f.env.tasks.list())[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/not every record was reached/) });
  });

  it("says when a Look up did not reach every record, and goes down incomplete", async () => {
    const f = fake();
    f.rows = [];
    f.complete = false;
    const nodes = [node("find", "lookup.records", { connection: "pms", entity: "work_order" }), node("none", "create.note", { text: "none" }), node("unsure", "create.note", { text: "unsure" })];
    const workflow = workflowOf({
      trigger: manual,
      nodes,
      edges: [...chainEdges(nodes.slice(0, 1)), { id: "n", from: "find", outcome: "next", to: "none" }, { id: "i", from: "find", outcome: "incomplete", to: "unsure" }],
    });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const one = await f.env.cases.get(done.cases[0]!);
    expect(one?.data.steps["find"]).toMatchObject({ count: 0, complete: false });
    expect((await f.env.tasks.list()).map((task) => task.title)).toContain("unsure");
  });
});

/* ── 5. retries ──────────────────────────────────────────────────────── */

describe("retries", () => {
  it("tries a refused webhook again after its delay, with backoff, up to the times set", async () => {
    const f = fake();
    f.postAnswer = 503;
    const workflow = workflowOf({ trigger: manual, nodes: [webhookIdempotent({ mode: "auto", retry: { times: 3, delay: "1m" } })] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const id = done.cases[0]!;
    expect(await f.env.cases.get(id)).toMatchObject({ status: "waiting", waiting: { kind: "retry" } });
    expect(f.posts).toHaveLength(1);

    const runner = new WorkflowRunner(f.starter);
    later(f, 60_000);
    await runner.tick();
    expect(f.posts).toHaveLength(2);
    /* Backoff: the second wait is twice as long. */
    later(f, 60_000);
    await runner.tick();
    expect(f.posts).toHaveLength(2);
    f.postAnswer = 200;
    later(f, 60_000);
    await runner.tick();
    expect(f.posts).toHaveLength(3);
    expect(new Set(f.posts.map((one) => one.key)).size).toBe(1);
    expect(await f.env.cases.get(id)).toMatchObject({ status: "done" });
  });

  it("gives up after the last try", async () => {
    const f = fake();
    f.postAnswer = 500;
    const workflow = workflowOf({ trigger: manual, nodes: [webhookIdempotent({ mode: "auto", retry: { times: 1, delay: "1m" } })] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    later(f, 60_000);
    await f.engine.timeouts();
    expect(f.posts).toHaveLength(2);
    expect(await f.env.cases.get(done.cases[0]!)).toMatchObject({ status: "failed" });
  });

  it("never retries a send whose answer was lost: a person is asked", async () => {
    const f = fake();
    f.postAnswer = new Error("The request timed out.");
    const workflow = workflowOf({ trigger: manual, nodes: [hook({ mode: "auto", retry: { times: 3, delay: "1m" } })] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    later(f, 600_000);
    await f.engine.timeouts();
    expect(f.posts).toHaveLength(1);
    expect((await f.env.tasks.list({ status: "waiting_approval" }))[0]).toMatchObject({ uncertain: true });
  });

  it("asks a person when a change's outcome is unknown, and retries one that was never sent", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: manual, nodes: [node("fix", "update.record", { connection: "pms", entity: "work_order", recordId: "7", values: { status: "closed" } }, { retry: { times: 2, delay: "1m" } })] });
    await f.env.store.put(workflow);
    f.failCommit = new WriteError(502, "upstream", "The API did not answer.", { outcome: "not-sent" });
    const { run: done } = await byHand(f, workflow);
    expect((await f.env.cases.get(done.cases[0]!))?.waiting?.kind).toBe("retry");
    later(f, 60_000);
    await f.engine.timeouts();
    expect(f.committed).toHaveLength(1);

    f.failCommit = new WriteError(504, "upstream", "No answer.", { outcome: "unknown" });
    const again = await byHand(f, workflow);
    expect((await f.env.cases.get(again.run.cases[0]!))?.waiting?.kind).toBe("uncertain");
  });
});

/* ── 6. signals are kept until taken ─────────────────────────────────── */

describe("signals", () => {
  it("goes straight on when the decision it waits for was already made", async () => {
    const f = fake();
    const nodes = [node("ask", "ask.answer", { question: "When?", timeout: "2d" }), node("wait", "wait.for", { event: "decision", step: "ask", timeout: "2d" }), node("done", "create.note", { text: "heard {{ steps.wait.event.answer }}" })];
    const workflow = workflowOf({ trigger: manual, nodes, edges: [...chainEdges(nodes.slice(0, 2)), { id: "h", from: "wait", outcome: "happened", to: "done" }] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const [question] = await f.env.tasks.list({ status: "waiting" });
    await f.tasks.answer(owner, question!.id, "Tuesday");
    expect(await f.env.cases.get(done.cases[0]!)).toMatchObject({ status: "done" });
    expect((await f.env.tasks.list()).map((one) => one.title)).toContain("heard Tuesday");
  });

  it("keeps a reply that arrives before its wait starts, for the wait to take", async () => {
    const f = fake({ sender: true });
    f.agents.set("maint", agentOf());
    const nodes = [
      node("text", "outreach.text", { agentId: "maint", to: "+1", purpose: "Hi", content: "fixed", wording: "Hi" }),
      node("pause", "wait.duration", { duration: "1h" }),
      node("reply", "wait.for", { event: "reply", step: "text", timeout: "2d" }),
      node("heard", "create.note", { text: "heard" }),
    ];
    const workflow = workflowOf({ trigger: manual, nodes, edges: [...chainEdges(nodes.slice(0, 3)), { id: "h", from: "reply", outcome: "happened", to: "heard" }] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const conversation = String((await f.env.cases.get(done.cases[0]!))?.data.steps["text"] && ((await f.env.cases.get(done.cases[0]!))!.data.steps["text"] as Record<string, unknown>)["conversation"]);
    expect(await f.engine.emit(`reply:${conversation}`, { text: "Thanks!" })).toBe(0);
    later(f, 3_600_000);
    await f.engine.timeouts();
    expect(await f.env.cases.get(done.cases[0]!)).toMatchObject({ status: "done" });
    expect((await f.env.tasks.list()).map((one) => one.title)).toContain("heard");
  });

  it("hands a signal on later when the case was busy as it arrived", async () => {
    const f = fake({ leases: true });
    const nodes = [node("hook", "wait.for", { event: "webhook", timeout: "2d" }), node("heard", "create.note", { text: "heard" })];
    const workflow = workflowOf({ trigger: manual, nodes, edges: [...chainEdges(nodes.slice(0, 1)), { id: "h", from: "hook", outcome: "happened", to: "heard" }] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const id = done.cases[0]!;
    const key = (await f.env.cases.get(id))!.waiting!.key;
    const leases = (f.starter.leases)!;
    await leases.acquire(`case:${id}`, "someone-else", 60_000);
    expect(await f.engine.emit(key, { ok: true })).toBe(0);
    expect((await f.env.cases.get(id))?.status).toBe("waiting");
    await leases.release(`case:${id}`, "someone-else");
    await f.engine.deliverPending();
    expect((await f.env.cases.get(id))?.status).toBe("done");
  });
});

/* ── 7. workflows that start workflows ──────────────────────────────── */

describe("child workflows", () => {
  const child = (id: string, nodes = [node("bad", "send.webhook", { url: "http://not-https.example.com" })]): WorkflowSpec => workflowOf({ id, name: id, trigger: manual, nodes });

  it("goes down failed when a child it waits for fails at once", async () => {
    const f = fake();
    await f.env.store.put(child("kid"));
    const parent = workflowOf({ trigger: manual, nodes: [node("start", "run_workflow.start", { workflow: "kid", waitForIt: true }), node("after", "create.note", { text: "after" })] });
    await f.env.store.put(parent);
    const { run: done } = await byHand(f, parent);
    expect(await f.env.cases.get(done.cases[0]!)).toMatchObject({ status: "failed" });
    expect((await f.env.tasks.list()).map((one) => one.title)).not.toContain("after");
  });

  it("refuses a loop of workflows starting each other, saved or running", async () => {
    const f = fake();
    const service = new WorkflowService({ store: f.env.store, policy: { can: () => ({ ok: true }) }, agents: { list: async () => [] }, hasConnection: () => true });
    const b = await service.create(owner, { name: "B", trigger: manual, nodes: [node("n", "create.note", { text: "b" })], edges: chainEdges([{ id: "n" }]) } as never);
    const a = await service.create(owner, { name: "A", trigger: manual, nodes: [node("go", "run_workflow.start", { workflow: b.id })], edges: chainEdges([{ id: "go" }]) } as never);
    await expect(service.update(owner, b.id, { name: "B", trigger: manual, nodes: [node("go", "run_workflow.start", { workflow: a.id })], edges: chainEdges([{ id: "go" }]) } as never)).rejects.toThrow(/start each other/);

    /* Saved around the check: the engine refuses at run time too. */
    await f.env.store.put({ ...(await f.env.store.get(b.id))!, nodes: [node("go", "run_workflow.start", { workflow: a.id, waitForIt: true })], edges: chainEdges([{ id: "go" }]) });
    await startWorkflow(f.starter, (await f.env.store.get(a.id))!, { kind: "manual" }, { actor: owner });
    const failed = (await f.env.tasks.list({ status: "failed" })).map((one) => one.error);
    expect(failed.join(" ")).toMatch(/already running further up/);
  });

  it("starts a child once however often the step runs, and cancels it with its parent", async () => {
    const f = fake();
    await f.env.store.put(child("kid", [node("pause", "wait.duration", { duration: "1d" })]));
    const parent = workflowOf({ trigger: manual, nodes: [node("start", "run_workflow.start", { workflow: "kid", waitForIt: true })] });
    await f.env.store.put(parent);
    const { run: done } = await byHand(f, parent);
    const kids = await f.env.cases.list({ workflow: "kid" });
    expect(kids).toHaveLength(1);
    await f.engine.cancel(done.cases[0]!);
    expect((await f.env.cases.get(kids[0]!.id))?.status).toBe("cancelled");
  });
});

/* ── 8. reaching more of an API ─────────────────────────────────────── */

describe("integration steps", () => {
  it("reads a named endpoint with parameters", async () => {
    const f = fake();
    f.rows = ORDERS;
    const workflow = workflowOf({ trigger: manual, nodes: [node("find", "lookup.records", { connection: "pms", op: "searchOrders", params: { status: "open", unit: "{{ input.unit }}" } })] });
    await f.env.store.put(workflow);
    await startWorkflow(f.starter, workflow, { kind: "manual" }, { actor: owner, inputs: { unit: "2B" } });
    expect(f.reads.at(-1)).toMatchObject({ op: "searchOrders", params: { status: "open", unit: "2B" } });
  });

  it("keeps a record's parent ids on an update, and fills in nested values", async () => {
    const f = fake();
    const workflow = workflowOf({
      trigger: manual,
      nodes: [node("fix", "update.record", { connection: "pms", entity: "unit_note", recordId: "9", parents: { property: "{{ input.property }}" }, values: { detail: { by: "{{ input.who }}", tags: ["{{ input.tag }}"] } } })],
    });
    await f.env.store.put(workflow);
    await startWorkflow(f.starter, workflow, { kind: "manual" }, { actor: owner, inputs: { property: "P1", who: "Sam", tag: "hvac" } });
    expect(f.prepared[0]!.intent).toMatchObject({ kind: "update", id: "9", parents: { property: "P1" }, values: { detail: { by: "Sam", tags: ["hvac"] } } });
  });

  it("starts a workflow for each item, side by side, and goes on when all have finished", async () => {
    const f = fake();
    f.rows = ORDERS;
    await f.env.store.put(workflowOf({ id: "each", name: "each", trigger: { kind: "agent", inputs: [{ name: "order", required: true, description: "The work order" }] }, nodes: [node("pause", "wait.duration", { duration: "1h" })] }));
    const nodes = [node("find", "lookup.records", { connection: "pms", entity: "work_order", filter: 'status == "open"' }), node("all", "run_workflow.each", { workflow: "each", items: "{{ steps.find.rows }}", as: "order" }), node("after", "create.note", { text: "all done" })];
    const parent = workflowOf({ trigger: manual, nodes });
    await f.env.store.put(parent);
    const { run: done } = await byHand(f, parent);
    const kids = await f.env.cases.list({ workflow: "each" });
    expect(kids).toHaveLength(2);
    expect(kids.map((one) => (one.data.input["order"] as { id: number }).id).sort()).toEqual([1, 2]);
    expect((await f.env.cases.get(done.cases[0]!))?.status).toBe("waiting");
    later(f, 3_600_000);
    await f.engine.timeouts();
    expect(await f.env.cases.get(done.cases[0]!)).toMatchObject({ status: "done" });
    expect((await f.env.tasks.list()).map((one) => one.title)).toContain("all done");
  });
});

/* ── the database stores ───────────────────────────────────────────── */

describe("database stores", () => {
  it("lets one claim win on a record, and one case take a signal", async () => {
    const db = await openDashDb({ inMemory: true });
    try {
      const workflows = new DbWorkflowStore(db, "acme");
      expect(await workflows.claimFired("wf", "7", undefined, { fingerprint: "acted", count: 1 })).toBe(true);
      expect(await workflows.claimFired("wf", "7", undefined, { fingerprint: "acted", count: 1 })).toBe(false);
      expect(await workflows.claimFired("wf", "7", { fingerprint: "acted", count: 1 }, { fingerprint: "acted", count: 2 })).toBe(true);
      expect(await workflows.claimFired("wf", "7", { fingerprint: "acted", count: 1 }, { fingerprint: "acted", count: 2 })).toBe(false);

      const signals = new DbSignalStore(db, "acme");
      await signals.put({ id: "s1", key: "hook:x", at: "2026-10-06T12:00:00.000Z", payload: { n: 1 } });
      expect(await signals.untaken("2026-10-01T00:00:00.000Z")).toEqual(["hook:x"]);
      const [a, b] = await Promise.all([signals.take("hook:x", "case-a", "2026-10-01T00:00:00.000Z"), signals.take("hook:x", "case-b", "2026-10-01T00:00:00.000Z")]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((a ?? b)?.payload).toEqual({ n: 1 });
      await signals.ack((a ?? b)!.id);
      expect(await signals.untaken("2026-10-01T00:00:00.000Z")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

/* ── second review: state transitions, joins, trigger identity ───────── */

/** Break one call of a store method: before it does anything, or after it has done it. */
const breakOnce = <T extends object>(target: T, method: keyof T & string, when: (...args: never[]) => boolean, after = false): void => {
  const original = (target[method] as unknown as (...args: unknown[]) => Promise<unknown>).bind(target);
  let armed = true;
  (target as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    if (armed && when(...(args as never[]))) {
      armed = false;
      if (after) await original(...args);
      throw new Error("The server stopped.");
    }
    return original(...args);
  };
};

describe("the last step and its ending", () => {
  it("never sends again when it stopped while ending the case after its last step", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: manual, nodes: [hook()] });
    await f.env.store.put(workflow);
    crashOn(f, "cases", (one: { status?: string }) => one.status === "done");
    await byHand(f, workflow);
    expect(f.posts).toHaveLength(1);
    later(f);
    await f.engine.recover();
    expect(f.posts).toHaveLength(1);
    expect((await f.env.cases.list())[0]).toMatchObject({ status: "done" });
  });

  it("never asks again when it stopped while ending the case after an answer", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: manual, nodes: [node("ask", "ask.answer", { question: "When?", timeout: "2d" })] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const [question] = await f.env.tasks.list({ status: "waiting" });
    crashOn(f, "cases", (one: { status?: string }) => one.status === "done");
    await f.tasks.answer(owner, question!.id, "Tuesday").catch(() => undefined);
    later(f);
    await f.engine.recover();
    await f.engine.deliverPending();
    expect(await f.env.cases.get(done.cases[0]!)).toMatchObject({ status: "done" });
    expect((await f.env.tasks.list()).filter((task) => task.body.kind === "question")).toHaveLength(1);
  });

  it("tells a waiting parent after it stopped between ending a child and announcing it", async () => {
    const f = fake();
    await f.env.store.put(workflowOf({ id: "kid", name: "kid", trigger: manual, nodes: [node("pause", "wait.duration", { duration: "1h" })] }));
    const parent = workflowOf({ trigger: manual, nodes: [node("start", "run_workflow.start", { workflow: "kid", waitForIt: true })] });
    await f.env.store.put(parent);
    const { run: done } = await byHand(f, parent);
    breakOnce(f.env.signals, "put", (signal: { key: string }) => signal.key.startsWith("case-done:"));
    later(f, 3_600_000);
    await f.engine.timeouts();
    expect((await f.env.cases.get(done.cases[0]!))?.status).toBe("waiting");
    later(f);
    await f.engine.recover();
    expect(await f.env.cases.get(done.cases[0]!)).toMatchObject({ status: "done" });
  });
});

describe("taking a signal", () => {
  it("keeps an answer for the case when it stopped between taking it and saving what it caused", async () => {
    const f = fake();
    const nodes = [node("ask", "ask.answer", { question: "When?", timeout: "2d" }), node("note", "create.note", { text: "heard {{ steps.ask.answer }}" })];
    const workflow = workflowOf({ trigger: manual, nodes });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const [question] = await f.env.tasks.list({ status: "waiting" });
    crashOn(f, "cases", (one: { status?: string; at?: string }) => one.status === "running" && one.at === "ask");
    await f.tasks.answer(owner, question!.id, "Tuesday").catch(() => undefined);
    expect((await f.env.cases.get(done.cases[0]!))?.status).toBe("waiting");
    await f.engine.deliverPending();
    expect(await f.env.cases.get(done.cases[0]!)).toMatchObject({ status: "done" });
    expect((await f.env.tasks.list()).map((task) => task.title)).toContain("heard Tuesday");
  });

  it("lets no other case take a signal one case holds, and frees it once acknowledged", async () => {
    const f = fake();
    await f.env.signals.put({ id: "s", key: "k", at: "2026-10-06T12:00:00.000Z", payload: {} });
    expect(await f.env.signals.take("k", "a", "2026-01-01")).toBeTruthy();
    expect(await f.env.signals.take("k", "b", "2026-01-01")).toBeNull();
    expect(await f.env.signals.take("k", "a", "2026-01-01")).toBeTruthy();
    await f.env.signals.ack("s");
    expect(await f.env.signals.take("k", "a", "2026-01-01")).toBeNull();
    expect(await f.env.signals.untaken("2026-01-01")).toEqual([]);
  });
});

describe("waiting for all", () => {
  it("waits for every item even when the first ends before the rest exist", async () => {
    const f = fake();
    f.rows = [
      { id: 1, status: "open", slow: false },
      { id: 2, status: "open", slow: true },
    ];
    await f.env.store.put(
      workflowOf({
        id: "each",
        name: "each",
        trigger: { kind: "agent", inputs: [{ name: "order", required: true, description: "The work order" }] },
        nodes: [node("pause", "wait.duration", { duration: "1h" }, { when: "input.order.slow == true" })],
      }),
    );
    const nodes = [node("find", "lookup.records", { connection: "pms", entity: "work_order" }), node("all", "run_workflow.each", { workflow: "each", items: "{{ steps.find.rows }}", as: "order" })];
    const parent = workflowOf({ trigger: manual, nodes });
    await f.env.store.put(parent);
    const { run: done } = await byHand(f, parent);
    expect((await f.env.cases.list({ workflow: "each" })).map((one) => one.status).sort()).toEqual(["done", "waiting"]);
    expect((await f.env.cases.get(done.cases[0]!))?.status).toBe("waiting");
    later(f, 3_600_000);
    await f.engine.timeouts();
    const after = await f.env.cases.get(done.cases[0]!);
    expect(after).toMatchObject({ status: "done" });
    expect((after?.data.steps["all"] as { count: number }).count).toBe(2);
  });
});

describe("trigger claims", () => {
  const perRow = (f: Fake): WorkflowSpec => workflowOf({ trigger: every, source, criteria: 'status == "open"', nodes: [hook()] });

  it("opens a new case each time a record matches again", async () => {
    const f = fake();
    const workflow = perRow(f);
    await f.env.store.put(workflow);
    f.rows = [{ id: 7, status: "open" }];
    const first = await run(f, workflow);
    f.rows = [{ id: 7, status: "closed" }];
    await run(f, workflow);
    f.rows = [{ id: 7, status: "open" }];
    const third = await run(f, workflow);
    expect(third.run.cases).toHaveLength(1);
    expect(third.run.cases[0]).not.toBe(first.run.cases[0]);
    expect(f.posts).toHaveLength(2);
  });

  it("opens the case of a record claimed by a run that stopped before opening it", async () => {
    const f = fake();
    const workflow = perRow(f);
    await f.env.store.put(workflow);
    f.rows = [{ id: 7, status: "open" }];
    breakOnce(f.env.store, "claimFired", () => true, true);
    await run(f, workflow);
    expect(await f.env.cases.list()).toHaveLength(0);
    /* The next run leaves it alone: it is claimed. */
    await run(f, workflow);
    expect(await f.env.cases.list()).toHaveLength(0);
    later(f);
    await new WorkflowRunner(f.starter).tick();
    expect(await f.env.cases.list()).toHaveLength(1);
    expect(f.posts).toHaveLength(1);
    await new WorkflowRunner(f.starter).tick();
    expect(await f.env.cases.list()).toHaveLength(1);
  });
});

describe("a wait's own agent", () => {
  it("stops reading for a wait whose step's agent was removed", async () => {
    const f = fake();
    f.agents.set("maint", agentOf());
    f.rows = [ORDERS[0]!];
    const workflow = workflowOf({ trigger: every, source, nodes: [node("wait", "wait.for", { event: "record_change", condition: 'status == "scheduled"', timeout: "3d" }, { agentId: "maint" })] });
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [waiting] = await f.env.cases.list();
    expect(waiting?.waiting?.agent).toBe("maint");
    f.agents.delete("maint");
    const reads = f.reads.length;
    await new WorkflowRunner(f.starter).tick();
    expect(f.reads.length).toBe(reads);
    expect((await f.env.store.get("wf"))?.parked?.reason).toMatch(/"maint" it acts for no longer exists/);
  });
});

describe("webhook outcomes", () => {
  it("asks a person after a 5xx from a receiver not known to ignore repeats, and never retries it", async () => {
    const f = fake();
    f.postAnswer = 500;
    const workflow = workflowOf({ trigger: manual, nodes: [hook({ mode: "auto", retry: { times: 3, delay: "1m" } })] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    later(f, 600_000);
    await f.engine.timeouts();
    expect(f.posts).toHaveLength(1);
    expect((await f.env.tasks.list({ status: "waiting_approval" }))[0]).toMatchObject({ uncertain: true });
  });

  it("retries a request known never to have left, and treats any other lost answer as unknown", async () => {
    const f = fake();
    f.postAnswer = new DeliveryError("Connection refused.", "no");
    const workflow = workflowOf({ trigger: manual, nodes: [hook({ mode: "auto", retry: { times: 1, delay: "1m" } })] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    expect((await f.env.cases.get(done.cases[0]!))?.waiting?.kind).toBe("retry");

    expect(deliveryErrorOf(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })).sent).toBe("no");
    expect(deliveryErrorOf(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })).sent).toBe("unknown");
    expect(deliveryErrorOf(new Error("blocked"), () => true).sent).toBe("no");
    expect(deliveryErrorOf(new Error("The operation was aborted.")).sent).toBe("unknown");
  });
});
