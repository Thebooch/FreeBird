import type { WriteIntent, WriteReview } from "@freebirdai/connect";
import type { ReadRequest, ReadResult } from "@freebirdai/connect/host";
import { MemoryLeaseLock } from "@freebirdai/connect/host";
import type { fakeLlm } from "@freebirdai/dash-agent";
import { agentSchema, chainEdges, workflowSchema, type AgentSpec, type Principal, type WorkflowNode, type WorkflowSpec } from "@freebirdai/dash-spec";
import type { Policy } from "../identity/policy.js";
import { WorkflowEngine } from "./engine.js";
import type { OutreachSender, WorkflowEnv } from "./env.js";
import { startWorkflow, type Starter } from "./start.js";
import { MemoryCalendarStore, MemoryCaseStore, MemorySignalStore, MemoryTaskStore, MemoryTemplateStore, MemoryWorkflowStore } from "./store.js";
import { TaskService } from "./tasks.js";

/**
 * Workflows without a server: fake reads, a fake write service that records
 * what it was asked and says how to undo it, and a clock the test moves.
 */

export const T0 = Date.parse("2026-10-06T12:00:00.000Z");
export const owner: Principal = { userId: "local", workspaceId: "acme", role: "owner", kind: "local-owner" };
export const member = (userId: string, role: Principal["role"]): Principal => ({ userId, workspaceId: "acme", role, kind: "member" });
export const at = new Date(T0).toISOString();

export interface Fake {
  env: WorkflowEnv;
  starter: Starter;
  engine: WorkflowEngine;
  tasks: TaskService;
  clock: { now: number };
  rows: Record<string, unknown>[];
  prepared: Array<{ principal: Principal; intent: WriteIntent; via: string; onBehalfOf?: unknown }>;
  committed: string[];
  agents: Map<string, AgentSpec>;
  sent: Array<{ channel: string; to: string; text: string; key: string }>;
  failRead: Error | null;
  failCommit: Error | null;
  /** Whether reads reach every record. */
  complete: boolean;
  reads: ReadRequest[];
  posts: Array<{ url: string; body: unknown; key?: string }>;
  /** What a webhook answers: a status, or an error thrown. */
  postAnswer: number | Error;
}

export const fake = (options: { policy?: Policy; llm?: ReturnType<typeof fakeLlm>; sender?: boolean; leases?: boolean } = {}): Fake => {
  let id = 0;
  const intents = new Map<string, WriteIntent>();
  const state = {
    clock: { now: T0 },
    rows: [] as Record<string, unknown>[],
    prepared: [] as Fake["prepared"],
    committed: [] as string[],
    agents: new Map<string, AgentSpec>(),
    sent: [] as Fake["sent"],
    failRead: null as Error | null,
    failCommit: null as Error | null,
    complete: true,
    reads: [] as ReadRequest[],
    posts: [] as Fake["posts"],
    postAnswer: 200 as number | Error,
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
      summary: `Change ${intent.entity} ${intent.id ?? ""}`.trim(),
      rows: Object.entries(intent.values ?? {}).map(([field, value]) => ({ field, label: field, before: "old", after: String(value), changed: true })),
      warnings: [],
      danger: false,
      unverified: false,
      inferred: false,
      expiresAt: new Date(state.clock.now + 600_000).toISOString(),
    }) as unknown as WriteReview;
  const sender: OutreachSender = {
    send: async (message) => {
      if (!state.sent.some((one) => one.key === message.key)) state.sent.push({ channel: message.channel, to: message.to, text: message.text, key: message.key });
      return { status: "sent", conversation: `conv-${message.key}` };
    },
  };
  const env: WorkflowEnv = {
    workspaceId: "acme",
    store: new MemoryWorkflowStore(),
    cases: new MemoryCaseStore(),
    tasks: new MemoryTaskStore(),
    calendar: new MemoryCalendarStore(),
    templates: new MemoryTemplateStore(),
    signals: new MemorySignalStore(),
    agents: { get: async (agentId) => state.agents.get(agentId) ?? null },
    policy: options.policy ?? { can: () => ({ ok: true }) },
    read: async (_connection, request: ReadRequest): Promise<ReadResult> => {
      state.reads.push(request);
      if (state.failRead) throw state.failRead;
      return { rows: state.rows.map((row) => ({ ...row })), body: state.rows, op: "work_orders", cache: "miss", ageMs: 0, warnings: [], complete: state.complete, pages: 1, progress: null, changed: null };
    },
    writes: {
      prepare: async (principal, intent, how) => {
        state.prepared.push({ principal, intent, via: how.via, ...(how.onBehalfOf ? { onBehalfOf: how.onBehalfOf } : {}) });
        const pendingId = `p${state.prepared.length}`;
        intents.set(pendingId, intent);
        return review(intent, pendingId);
      },
      commit: async (_principal, pendingId) => {
        if (state.failCommit) {
          const error = state.failCommit;
          state.failCommit = null;
          throw error;
        }
        state.committed.push(pendingId);
        const intent = intents.get(pendingId)!;
        return {
          status: "succeeded",
          connection: intent.connection,
          entity: intent.entity,
          kind: intent.kind,
          ...(intent.id ? { key: { id: intent.id } } : {}),
          changed: Object.keys(intent.values ?? {}),
          invalidated: { connection: intent.connection, ops: [] },
          title: "Update a work order",
          eventId: pendingId,
          ...(intent.kind === "update" ? { reversal: { kind: "update" as const, values: Object.fromEntries(Object.keys(intent.values ?? {}).map((key) => [key, "old"])) } } : {}),
        };
      },
      discard: () => undefined,
    },
    ...(options.sender ? { outreach: sender } : {}),
    post: async (url, body, how) => {
      state.posts.push({ url, body, ...(how?.key ? { key: how.key } : {}) });
      if (state.postAnswer instanceof Error) throw state.postAnswer;
      return { status: state.postAnswer, body: {} };
    },
    connectionTitle: (connection) => (connection === "pms" ? "Property system" : connection),
    ...(options.llm ? { llm: () => options.llm! } : {}),
    now: () => state.clock.now,
    newId: () => `id${++id}`,
  };
  const leases = options.leases ? new MemoryLeaseLock(() => state.clock.now) : undefined;
  const engine = new WorkflowEngine({ env, holder: "me", ...(leases ? { leases } : {}) });
  const starter: Starter = { env, engine, holder: "me", ...(leases ? { leases } : {}) };
  return Object.assign(state, { env, engine, starter, tasks: new TaskService(starter) }) as Fake;
};

export const node = (id: string, action: string, settings: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, action, settings, mode: "auto", onFailure: "stop", reversible: true, position: { x: 0, y: 0 }, ...extra }) as WorkflowNode;

export const workflowOf = (fields: Record<string, unknown>): WorkflowSpec => {
  const nodes = (fields["nodes"] as WorkflowNode[] | undefined) ?? [];
  return workflowSchema.parse({ id: "wf", name: "Work orders", enabled: true, enabledBy: owner, createdAt: at, updatedAt: at, edges: chainEdges(nodes), ...fields });
};

export const agentOf = (fields: Record<string, unknown> = {}): AgentSpec =>
  agentSchema.parse({
    id: "maint",
    name: "Maintenance agent",
    color: 2,
    role: "You are the SECRET-ROLE maintenance coordinator.",
    reach: [
      { permission: "records.read", scope: { connection: "pms" } },
      { permission: "records.update", scope: { connection: "pms" } },
    ],
    createdAt: at,
    updatedAt: at,
    ...fields,
  });

export const ORDERS = [
  { id: 1, status: "open", cost: 120, unit: "1A", phone: "+15550001" },
  { id: 2, status: "open", cost: 900, unit: "2B", phone: "+15550002" },
  { id: 3, status: "closed", cost: 50, unit: "3C", phone: "+15550003" },
];

export const source = { connection: "pms", record: "work_order" };
export const every = { kind: "every", every: "1h" } as const;
export const run = (f: Fake, workflow: WorkflowSpec) => startWorkflow(f.starter, workflow, { kind: "every" });
export const byHand = (f: Fake, workflow: WorkflowSpec) => startWorkflow(f.starter, workflow, { kind: "manual" }, { actor: owner });
