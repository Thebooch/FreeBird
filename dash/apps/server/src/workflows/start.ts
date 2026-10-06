import type { LeaseLock } from "@freebirdai/connect/host";
import type { AgentSpec, AgentTool, Principal, Proposal, WorkflowInputDef, WorkflowRun, WorkflowSpec, WorkflowStart } from "@freebirdai/dash-spec";
import type { WorkflowEnv } from "./env.js";
import type { ExecutorRegistry } from "./executors.js";
import { runWorkflow, type RunResult } from "./run.js";

/**
 * The one way a workflow starts, whatever starts it: the runner (time, an
 * API), a person's "Run now", an agent's tool, or a person applying an
 * agent's request to start one. It records who or what started the run, and
 * takes the workflow's lease so two servers — or the runner and a person —
 * never run the same workflow at once.
 */

export interface Starter {
  readonly env: WorkflowEnv;
  /** Shared between servers when several use one database; absent, this server does all of it. */
  readonly leases?: LeaseLock | undefined;
  /** This server, among any others. */
  readonly holder: string;
  readonly executors?: ExecutorRegistry | undefined;
}

/** How long a run may hold its workflow before another server may take it. */
export const RUN_LEASE_MS = 10 * 60_000;

export class StartError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StartError";
  }
}

export const leaseKey = (workflow: string): string => `workflow:${workflow}`;

export const startWorkflow = async (
  starter: Starter,
  workflow: WorkflowSpec,
  start: WorkflowStart,
  options: { readonly inputs?: Readonly<Record<string, unknown>>; readonly actor?: Principal | null } = {},
): Promise<RunResult> => {
  const key = leaseKey(workflow.id);
  if (starter.leases && !(await starter.leases.acquire(key, starter.holder, RUN_LEASE_MS))) {
    throw new StartError(`"${workflow.name}" is already running.`, 409);
  }
  try {
    return await runWorkflow(starter.env, workflow, {
      start,
      ...(options.inputs ? { inputs: options.inputs } : {}),
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
      ...(starter.executors ? { executors: starter.executors } : {}),
    });
  } finally {
    await starter.leases?.release(key, starter.holder);
  }
};

/* ── started by an agent ───────────────────────────────────────────────── */

/** The parameters an agent's tool takes for a workflow: its trigger's inputs. */
export const workflowToolInputs = (workflow: WorkflowSpec): readonly WorkflowInputDef[] =>
  workflow.trigger.kind === "agent" ? workflow.trigger.inputs : [];

/**
 * What came of an agent using a `run_workflow` tool — what the agent tells
 * the person next.
 *
 * - `started`: the tool is auto; the run happened. The agent says it is done or underway.
 * - `approval`: the tool is approve; a request went to the team. The agent
 *   says the team will look into it.
 * - `declined`: the tool is deny. The agent answers with the tool's reply.
 * - `needs_input`: something the workflow needs was not given. The agent asks for it.
 * - `unavailable`: the workflow is gone, off or paused. The agent hands the request to the team.
 */
export type AgentToolOutcome =
  | { readonly outcome: "started"; readonly run: WorkflowRun }
  | { readonly outcome: "approval"; readonly proposal: Proposal }
  | { readonly outcome: "declined"; readonly reply: string }
  | { readonly outcome: "needs_input"; readonly missing: readonly WorkflowInputDef[] }
  | { readonly outcome: "unavailable"; readonly reason: string };

export const startFromAgentTool = async (
  starter: Starter,
  request: {
    readonly agent: AgentSpec;
    readonly tool: AgentTool;
    readonly inputs?: Readonly<Record<string, unknown>>;
    readonly conversation?: string;
  },
): Promise<AgentToolOutcome> => {
  const { env } = starter;
  const { agent, tool } = request;
  if (tool.kind !== "run_workflow" || !tool.workflow || !tool.enabled || agent.archived || !agent.tools.some((one) => one.id === tool.id)) {
    return { outcome: "unavailable", reason: "That tool is not one this agent has." };
  }
  if (tool.mode === "deny") return { outcome: "declined", reply: tool.denyReply };

  const workflow = await env.store.get(tool.workflow);
  if (!workflow || workflow.trigger.kind !== "agent") return { outcome: "unavailable", reason: "The workflow it starts is gone, or cannot be started by an agent." };

  const given = request.inputs ?? {};
  const missing = workflowToolInputs(workflow).filter((one) => one.required && (given[one.name] === undefined || given[one.name] === null || given[one.name] === ""));
  if (missing.length > 0) return { outcome: "needs_input", missing };
  /* Only what the workflow asks for: a conversation cannot slip in anything else. */
  const known = new Set(workflowToolInputs(workflow).map((one) => one.name));
  const inputs = Object.fromEntries(Object.entries(given).filter(([name]) => known.has(name)));

  if (tool.mode === "approve") {
    const proposal: Proposal = {
      id: env.newId(),
      kind: "workflow_start",
      agent: agent.id,
      workflow: workflow.id,
      ...(request.conversation ? { conversation: request.conversation } : {}),
      intent: { workflow: workflow.id, inputs },
      title: `Start "${workflow.name}"${Object.keys(inputs).length > 0 ? ` (${Object.entries(inputs).map(([name, value]) => `${name}: ${String(value)}`).join(", ")})` : ""}`,
      reason: `${agent.name} asked to start it.`,
      status: "waiting",
      createdAt: new Date(env.now()).toISOString(),
    };
    await env.proposals.put(proposal);
    env.onEvent?.({ type: "proposal.created", proposal: proposal.id, kind: proposal.kind, workflow: workflow.id, agent: agent.id });
    return { outcome: "approval", proposal };
  }

  if (!workflow.enabled || workflow.parked) return { outcome: "unavailable", reason: workflow.parked?.reason ?? `"${workflow.name}" is turned off.` };
  const { run } = await startWorkflow(starter, workflow, { kind: "agent", agentId: agent.id, ...(request.conversation ? { conversation: request.conversation } : {}) }, { inputs });
  return { outcome: "started", run };
};
