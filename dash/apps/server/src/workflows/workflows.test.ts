import type { WriteIntent, WriteReview } from "@freebirdai/connect";
import { AdapterError } from "@freebirdai/connect/adapters";
import type { ReadRequest, ReadResult } from "@freebirdai/connect/host";
import { MemoryLeaseLock, WriteError } from "@freebirdai/connect/host";
import { fakeLlm } from "@freebirdai/dash-agent";
import { agentSchema, workflowSchema, type AgentSpec, type Principal, type WorkflowSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { MemoryMembershipStore } from "../identity/members.js";
import { rolePolicy, type Policy } from "../identity/policy.js";
import type { WorkflowEnv } from "./env.js";
import { ProposalService } from "./proposals.js";
import { previewWorkflow, runWorkflow } from "./run.js";
import { WorkflowRunner } from "./runner.js";
import { nextDue, nextScheduled } from "./schedule.js";
import { WorkflowError, WorkflowService } from "./service.js";
import { startFromAgentTool, startWorkflow, type Starter } from "./start.js";
import { MemoryCalendarStore, MemoryProposalStore, MemoryWorkflowStore } from "./store.js";

/**
 * Workflows, without a server: a fake read, a fake write service that records
 * what it was asked, and a clock the test moves.
 */

const T0 = Date.parse("2026-10-06T12:00:00.000Z");
const owner: Principal = { userId: "local", workspaceId: "acme", role: "owner", kind: "local-owner" };
const member = (userId: string, role: Principal["role"]): Principal => ({ userId, workspaceId: "acme", role, kind: "member" });

interface Fake {
  env: WorkflowEnv;
  clock: { now: number };
  rows: Record<string, unknown>[];
  prepared: Array<{ principal: Principal; intent: WriteIntent; via: string; onBehalfOf?: unknown }>;
  committed: string[];
  reads: ReadRequest[];
  agents: Map<string, AgentSpec>;
  failRead: Error | null;
  failPrepare: Error | null;
}

const fake = (options: { policy?: Policy; llm?: ReturnType<typeof fakeLlm> } = {}): Fake => {
  let id = 0;
  const state: Fake = {
    clock: { now: T0 },
    rows: [],
    prepared: [],
    committed: [],
    reads: [],
    agents: new Map(),
    failRead: null,
    failPrepare: null,
    env: undefined as never,
  };
  const review = (intent: WriteIntent, pendingId: string): WriteReview =>
    ({
      pendingId,
      digest: `d-${pendingId}`,
      connection: intent.connection,
      connectionTitle: "Property system",
      entity: intent.entity,
      entityName: "Work order",
      kind: intent.kind,
      mode: "merge",
      title: "Update a work order",
      summary: `Change ${intent.entity} ${intent.id ?? ""}`,
      rows: [],
      warnings: [],
      danger: false,
      unverified: false,
      inferred: false,
      expiresAt: new Date(state.clock.now + 600_000).toISOString(),
    }) as unknown as WriteReview;
  state.env = {
    workspaceId: "acme",
    store: new MemoryWorkflowStore(),
    proposals: new MemoryProposalStore(),
    calendar: new MemoryCalendarStore(),
    agents: { get: async (agentId) => state.agents.get(agentId) ?? null },
    policy: options.policy ?? { can: () => ({ ok: true }) },
    read: async (_connection, request): Promise<ReadResult> => {
      state.reads.push(request);
      if (state.failRead) throw state.failRead;
      return {
        rows: state.rows.map((row) => ({ ...row })),
        body: state.rows,
        op: "work_orders",
        cache: "miss",
        ageMs: 0,
        warnings: [],
        complete: true,
        pages: 1,
        progress: null,
        changed: null,
      };
    },
    writes: {
      prepare: async (principal, intent, how) => {
        if (state.failPrepare) throw state.failPrepare;
        state.prepared.push({ principal, intent, via: how.via, ...(how.onBehalfOf ? { onBehalfOf: how.onBehalfOf } : {}) });
        return review(intent, `p${state.prepared.length}`);
      },
      commit: async (_principal, pendingId) => {
        state.committed.push(pendingId);
        return { status: "succeeded", connection: "pms", entity: "work_order", kind: "update", changed: [], invalidated: { connection: "pms", ops: [] }, title: "Update" };
      },
      discard: () => undefined,
    },
    connectionTitle: (connection) => (connection === "pms" ? "Property system" : connection),
    ...(options.llm ? { llm: () => options.llm! } : {}),
    now: () => state.clock.now,
    newId: () => `id${++id}`,
  };
  return state;
};

const at = new Date(T0).toISOString();
const workflowOf = (fields: Record<string, unknown>): WorkflowSpec =>
  workflowSchema.parse({ id: "wf", name: "Overdue work", enabled: true, enabledBy: owner, createdAt: at, updatedAt: at, ...fields });

const agentOf = (fields: Record<string, unknown> = {}): AgentSpec =>
  agentSchema.parse({
    id: "maint",
    name: "Maintenance agent",
    color: 2,
    role: "You are the SECRET-ROLE maintenance coordinator.",
    instructions: "SECRET-INSTRUCTIONS",
    reach: [
      { permission: "records.read", scope: { connection: "pms" } },
      { permission: "records.update", scope: { connection: "pms" } },
    ],
    createdAt: at,
    updatedAt: at,
    ...fields,
  });

const ORDERS = [
  { id: 1, status: "open", cost: 120, unit: "1A" },
  { id: 2, status: "open", cost: 900, unit: "2B" },
  { id: 3, status: "closed", cost: 50, unit: "3C" },
];

const assignSteps = [
  { id: "cheap", kind: "propose_change", mode: "auto", when: "cost < 500", entity: "work_order", change: "update", recordId: "{{ id }}", values: { vendor: "v-default" } },
  { id: "dear", kind: "propose_change", mode: "approve", when: "cost >= 500", entity: "work_order", change: "update", recordId: "{{ id }}", values: { vendor: "v-default" } },
  { id: "deadline", kind: "calendar", mode: "approve", title: "Unit {{ unit }} due", at: "2026-10-09", deadline: true },
];

/* ── phase 1: saving ────────────────────────────────────────────────── */

describe("WorkflowService", () => {
  const build = async () => {
    const memberships = new MemoryMembershipStore();
    const join = (userId: string, role: "admin" | "editor" | "viewer", grants: unknown[] = []) =>
      memberships.putMember({ workspaceId: "acme", userId, email: `${userId}@acme.test`, role, grants: grants as never, joinedAt: at });
    await join("boss", "admin");
    await join("lead", "editor");
    await join("reader", "viewer", [{ permission: "workflows.manage", scope: {} }]);
    const store = new MemoryWorkflowStore();
    return {
      store,
      service: new WorkflowService({
        store,
        policy: rolePolicy(memberships),
        agents: { list: async () => [agentOf()] },
        hasConnection: (id) => id === "pms",
        now: () => new Date(T0),
      }),
    };
  };
  const input = (fields: Record<string, unknown> = {}) =>
    ({ name: "Overdue work orders", trigger: { kind: "every", every: "1h" }, source: { connection: "pms", record: "work_order" }, ...fields }) as never;

  it("makes a workflow with an id from its name, runs it as whoever saved it, and starts it off", async () => {
    const { service } = await build();
    const made = await service.create(member("lead", "editor"), input());
    expect(made).toMatchObject({ id: "overdue-work-orders", enabled: false, enabledBy: { userId: "lead" }, once: "per-row" });
    const again = await service.create(member("boss", "admin"), input());
    expect(again.id).toBe("overdue-work-orders-2");
  });

  it("refuses criteria, conditions and templates it cannot read, before anything runs", async () => {
    const { service } = await build();
    const attempt = service.create(member("lead", "editor"), input({
      criteria: "cost >=",
      steps: [{ id: "n", kind: "note", text: "Hello {{ }}", when: "((" }],
    }));
    await expect(attempt).rejects.toBeInstanceOf(WorkflowError);
    const problems = (await attempt.catch((error: WorkflowError) => error.problems)) as WorkflowError["problems"];
    expect(problems.map((one) => one.field)).toEqual(expect.arrayContaining(["criteria", "when", "text"]));
  });

  it("refuses an unknown connection and an agent that is not there", async () => {
    const { service } = await build();
    await expect(service.create(member("lead", "editor"), input({ source: { connection: "nope", record: "x" } }))).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create(member("lead", "editor"), input({ steps: [{ id: "m", kind: "message", agentId: "ghost", channel: "text", to: "{{ phone }}", purpose: "Say hi" }] })),
    ).rejects.toThrow(/no agent "ghost"/);
  });

  it("only lets somebody who holds a change's permission set it to automatic", async () => {
    const { service } = await build();
    const auto = { steps: [assignSteps[0]] };
    await expect(service.create(member("reader", "viewer"), input(auto))).rejects.toMatchObject({ status: 403 });
    const approve = { steps: [{ ...assignSteps[0], mode: "approve" }] };
    expect((await service.create(member("reader", "viewer"), input(approve))).steps[0]?.mode).toBe("approve");
    expect((await service.create(member("lead", "editor"), input(auto))).steps[0]?.mode).toBe("auto");
  });

  it("makes the person who turns it on the one it runs as, and clears a pause", async () => {
    const { service, store } = await build();
    const made = await service.create(member("boss", "admin"), input());
    await store.put({ ...made, parked: { reason: "Access lost", at }, failures: 3 });
    const on = await service.setEnabled(member("lead", "editor"), made.id, true);
    expect(on).toMatchObject({ enabled: true, enabledBy: { userId: "lead" }, failures: 0 });
    expect(on.parked).toBeUndefined();
  });

  it("forgets what it has seen when what it watches changes", async () => {
    const { service, store } = await build();
    const made = await service.create(member("boss", "admin"), input());
    await store.markFired(made.id, [{ key: "1", fingerprint: "" }], at);
    await service.update(member("boss", "admin"), made.id, input({ name: "Renamed" }));
    expect((await store.fired(made.id)).size).toBe(1);
    await service.update(member("boss", "admin"), made.id, input({ source: { connection: "pms", record: "unit" } }));
    expect((await store.fired(made.id)).size).toBe(0);
  });

  it("keeps a workflow an agent can start until the agent lets go of it", async () => {
    const memberships = new MemoryMembershipStore();
    const store = new MemoryWorkflowStore();
    const service = new WorkflowService({
      store,
      policy: rolePolicy(memberships),
      agents: { list: async () => [agentOf({ tools: [{ id: "t", kind: "run_workflow", workflow: "inspect" }] })] },
      hasConnection: () => true,
    });
    await store.put(workflowOf({ id: "inspect", trigger: { kind: "agent", inputs: [] } }));
    await expect(service.remove("inspect")).rejects.toThrow(/Maintenance agent can start this workflow/);
  });
});

/* ── phase 1: criteria, once, reach ─────────────────────────────────── */

describe("a run", () => {
  it("keeps the rows the criteria match, and acts on each once", async () => {
    const f = fake();
    f.rows = ORDERS;
    const workflow = workflowOf({ trigger: { kind: "every", every: "1h" }, source: { connection: "pms", record: "work_order" }, criteria: 'status == "open"', steps: [{ id: "n", kind: "calendar", title: "{{ unit }}", at: "2026-10-09" }] });
    await f.env.store.put(workflow);
    const first = await runWorkflow(f.env, workflow, { start: { kind: "every" } });
    expect(first.run).toMatchObject({ status: "succeeded", read: 3, matched: 2 });
    expect((await f.env.calendar.list()).map((one) => one.title)).toEqual(["1A", "2B"]);
    const second = await runWorkflow(f.env, workflow, { start: { kind: "every" } });
    expect(second.run.matched).toBe(0);
    /* Order 1 is closed, then opened again: it matches again, so it is acted on again. */
    f.rows = [{ ...ORDERS[0]!, status: "closed" }, ORDERS[1]!];
    await runWorkflow(f.env, workflow, { start: { kind: "every" } });
    f.rows = [ORDERS[0]!, ORDERS[1]!];
    expect((await runWorkflow(f.env, workflow, { start: { kind: "every" } })).run.matched).toBe(1);
  });

  it("acts on every match every run when told to", async () => {
    const f = fake();
    f.rows = ORDERS;
    const workflow = workflowOf({ trigger: { kind: "every", every: "1h" }, source: { connection: "pms", record: "work_order" }, once: "per-run", steps: [{ id: "n", kind: "note", text: "{{ count }} orders" }] });
    await f.env.store.put(workflow);
    await runWorkflow(f.env, workflow, { start: { kind: "every" } });
    const again = await runWorkflow(f.env, workflow, { start: { kind: "every" } });
    expect(again.run.outputs).toEqual([expect.objectContaining({ outcome: "done", detail: "3 orders" })]);
  });

  it("reads at background priority, with a bounded wait", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: { kind: "manual" }, source: { connection: "pms", record: "work_order" } });
    await runWorkflow(f.env, workflow, { start: { kind: "manual" }, actor: owner });
    expect(f.reads[0]).toMatchObject({ record: "work_order", wait: true, waitMs: 60_000 });
  });

  it("parks when the person it runs as may no longer read what it reads", async () => {
    const f = fake({ policy: { can: (_who, permission) => (permission === "records.read" ? { ok: false, reason: "Not shared with you." } : { ok: true }) } });
    const workflow = workflowOf({ trigger: { kind: "every", every: "1h" }, source: { connection: "pms", record: "work_order" } });
    await f.env.store.put(workflow);
    const { run } = await runWorkflow(f.env, workflow, { start: { kind: "every" } });
    expect(run.status).toBe("parked");
    expect((await f.env.store.get("wf"))?.parked?.reason).toMatch(/may no longer read Property system/);
    expect(f.reads).toHaveLength(0);
  });

  it("parks when an agent's run would read beyond the agent's reach", async () => {
    const f = fake();
    f.agents.set("maint", agentOf({ reach: [] }));
    const workflow = workflowOf({ trigger: { kind: "agent", inputs: [] }, source: { connection: "pms", record: "work_order" } });
    await f.env.store.put(workflow);
    const { run } = await runWorkflow(f.env, workflow, { start: { kind: "agent", agentId: "maint" } });
    expect(run).toMatchObject({ status: "parked", agent: "maint" });
    expect(run.error).toMatch(/Maintenance agent may not read/);
  });

  it("previews the path each row would take, and changes nothing", async () => {
    const f = fake();
    f.rows = ORDERS;
    const workflow = workflowOf({ trigger: { kind: "every", every: "1h" }, source: { connection: "pms", record: "work_order" }, criteria: 'status == "open"', steps: assignSteps });
    const preview = await previewWorkflow(f.env, workflow, owner);
    expect(preview.matched).toBe(2);
    expect(preview.rows[0]?.steps.map((one) => [one.step, one.runs, one.mode])).toEqual([
      ["cheap", true, "auto"],
      ["dear", false, "approve"],
      ["deadline", true, "auto"],
    ]);
    expect(f.prepared).toHaveLength(0);
    expect(await f.env.proposals.list()).toHaveLength(0);
    expect(await f.env.calendar.list()).toHaveLength(0);
  });
});

/* ── phase 2: when, triggers, the runner ────────────────────────────── */

describe("when a workflow is due", () => {
  it("reads a schedule in the workflow's own time zone", () => {
    /* 06:59 in Chicago (CDT, UTC-5) is 11:59 UTC; weekdays at 7 is 12:00 UTC. */
    const from = Date.parse("2026-10-06T11:59:00Z");
    expect(new Date(nextScheduled("0 7 * * 1-5", "America/Chicago", from)!).toISOString()).toBe("2026-10-06T12:00:00.000Z");
    /* Friday after 7 → Monday. */
    expect(new Date(nextScheduled("0 7 * * 1-5", "America/Chicago", Date.parse("2026-10-09T13:00:00Z"))!).toISOString()).toBe("2026-10-12T12:00:00.000Z");
  });

  it("brings an interval round after the last start, and an API trigger at once the first time", () => {
    expect(nextDue({ kind: "every", every: "1h" }, T0, 0)).toBe(T0 + 3_600_000);
    expect(nextDue({ kind: "record_created", connection: "pms", record: "x", every: "15m" }, null, T0)).toBe(T0);
    expect(nextDue({ kind: "manual" }, null, T0)).toBeNull();
  });
});

describe("an API trigger", () => {
  it("only takes note of what exists the first time, then fires on what is new", async () => {
    const f = fake();
    f.rows = ORDERS.slice(0, 2);
    const workflow = workflowOf({ trigger: { kind: "record_created", connection: "pms", record: "work_order" }, steps: [{ id: "n", kind: "calendar", title: "New: {{ unit }}", at: "2026-10-09" }] });
    await f.env.store.put(workflow);
    const seeded = await runWorkflow(f.env, workflow, { start: { kind: "record_created" } });
    expect(seeded.run).toMatchObject({ status: "seeded", matched: 0 });
    expect(await f.env.calendar.list()).toHaveLength(0);

    f.rows = ORDERS;
    const next = await runWorkflow(f.env, workflow, { start: { kind: "record_created" } });
    expect(next.run.matched).toBe(1);
    expect((await f.env.calendar.list()).map((one) => one.title)).toEqual(["New: 3C"]);
    expect((await runWorkflow(f.env, workflow, { start: { kind: "record_created" } })).run.matched).toBe(0);
  });

  it("fires on a change to the fields it watches, and not on others", async () => {
    const f = fake();
    f.rows = ORDERS;
    const workflow = workflowOf({ trigger: { kind: "record_changed", connection: "pms", record: "work_order", fields: ["status"] }, steps: [{ id: "n", kind: "note", text: "{{ count }} changed" }] });
    await f.env.store.put(workflow);
    await runWorkflow(f.env, workflow, { start: { kind: "record_changed" } });
    f.rows = [{ ...ORDERS[0]!, cost: 999 }, { ...ORDERS[1]!, status: "closed" }, ORDERS[2]!];
    const { run } = await runWorkflow(f.env, workflow, { start: { kind: "record_changed" } });
    expect(run.matched).toBe(1);
    expect(run.outputs[0]?.detail).toBe("1 changed");
  });

  it("parks on a refusal from the API, and waits when asked to", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: { kind: "record_created", connection: "pms", record: "work_order" } });
    await f.env.store.put(workflow);
    f.failRead = new AdapterError("Too many requests.", { status: 429, retryAfter: "120" });
    const waited = await runWorkflow(f.env, workflow, { start: { kind: "record_created" } });
    expect(waited.waitMs).toBe(120_000);
    expect((await f.env.store.get("wf"))?.failures).toBe(0);
    f.failRead = new AdapterError("The key was refused.", { status: 401, upstreamStatus: 401 });
    const parked = await runWorkflow(f.env, workflow, { start: { kind: "record_created" } });
    expect(parked.run.status).toBe("parked");
    expect((await f.env.store.get("wf"))?.parked?.reason).toMatch(/refused the read \(401\)/);
  });

  it("turns itself off after three failed runs in a row, and says why", async () => {
    const f = fake();
    const workflow = workflowOf({ trigger: { kind: "every", every: "1h" }, source: { connection: "pms", record: "work_order" } });
    await f.env.store.put(workflow);
    f.failRead = new Error("socket hang up");
    for (let i = 0; i < 3; i++) await runWorkflow(f.env, (await f.env.store.get("wf"))!, { start: { kind: "every" } });
    const held = await f.env.store.get("wf");
    expect(held).toMatchObject({ enabled: false, failures: 3 });
    expect(held?.parked?.reason).toMatch(/Failed 3 runs in a row.*socket hang up/);
  });
});

describe("the runner", () => {
  it("runs what is due, once per lease, and leaves what another server holds", async () => {
    const f = fake();
    f.rows = ORDERS;
    const leases = new MemoryLeaseLock(() => f.clock.now);
    const workflow = workflowOf({ trigger: { kind: "every", every: "1h" }, source: { connection: "pms", record: "work_order" }, once: "per-run" });
    await f.env.store.put(workflow);
    const runner = new WorkflowRunner({ env: f.env, leases, holder: "me" });

    f.clock.now += 3_600_000;
    await leases.acquire("workflow:wf", "someone-else", 60_000);
    await runner.tick();
    expect(await f.env.store.runs()).toHaveLength(0);

    f.clock.now += 120_000;
    await runner.tick();
    expect(await f.env.store.runs()).toHaveLength(1);
    await runner.tick();
    expect(await f.env.store.runs()).toHaveLength(1);
    f.clock.now += 3_600_000;
    await runner.tick();
    expect(await f.env.store.runs()).toHaveLength(2);
  });

  it("leaves a paused workflow and one that is off", async () => {
    const f = fake();
    await f.env.store.put(workflowOf({ id: "off", enabled: false, trigger: { kind: "every", every: "5m" } }));
    await f.env.store.put(workflowOf({ id: "paused", parked: { reason: "x", at }, trigger: { kind: "every", every: "5m" } }));
    await f.env.store.put(workflowOf({ id: "byhand", trigger: { kind: "manual" } }));
    f.clock.now += 3_600_000;
    expect(await new WorkflowRunner({ env: f.env, holder: "me" }).due()).toEqual([]);
  });
});

/* ── phase 3: paths, approve and auto ───────────────────────────────── */

describe("approve and auto", () => {
  const assign = () => workflowOf({ trigger: { kind: "every", every: "1h" }, source: { connection: "pms", record: "work_order" }, criteria: 'status == "open"', steps: assignSteps });

  it("routes each row down its path: cheap ones done, dear ones proposed", async () => {
    const f = fake();
    f.rows = ORDERS;
    const workflow = assign();
    await f.env.store.put(workflow);
    const { run } = await runWorkflow(f.env, workflow, { start: { kind: "every" } });
    expect(run.outputs.map((one) => [one.step, one.row, one.outcome])).toEqual([
      ["cheap", "1", "done"],
      ["deadline", "1", "done"],
      ["dear", "2", "proposed"],
      ["deadline", "2", "done"],
    ]);
    expect(f.prepared.map((one) => [one.intent.id, one.via, one.principal.userId])).toEqual([["1", "workflow", "local"]]);
    expect(f.committed).toEqual(["p1"]);
    const [waiting] = await f.env.proposals.list({ status: "waiting" });
    expect(waiting).toMatchObject({ kind: "change", workflow: "wf", intent: { entity: "work_order", id: "2", kind: "update", values: { vendor: "v-default" } } });
  });

  it("never commits an approve step without a person", async () => {
    const f = fake();
    f.rows = [ORDERS[1]!];
    await runWorkflow(f.env, assign(), { start: { kind: "every" } });
    expect(f.prepared).toHaveLength(0);
    expect(f.committed).toHaveLength(0);
  });

  it("parks an auto change the person it runs as may no longer make", async () => {
    const f = fake();
    f.rows = [ORDERS[0]!];
    f.failPrepare = new WriteError(403, "forbidden", "Your role here (viewer) does not allow this.");
    const workflow = assign();
    await f.env.store.put(workflow);
    const { run } = await runWorkflow(f.env, workflow, { start: { kind: "every" } });
    expect(run.status).toBe("parked");
    expect(f.committed).toHaveLength(0);
  });

  it("does an auto change in an agent's name only within its reach, and says so in the journal", async () => {
    const f = fake();
    f.rows = [ORDERS[0]!];
    f.agents.set("maint", agentOf());
    const workflow = workflowOf({ trigger: { kind: "agent", inputs: [] }, source: { connection: "pms", record: "work_order" }, steps: [assignSteps[0]] });
    await f.env.store.put(workflow);
    await runWorkflow(f.env, workflow, { start: { kind: "agent", agentId: "maint" } });
    expect(f.prepared[0]).toMatchObject({ via: "workflow", onBehalfOf: { kind: "agent", id: "maint" } });
    expect(f.committed).toEqual(["p1"]);

    f.agents.set("maint", agentOf({ reach: [{ permission: "records.read", scope: { connection: "pms" } }] }));
    await f.env.store.put({ ...workflow, steps: [{ ...assignSteps[0], id: "again", recordId: "{{ id }}" } as never], once: "per-run" });
    const { run } = await runWorkflow(f.env, (await f.env.store.get("wf"))!, { start: { kind: "agent", agentId: "maint" } });
    expect(run.status).toBe("parked");
    expect(f.committed).toEqual(["p1"]);
  });
});

describe("proposals", () => {
  const setup = async () => {
    const f = fake();
    f.rows = [ORDERS[1]!];
    const workflow = workflowOf({ trigger: { kind: "every", every: "1h" }, source: { connection: "pms", record: "work_order" }, steps: [assignSteps[1]] });
    await f.env.store.put(workflow);
    await runWorkflow(f.env, workflow, { start: { kind: "every" } });
    const [proposal] = await f.env.proposals.list();
    return { f, proposal: proposal!, service: new ProposalService({ env: f.env, holder: "me" }) };
  };

  it("is prepared fresh, as the person who opens it, and applied only to that review", async () => {
    const { f, proposal, service } = await setup();
    const reviewer = member("boss", "admin");
    const { review } = await service.review(reviewer, proposal.id);
    expect(f.prepared[0]?.principal.userId).toBe("boss");
    await expect(service.apply(reviewer, proposal.id)).rejects.toMatchObject({ status: 400 });
    const { proposal: applied } = await service.apply(reviewer, proposal.id, { pendingId: review!.pendingId, digest: review!.digest });
    expect(applied).toMatchObject({ status: "applied", decidedBy: "boss", journalId: review!.pendingId });
    await expect(service.dismiss(reviewer, proposal.id)).rejects.toMatchObject({ status: 409 });
  });

  it("goes stale when the record has moved on, and can be dismissed", async () => {
    const { f, proposal, service } = await setup();
    f.failPrepare = new WriteError(422, "invalid", "Nothing would change — no value differs from what is there now.");
    const { proposal: stale } = await service.review(owner, proposal.id);
    expect(stale.status).toBe("stale");
    expect((await service.dismiss(owner, proposal.id)).status).toBe("dismissed");
  });
});

/* ── phase 4: started by an agent; thinking ─────────────────────────── */

describe("an agent's run_workflow tool", () => {
  const setup = async (mode: "auto" | "approve" | "deny") => {
    const f = fake();
    const tool = { id: "inspect", kind: "run_workflow", workflow: "inspect", mode, denyReply: "Inspections are booked by the office." };
    const agent = agentOf({ tools: [tool] });
    f.agents.set(agent.id, agent);
    await f.env.store.put(
      workflowOf({
        id: "inspect",
        name: "Move-out inspection",
        trigger: { kind: "agent", inputs: [{ name: "unit", description: "Which unit", required: true }] },
        steps: [{ id: "c", kind: "calendar", title: "Inspect {{ input.unit }}", at: "2026-10-12" }],
      }),
    );
    const starter: Starter = { env: f.env, holder: "me" };
    return { f, agent, tool: agent.tools[0]!, starter };
  };

  it("starts the run when the tool is auto, in the agent's name", async () => {
    const { f, agent, tool, starter } = await setup("auto");
    const outcome = await startFromAgentTool(starter, { agent, tool, inputs: { unit: "4B", sneaky: "x" }, conversation: "c1" });
    expect(outcome).toMatchObject({ outcome: "started", run: { status: "succeeded", agent: "maint", start: { kind: "agent", conversation: "c1" }, inputs: { unit: "4B" } } });
    expect((await f.env.calendar.list())[0]).toMatchObject({ title: "Inspect 4B", owner: { kind: "agent", id: "maint" } });
  });

  it("asks the team instead when the tool is approve, and starts it when a person applies that", async () => {
    const { f, agent, tool, starter } = await setup("approve");
    const outcome = await startFromAgentTool(starter, { agent, tool, inputs: { unit: "4B" } });
    expect(outcome.outcome).toBe("approval");
    expect(await f.env.store.runs()).toHaveLength(0);
    const [proposal] = await f.env.proposals.list({ status: "waiting" });
    expect(proposal).toMatchObject({ kind: "workflow_start", agent: "maint", intent: { workflow: "inspect", inputs: { unit: "4B" } } });
    const { proposal: applied, run } = await new ProposalService(starter).apply(member("boss", "admin"), proposal!.id);
    expect(applied).toMatchObject({ status: "applied", startedRun: run?.id });
    expect(run).toMatchObject({ start: { kind: "proposal", userId: "boss", agentId: "maint" } });
  });

  it("declines with the tool's reply when it is deny, and asks for what is missing", async () => {
    const denied = await setup("deny");
    expect(await startFromAgentTool(denied.starter, { agent: denied.agent, tool: denied.tool, inputs: {} })).toEqual({
      outcome: "declined",
      reply: "Inspections are booked by the office.",
    });
    const auto = await setup("auto");
    const missing = await startFromAgentTool(auto.starter, { agent: auto.agent, tool: auto.tool, inputs: {} });
    expect(missing).toMatchObject({ outcome: "needs_input", missing: [{ name: "unit" }] });
  });

  it("refuses to run the same workflow twice at once", async () => {
    const { f, starter } = await setup("auto");
    const leases = new MemoryLeaseLock(() => f.clock.now);
    await leases.acquire("workflow:inspect", "other", 60_000);
    await expect(startWorkflow({ ...starter, leases }, (await f.env.store.get("inspect"))!, { kind: "manual" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("the think step", () => {
  it("thinks with the workflow's prompt and never the agent's reply prompt, and its changes wait for a person", async () => {
    const llm = fakeLlm([{ args: { entity: "work_order", change: "update", id: "2", values: [{ field: "priority", value: "high" }], reason: "Costly and open." } }]);
    const f = fake({ llm });
    f.rows = ORDERS;
    f.agents.set("maint", agentOf());
    const workflow = workflowOf({
      trigger: { kind: "agent", inputs: [] },
      source: { connection: "pms", record: "work_order" },
      once: "per-run",
      steps: [{ id: "t", kind: "think", prompt: "Raise the priority of costly open orders." }],
    });
    await f.env.store.put(workflow);
    const { run } = await runWorkflow(f.env, workflow, { start: { kind: "agent", agentId: "maint" } });
    const sent = llm.calls[0]!.messages.map((one) => one.content).join("\n");
    expect(sent).toContain("Raise the priority of costly open orders.");
    expect(sent).not.toContain("SECRET-ROLE");
    expect(sent).not.toContain("SECRET-INSTRUCTIONS");
    expect(llm.calls[0]!.toolNames).not.toContain("commit");
    expect(run.outputs[0]).toMatchObject({ kind: "think", outcome: "proposed" });
    expect(f.committed).toHaveLength(0);
    expect((await f.env.proposals.list())[0]).toMatchObject({ agent: "maint", reason: "Costly and open.", intent: { values: { priority: "high" } } });
  });
});
