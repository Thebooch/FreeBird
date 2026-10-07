import { AdapterError } from "@freebirdai/connect/adapters";
import { MemoryLeaseLock, WriteError } from "@freebirdai/connect/host";
import { fakeLlm } from "@freebirdai/dash-agent";
import { chainEdges } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { MemoryMembershipStore } from "../identity/members.js";
import { rolePolicy } from "../identity/policy.js";
import { explainDraft } from "./draft.js";
import { buildOverview } from "./overview.js";
import { previewWorkflow } from "./run.js";
import { WorkflowRunner } from "./runner.js";
import { nextDue, nextScheduled } from "./schedule.js";
import { WorkflowError, WorkflowService } from "./service.js";
import { startFromAgentTool, startWorkflow } from "./start.js";
import { MemoryWorkflowStore, RevisionConflict } from "./store.js";
import { TemplateService } from "./templates.js";
import { T0, agentOf, at, byHand, every, fake, member, node, ORDERS, owner, run, source, workflowOf } from "./testing.js";


/* ── 1. tasks ───────────────────────────────────────────────────────── */

describe("tasks", () => {
  it("leaves one task per action, whatever happens, and opens a case per matching record", async () => {
    const f = fake();
    f.rows = ORDERS;
    const workflow = workflowOf({
      trigger: every,
      source,
      criteria: 'status == "open"',
      nodes: [node("cal", "create.calendar", { title: "Unit {{ unit }}", at: "2026-10-09" }), node("note", "create.note", { text: "Done {{ id }}" }, { when: "cost < 500" })],
    });
    await f.env.store.put(workflow);
    const { run: done } = await run(f, workflow);
    expect(done).toMatchObject({ status: "succeeded", matched: 2 });
    expect(done.cases).toHaveLength(2);
    const tasks = await f.env.tasks.list();
    expect(tasks.map((one) => [one.action, one.status]).sort()).toEqual([
      ["create.calendar", "done"],
      ["create.calendar", "done"],
      ["create.note", "done"],
      ["create.note", "skipped"],
    ]);
    expect((await f.env.cases.list()).every((one) => one.status === "done")).toBe(true);
  });

  it("makes an approval a task that waits, and runs it as the approver", async () => {
    const f = fake();
    f.rows = [ORDERS[1]!];
    const workflow = workflowOf({ trigger: every, source, nodes: [node("assign", "update.record", { entity: "work_order", recordId: "{{ id }}", values: { vendor: "v1" } }, { mode: "approve" })] });
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    expect(waiting).toMatchObject({ title: "Update work_order 2 on Property system: vendor", pending: { recordId: 2, values: { vendor: "v1" } } });
    expect(f.committed).toHaveLength(0);

    const boss = member("boss", "admin");
    await expect(f.tasks.approve(boss, waiting!.id)).rejects.toMatchObject({ status: 400 });
    const { review } = await f.tasks.review(boss, waiting!.id);
    expect(f.prepared.at(-1)?.principal.userId).toBe("boss");
    const { task, case: one } = await f.tasks.approve(boss, waiting!.id, { pendingId: review!.pendingId, digest: review!.digest });
    expect(task).toMatchObject({ status: "done", approvedBy: "boss", body: { kind: "change", changes: [{ field: "vendor", before: "old", after: "v1" }] } });
    expect(one?.status).toBe("done");
    expect(f.committed).toEqual([review!.pendingId]);
  });

  it("goes back to waiting with a fresh review when the record moved before it was approved", async () => {
    const f = fake();
    f.rows = [ORDERS[1]!];
    const workflow = workflowOf({ trigger: every, source, nodes: [node("assign", "update.record", { entity: "work_order", recordId: "{{ id }}", values: { vendor: "v1" } }, { mode: "approve" })] });
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    const { review } = await f.tasks.review(owner, waiting!.id);
    f.failCommit = new WriteError(409, "stale", "This work order changed on Property system after the review.");
    await expect(f.tasks.approve(owner, waiting!.id, { pendingId: review!.pendingId, digest: review!.digest })).rejects.toMatchObject({ status: 409, extra: { review: { entity: "work_order" } } });
    expect((await f.env.tasks.get(waiting!.id))?.status).toBe("waiting_approval");
  });

  it("follows the declined arrow when a person says no", async () => {
    const f = fake();
    const nodes = [node("assign", "update.record", { entity: "work_order", recordId: "{{ id }}", values: { vendor: "v1" } }, { mode: "approve" }), node("tell", "notify.team", { title: "Declined" })];
    f.rows = [ORDERS[0]!];
    const workflow = workflowOf({ trigger: every, source, nodes, edges: [...chainEdges(nodes.slice(0, 1)), { id: "d", from: "assign", outcome: "declined", to: "tell" }] });
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    expect((await f.tasks.decline(owner, waiting!.id)).status).toBe("dismissed");
    expect((await f.env.tasks.list()).map((one) => one.title)).toContain("Declined");
  });
});

/* ── 2. reverse ─────────────────────────────────────────────────────── */

describe("reverse", () => {
  it("puts back only what a change changed, through a fresh review, and records the reversal as a task", async () => {
    const f = fake();
    f.rows = [ORDERS[0]!];
    const workflow = workflowOf({ trigger: every, source, nodes: [node("assign", "update.record", { entity: "work_order", recordId: "{{ id }}", values: { vendor: "v1" } })] });
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [done] = await f.env.tasks.list({ status: "done" });
    expect(done?.reversal).toMatchObject({ available: true, intent: { kind: "update", id: "1", values: { vendor: "old" } } });
    const { review } = await f.tasks.reverseReview(owner, done!.id);
    expect(f.prepared.at(-1)?.intent).toMatchObject({ kind: "update", values: { vendor: "old" } });
    const { task, reversal } = await f.tasks.reverse(owner, done!.id, { pendingId: review!.pendingId, digest: review!.digest });
    expect(task).toMatchObject({ status: "reversed", reversal: { reversedBy: "local", reversalTask: reversal.id } });
    expect(reversal.title).toMatch(/^Reversed: /);
    await expect(f.tasks.reverse(owner, done!.id)).rejects.toMatchObject({ status: 409 });
  });

  it("removes a calendar entry inside Dash, and says a message cannot be unsent", async () => {
    const f = fake({ sender: true });
    f.agents.set("maint", agentOf());
    const workflow = workflowOf({
      trigger: { kind: "manual" },
      nodes: [node("cal", "create.calendar", { title: "Inspect", at: "2026-10-09" }), node("text", "outreach.text", { agentId: "maint", to: "+1555", purpose: "Hello", content: "fixed", wording: "Hi there" })],
    });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    const done = await f.env.tasks.list({ status: "done" });
    const text = done.find((one) => one.action === "outreach.text");
    const cal = done.find((one) => one.action === "create.calendar");
    expect(text?.reversal).toMatchObject({ available: false, reason: "A message cannot be unsent. Send a correction instead." });
    await f.tasks.reverse(owner, cal!.id);
    expect(await f.env.calendar.list()).toHaveLength(0);
  });
});

/* ── 3. saving ──────────────────────────────────────────────────────── */

describe("saving a workflow", () => {
  const build = async () => {
    const memberships = new MemoryMembershipStore();
    const join = (userId: string, role: "admin" | "editor" | "viewer", grants: unknown[] = []) =>
      memberships.putMember({ workspaceId: "acme", userId, email: `${userId}@acme.test`, role, grants: grants as never, joinedAt: at });
    await join("boss", "admin");
    await join("reader", "viewer", [{ permission: "workflows.manage", scope: {} }]);
    const store = new MemoryWorkflowStore();
    return { store, service: new WorkflowService({ store, policy: rolePolicy(memberships), agents: { list: async () => [agentOf()] }, hasConnection: (id) => id === "pms", now: () => new Date(T0) }) };
  };
  const input = (fields: Record<string, unknown> = {}) => ({ name: "Overdue", trigger: every, source, ...fields }) as never;

  it("refuses an arrow from an outcome the step does not have, and an action that is not in the catalog", async () => {
    const { service } = await build();
    const nodes = [node("text", "outreach.text", { agentId: "maint", to: "x", purpose: "y" }), node("wait", "wait.for", { event: "reply", step: "text", timeout: "2d" }), node("next", "create.note", { text: "x" })];
    await expect(service.create(member("boss", "admin"), input({ nodes, edges: [...chainEdges(nodes.slice(0, 2)), { id: "b", from: "wait", outcome: "yes", to: "next" }] }))).rejects.toThrow(/has no outcome "yes"/);
    await expect(service.create(member("boss", "admin"), input({ nodes: [node("x", "teleport.now")], edges: [{ id: "a", from: "trigger", to: "x" }] }))).rejects.toThrow(/is not an action/);
  });

  it("allows loops, saves an incomplete step while off, and refuses to turn it on until it is complete", async () => {
    const { service } = await build();
    const nodes = [node("text", "outreach.text", { agentId: "maint" }, { mode: "approve" }), node("wait", "wait.duration", { duration: "1d" })];
    const edges = [...chainEdges(nodes), { id: "loop", from: "wait", outcome: "next", to: "text" }];
    const saved = await service.create(member("boss", "admin"), input({ nodes, edges }));
    expect(saved.edges).toHaveLength(3);
    const problems = await service.problems(member("boss", "admin"), saved);
    expect(problems.filter((one) => one.incomplete).map((one) => one.ask)).toEqual(["Who should it reach? (a field on the record, or an address)", "What should the message say or be for?"]);
    await expect(service.setEnabled(member("boss", "admin"), saved.id, true)).rejects.toBeInstanceOf(WorkflowError);
  });

  it("only lets somebody who holds a change's permission set it to automatic", async () => {
    const { service } = await build();
    const nodes = [node("assign", "update.record", { entity: "work_order", recordId: "{{ id }}", values: { vendor: "v1" } })];
    await expect(service.create(member("reader", "viewer"), input({ nodes, edges: chainEdges(nodes) }))).rejects.toMatchObject({ status: 403 });
    expect((await service.create(member("boss", "admin"), input({ nodes, edges: chainEdges(nodes) }))).enabledBy?.userId).toBe("boss");
  });
});

/* ── 4. cases and paths ─────────────────────────────────────────────── */

describe("cases and paths", () => {
  it("routes each record down its branch", async () => {
    const f = fake();
    f.rows = ORDERS.slice(0, 2);
    const nodes = [node("check", "branch.if", { condition: "cost >= 500" }), node("dear", "create.note", { text: "dear {{ id }}" }), node("cheap", "create.note", { text: "cheap {{ id }}" })];
    const workflow = workflowOf({
      trigger: every,
      source,
      nodes,
      edges: [{ id: "a", from: "trigger", to: "check" }, { id: "y", from: "check", outcome: "yes", to: "dear" }, { id: "n", from: "check", outcome: "no", to: "cheap" }],
    });
    await f.env.store.put(workflow);
    await run(f, workflow);
    const notes = (await f.env.tasks.list()).filter((one) => one.action === "create.note").map((one) => one.title).sort();
    expect(notes).toEqual(["cheap 1", "dear 2"]);
  });

  it("stops a loop at its visit limit", async () => {
    const f = fake();
    const nodes = [node("count", "update.case", { name: "n", value: "{{ coalesce(vars.n, 0) + 1 }}" })];
    const workflow = workflowOf({ trigger: { kind: "manual" }, nodes, edges: [...chainEdges(nodes), { id: "loop", from: "count", outcome: "next", to: "count" }], limits: { visitsPerStep: 3, stepsPerCase: 200 } });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const one = await f.env.cases.get(done.cases[0]!);
    expect(one).toMatchObject({ status: "failed", data: { vars: { n: 3 } } });
    expect(one?.error).toMatch(/reached 3 times/);
  });

  it("refuses a write from a stale revision, and cancelling is sticky", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: { kind: "manual" }, nodes: [node("wait", "wait.duration", { duration: "1d" })] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    const one = (await f.env.cases.get(done.cases[0]!))!;
    await f.env.cases.put({ ...one, updatedAt: "x" }, one.revision);
    await expect(f.env.cases.put({ ...one, updatedAt: "y" }, one.revision)).rejects.toBeInstanceOf(RevisionConflict);
    expect((await f.engine.cancel(one.id)).status).toBe("cancelled");
    f.clock.now += 2 * 86_400_000;
    await f.engine.timeouts();
    expect((await f.env.cases.get(one.id))?.status).toBe("cancelled");
  });
});

/* ── 5. waiting ─────────────────────────────────────────────────────── */

describe("waiting", () => {
  const followUp = () => {
    const nodes = [
      node("text", "outreach.text", { agentId: "maint", to: "{{ phone }}", purpose: "Inspection", content: "fixed", wording: "Can we come Friday?" }),
      node("wait", "wait.for", { event: "reply", step: "text", timeout: "2d" }),
      node("booked", "create.note", { text: "booked" }),
      node("again", "outreach.text", { agentId: "maint", to: "{{ phone }}", purpose: "Reminder", content: "fixed", wording: "Just checking in" }),
    ];
    return workflowOf({
      trigger: every,
      source,
      nodes,
      edges: [...chainEdges(nodes.slice(0, 2)), { id: "h", from: "wait", outcome: "happened", to: "booked" }, { id: "t", from: "wait", outcome: "timed_out", to: "again" }],
    });
  };

  it("takes the happened path when the reply comes first", async () => {
    const f = fake({ sender: true });
    f.agents.set("maint", agentOf());
    f.rows = [ORDERS[0]!];
    const workflow = followUp();
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [one] = await f.env.cases.list({ status: "waiting" });
    expect(one?.waiting?.key).toMatch(/^reply:conv-/);
    expect(await f.engine.emit(one!.waiting!.key, { text: "Yes" })).toBe(1);
    expect((await f.env.cases.get(one!.id))?.status).toBe("done");
    expect((await f.env.tasks.list()).some((task) => task.title === "booked")).toBe(true);
    expect(f.sent).toHaveLength(1);
  });

  it("takes the timed-out path when the time runs out first, and a late reply never reopens it", async () => {
    const f = fake({ sender: true });
    f.agents.set("maint", agentOf());
    f.rows = [ORDERS[0]!];
    const workflow = followUp();
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [one] = await f.env.cases.list({ status: "waiting" });
    f.clock.now += 47 * 3_600_000;
    expect(await f.engine.timeouts()).toBe(0);
    f.clock.now += 2 * 3_600_000;
    expect(await f.engine.timeouts()).toBe(1);
    expect((await f.env.cases.get(one!.id))?.status).toBe("done");
    expect(f.sent.map((sent) => sent.text)).toEqual(["Can we come Friday?", "Just checking in"]);
    expect(await f.engine.emit(one!.waiting!.key, { text: "late" })).toBe(0);
  });

  it("asks a teammate, and goes the way they answer", async () => {
    const f = fake();
    const nodes = [node("ask", "ask.approve", { question: "Pay the deposit?", timeout: "1d" }), node("yes", "create.note", { text: "paid" }), node("no", "create.note", { text: "held" })];
    const workflow = workflowOf({
      trigger: { kind: "manual" },
      nodes,
      edges: [...chainEdges(nodes.slice(0, 1)), { id: "a", from: "ask", outcome: "approved", to: "yes" }, { id: "b", from: "ask", outcome: "declined", to: "no" }],
    });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    const [question] = await f.env.tasks.list({ status: "waiting" });
    expect(question?.body).toMatchObject({ kind: "question", options: ["approved", "declined"] });
    await expect(f.tasks.answer(owner, question!.id, "maybe")).rejects.toMatchObject({ status: 400 });
    await f.tasks.answer(owner, question!.id, "declined");
    expect((await f.env.tasks.list()).map((one) => one.title)).toContain("held");
    await expect(f.tasks.answer(owner, question!.id, "approved")).rejects.toMatchObject({ status: 409 });
  });

  it("wakes a case when the record it watches changes", async () => {
    const f = fake();
    f.rows = [ORDERS[0]!];
    const nodes = [node("wait", "wait.for", { event: "record_change", condition: 'status == "scheduled"', timeout: "3d" }), node("done", "create.note", { text: "scheduled" })];
    const workflow = workflowOf({ trigger: every, source, nodes, edges: [...chainEdges(nodes.slice(0, 1)), { id: "h", from: "wait", outcome: "happened", to: "done" }] });
    await f.env.store.put(workflow);
    await run(f, workflow);
    const runner = new WorkflowRunner(f.starter);
    expect(await runner.watchRecords()).toBe(0);
    f.rows = [{ ...ORDERS[0]!, status: "scheduled" }];
    expect(await runner.watchRecords()).toBe(1);
    expect((await f.env.tasks.list()).some((task) => task.title === "scheduled")).toBe(true);
  });

  it("keeps each record within the trigger's limits: a budget and a cooldown", async () => {
    const f = fake();
    f.rows = ORDERS;
    const workflow = workflowOf({ trigger: every, source, once: "per-run", triggerLimits: { maxPerRecord: 2, cooldown: "2h" }, nodes: [node("n", "create.note", { text: "{{ id }}" })] });
    await f.env.store.put(workflow);
    expect((await run(f, workflow)).run.matched).toBe(3);
    f.clock.now += 3_600_000;
    expect((await run(f, workflow)).run.matched).toBe(0);
    f.clock.now += 2 * 3_600_000;
    expect((await run(f, workflow)).run.matched).toBe(3);
    f.clock.now += 3 * 3_600_000;
    expect((await run(f, workflow)).run.matched).toBe(0);
  });

  it("only takes note of what exists the first time an API trigger looks", async () => {
    const f = fake();
    f.rows = ORDERS.slice(0, 2);
    const workflow = workflowOf({ trigger: { kind: "record_created", connection: "pms", record: "work_order" }, nodes: [node("n", "create.note", { text: "new {{ unit }}" })] });
    await f.env.store.put(workflow);
    expect((await run(f, workflow)).run.status).toBe("seeded");
    f.rows = ORDERS;
    expect((await run(f, workflow)).run.matched).toBe(1);
    expect((await f.env.tasks.list()).map((one) => one.title)).toEqual(["new 3C"]);
  });

  it("parks on a refusal from the API, and waits when asked to", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: { kind: "record_created", connection: "pms", record: "work_order" } });
    await f.env.store.put(workflow);
    f.failRead = new AdapterError("Too many requests.", { status: 429, retryAfter: "120" });
    expect((await run(f, workflow)).waitMs).toBe(120_000);
    f.failRead = new AdapterError("Refused.", { status: 401, upstreamStatus: 401 });
    expect((await run(f, workflow)).run.status).toBe("parked");
  });

  it("reads a schedule in the workflow's own time zone", () => {
    expect(new Date(nextScheduled("0 7 * * 1-5", "America/Chicago", Date.parse("2026-10-06T11:59:00Z"))!).toISOString()).toBe("2026-10-06T12:00:00.000Z");
    expect(nextDue({ kind: "record_created", connection: "pms", record: "x", every: "15m" }, null, T0)).toBe(T0);
  });

  it("runs a due trigger once per lease, leaving what another server holds", async () => {
    const f = fake();
    const leases = new MemoryLeaseLock(() => f.clock.now);
    const workflow = workflowOf({ trigger: every, nodes: [node("n", "create.note", { text: "tick" })] });
    await f.env.store.put(workflow);
    const runner = new WorkflowRunner({ ...f.starter, leases });
    f.clock.now += 3_600_000;
    await leases.acquire("workflow:wf", "other", 60_000);
    await runner.tick();
    expect(await f.env.store.runs()).toHaveLength(0);
    f.clock.now += 120_000;
    await runner.tick();
    await runner.tick();
    expect(await f.env.store.runs()).toHaveLength(1);
  });
});

/* ── Outreach, Think, agents ────────────────────────────────────────── */

describe("Outreach", () => {
  it("writes in the agent's voice with the workflow's guardrails, and says when nothing is connected", async () => {
    const llm = fakeLlm([{ text: "Hi! We got your work order." }]);
    const f = fake({ llm });
    f.agents.set("maint", agentOf());
    const workflow = workflowOf({ trigger: { kind: "manual" }, guardrails: "Never promise a date.", nodes: [node("text", "outreach.text", { agentId: "maint", to: "+1555", purpose: "Confirm receipt" })] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    const system = llm.calls[0]!.messages[0]!.content;
    expect(system).toContain("SECRET-ROLE");
    expect(system).toContain("Never promise a date.");
    const [task] = await f.env.tasks.list();
    expect(task).toMatchObject({ agent: "maint", delivery: { status: "not_sent" }, body: { kind: "conversation", sent: "Hi! We got your work order." } });
  });

  it("asks in trial whatever the step says, counts the trial down, and Approve always makes it automatic", async () => {
    const f = fake({ sender: true });
    f.agents.set("maint", agentOf());
    const workflow = workflowOf({ trigger: { kind: "manual" }, trial: 2, nodes: [node("text", "outreach.text", { agentId: "maint", to: "+1", purpose: "Hi", content: "fixed", wording: "Hi" })] });
    await f.env.store.put(workflow);
    await byHand(f, workflow);
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    expect(waiting?.reason).toMatch(/In trial/);
    await f.tasks.approve(owner, waiting!.id, { always: true });
    expect(f.sent).toHaveLength(1);
    const after = await f.env.store.get("wf");
    expect(after).toMatchObject({ trial: 1, nodes: [{ mode: "auto" }] });
  });
});

describe("Think", () => {
  it("goes down the category the model picks, and never uses an agent's reply prompt", async () => {
    const llm = fakeLlm([{ args: { category: "urgent", reason: "No heat." } }]);
    const f = fake({ llm });
    f.agents.set("maint", agentOf());
    const nodes = [node("sort", "think.classify", { prompt: "How urgent?", categories: ["urgent", "routine"] }), node("hot", "create.note", { text: "hot" }), node("cool", "create.note", { text: "cool" })];
    const workflow = workflowOf({
      trigger: { kind: "manual" },
      nodes,
      edges: [...chainEdges(nodes.slice(0, 1)), { id: "u", from: "sort", outcome: "urgent", to: "hot" }, { id: "r", from: "sort", outcome: "routine", to: "cool" }],
    });
    await f.env.store.put(workflow);
    await startWorkflow(f.starter, workflow, { kind: "agent", agentId: "maint" }, { actor: owner });
    expect((await f.env.tasks.list()).map((one) => one.title)).toContain("hot");
    expect(llm.calls[0]!.messages.map((one) => one.content).join("\n")).not.toContain("SECRET-ROLE");
  });

  it("refuses an answer that does not fit the shape the step declares", async () => {
    const llm = fakeLlm([{ args: { category: "purple" } }]);
    const f = fake({ llm });
    const workflow = workflowOf({ trigger: { kind: "manual" }, nodes: [node("sort", "think.classify", { prompt: "?", categories: ["urgent", "routine"] })] });
    await f.env.store.put(workflow);
    const { run: done } = await byHand(f, workflow);
    expect((await f.env.cases.get(done.cases[0]!))?.error).toMatch(/did not fit/);
  });
});

describe("an agent's run_workflow tool", () => {
  it("asks the team when the tool is approve, and starts it when a person approves", async () => {
    const f = fake();
    const agent = agentOf({ tools: [{ id: "inspect", kind: "run_workflow", workflow: "wf", mode: "approve" }] });
    f.agents.set(agent.id, agent);
    const workflow = workflowOf({ trigger: { kind: "agent", inputs: [{ name: "unit", description: "Which unit", required: true }] }, nodes: [node("cal", "create.calendar", { title: "Inspect {{ input.unit }}", at: "2026-10-12" })] });
    await f.env.store.put(workflow);
    expect(await startFromAgentTool(f.starter, { agent, tool: agent.tools[0]!, inputs: {} })).toMatchObject({ outcome: "needs_input" });
    expect((await startFromAgentTool(f.starter, { agent, tool: agent.tools[0]!, inputs: { unit: "4B" } })).outcome).toBe("approval");
    const [waiting] = await f.env.tasks.list({ status: "waiting_approval" });
    const { task } = await f.tasks.approve(member("boss", "admin"), waiting!.id);
    expect(task).toMatchObject({ status: "done", approvedBy: "boss" });
    expect((await f.env.calendar.list())[0]?.title).toBe("Inspect 4B");
  });
});

/* ── templates, drafts, overview, preview ───────────────────────────── */

describe("templates", () => {
  it("saves steps with blanks, asks for them on insert, and makes a new version on a second save", async () => {
    const f = fake();
    const nodes = [node("text", "outreach.text", { agentId: "{{ blank.agent }}", to: "{{ phone }}", purpose: "Follow up" }), node("wait", "wait.for", { event: "reply", step: "text", timeout: "{{ blank.wait }}" })];
    await f.env.store.put(workflowOf({ trigger: { kind: "manual" }, nodes }));
    const templates = new TemplateService({ templates: f.env.templates, workflows: f.env.store, newId: f.env.newId });
    const saved = await templates.saveFrom({ workflow: "wf", kind: "path", name: "Follow up", steps: ["text", "wait"] });
    expect(saved).toMatchObject({ version: 1, entry: "text", blanks: [{ name: "agent" }, { name: "wait" }] });
    await expect(templates.insert(saved.id, { agent: "maint" })).rejects.toThrow(/needs: wait/);
    const inserted = await templates.insert(saved.id, { agent: "maint", wait: "3d" }, { x: 100, y: 200 });
    expect(inserted.nodes.map((one) => one.settings["agentId"] ?? one.settings["timeout"])).toEqual(["maint", "3d"]);
    expect(inserted.nodes[1]!.settings["step"]).toBe(inserted.nodes[0]!.id);
    expect(inserted.edges).toHaveLength(1);
    expect((await templates.saveFrom({ workflow: "wf", kind: "path", name: "follow up", steps: ["text", "wait"] })).version).toBe(2);
  });
});

describe("drafts", () => {
  it("says what is missing and suggests a follow-up, in one sentence and three questions at most", async () => {
    const f = fake();
    const service = new WorkflowService({ store: f.env.store, policy: { can: () => ({ ok: true }) }, agents: { list: async () => [agentOf()] }, hasConnection: () => true });
    const workflow = workflowOf({ trigger: { kind: "record_created", connection: "pms", record: "work_order" }, nodes: [node("text", "outreach.text", { agentId: "maint", purpose: "Tell them it was received" })] });
    const draft = await explainDraft(service, owner, workflow, [agentOf()]);
    expect(draft.sentence).toBe("When a new work_order appears on pms, Maintenance agent texts them.");
    expect(draft.steps[0]).toMatchObject({ picked: "Outreach · Text", mode: "Auto" });
    expect(draft.questions.map((one) => [one.kind, one.question])).toEqual([
      ["missing", "Who should it reach? (a field on the record, or an address)"],
      ["suggestion", 'Add a follow-up if they don\'t reply to "Text"? How long should it wait first?'],
      ["suggestion", '"Text" will reach people without anyone reviewing it. Keep it on Approve?'],
    ]);
  });
});

describe("the Overview and preview", () => {
  it("says what each case waits for, and lists completed tasks newest first", async () => {
    const f = fake();
    f.rows = [ORDERS[1]!];
    const workflow = workflowOf({ trigger: every, source, nodes: [node("cal", "create.calendar", { title: "x", at: "2026-10-09" }), node("assign", "update.record", { entity: "work_order", recordId: "{{ id }}", values: { vendor: "v1" } }, { mode: "approve" })] });
    await f.env.store.put(workflow);
    await run(f, workflow);
    const overview = await buildOverview(f.env, { agents: [] });
    expect(overview.active[0]).toMatchObject({ state: "waiting_approval", waiting: 1, cases: [{ status: "waiting", waitingFor: "your approval", step: "Update record fields" }] });
    expect(overview.completed.map((one) => one.action)).toEqual(["create.calendar"]);
  });

  it("previews each record's path without writing anything", async () => {
    const f = fake();
    f.rows = ORDERS.slice(0, 2);
    const nodes = [node("check", "branch.if", { condition: "cost >= 500" }), node("dear", "update.record", { entity: "work_order", recordId: "{{ id }}", values: { vendor: "v" } }, { mode: "approve" }), node("wait", "wait.duration", { duration: "1d" })];
    const workflow = workflowOf({ trigger: every, source, nodes, edges: [{ id: "a", from: "trigger", to: "check" }, { id: "y", from: "check", outcome: "yes", to: "dear" }, { id: "n", from: "check", outcome: "no", to: "wait" }] });
    const preview = await previewWorkflow(f.env, workflow, owner);
    expect(preview.rows.map((row) => row.path.map((step) => step.node))).toEqual([
      ["check", "wait"],
      ["check", "dear"],
    ]);
    expect(await f.env.tasks.list()).toHaveLength(0);
  });
});
