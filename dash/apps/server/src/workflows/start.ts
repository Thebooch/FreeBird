import type { LeaseLock } from "@freebirdai/connect/host";
import type { AgentSpec, AgentTool, Principal, Task, WorkflowInputDef, WorkflowRun, WorkflowSpec, WorkflowStart } from "@freebirdai/dash-spec";
import type { WorkflowEngine } from "./engine.js";
import type { WorkflowEnv } from "./env.js";
import { runTrigger, type RunResult } from "./run.js";

/**
 * The one way a workflow's trigger fires, whatever fires it: the runner (time,
 * an API), a person's "Run now", an agent's tool, or a person approving an
 * agent's request. It records who or what started the run, and takes the
 * workflow's lease so two servers never run the same trigger at once.
 */

export interface Starter {
  readonly env: WorkflowEnv;
  readonly engine: WorkflowEngine;
  readonly leases?: LeaseLock | undefined;
  readonly holder: string;
}

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
  /* Each start is its own holder: a second start on the same server is refused like one on another. */
  const holder = `${starter.holder}:${starter.env.newId()}`;
  if (starter.leases && !(await starter.leases.acquire(key, holder, RUN_LEASE_MS))) {
    throw new StartError(`"${workflow.name}" is already running.`, 409);
  }
  try {
    return await runTrigger(starter.env, starter.engine, workflow, {
      start,
      ...(options.inputs ? { inputs: options.inputs } : {}),
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
    });
  } finally {
    await starter.leases?.release(key, holder);
  }
};

/** The parameters an agent's tool takes for a workflow: its trigger's inputs. */
export const workflowToolInputs = (workflow: WorkflowSpec): readonly WorkflowInputDef[] => (workflow.trigger.kind === "agent" ? workflow.trigger.inputs : []);

/**
 * What came of an agent using a `run_workflow` tool: what the agent tells the person next.
 *
 * - `started`: the tool is auto; the run happened. The agent says it is underway.
 * - `approval`: the tool is approve; a request went to the team.
 * - `declined`: the tool is deny. The agent answers with the tool's reply.
 * - `needs_input`: something the workflow needs was not given. The agent asks for it.
 * - `unavailable`: the workflow is gone, off or paused. The agent hands it to the team.
 */
export type AgentToolOutcome =
  | { readonly outcome: "started"; readonly run: WorkflowRun }
  | { readonly outcome: "approval"; readonly task: Task }
  | { readonly outcome: "declined"; readonly reply: string }
  | { readonly outcome: "needs_input"; readonly missing: readonly WorkflowInputDef[] }
  | { readonly outcome: "unavailable"; readonly reason: string };

export const startFromAgentTool = async (
  starter: Starter,
  request: { readonly agent: AgentSpec; readonly tool: AgentTool; readonly inputs?: Readonly<Record<string, unknown>>; readonly conversation?: string },
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
    const task: Task = {
      id: env.newId(),
      workflow: workflow.id,
      workflowName: workflow.name,
      action: "run_workflow.start",
      base: "run_workflow",
      title: `Start "${workflow.name}"${Object.keys(inputs).length > 0 ? ` (${Object.entries(inputs).map(([name, value]) => `${name}: ${String(value)}`).join(", ")})` : ""}`,
      status: "waiting_approval",
      body: { kind: "notice", text: `${agent.name} asked to start it.` },
      agent: agent.id,
      pending: { workflow: workflow.id, inputs, ...(request.conversation ? { conversation: request.conversation } : {}) },
      links: {},
      reason: `${agent.name} asked to start it.`,
      createdAt: new Date(env.now()).toISOString(),
    };
    await env.tasks.put(task);
    env.onEvent?.({ type: "task.waiting", task: task.id, workflow: workflow.id, agent: agent.id });
    return { outcome: "approval", task };
  }

  if (!workflow.enabled || workflow.parked) return { outcome: "unavailable", reason: workflow.parked?.reason ?? `"${workflow.name}" is turned off.` };
  const { run } = await startWorkflow(starter, workflow, { kind: "agent", agentId: agent.id, ...(request.conversation ? { conversation: request.conversation } : {}) }, { inputs });
  return { outcome: "started", run };
};
