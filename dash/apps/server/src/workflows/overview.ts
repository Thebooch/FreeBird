import {
  WORKFLOW_STEP_INFO,
  describeTrigger,
  isWatchedTrigger,
  type AgentSpec,
  type Proposal,
  type WorkflowRun,
  type WorkflowSpec,
} from "@freebirdai/dash-spec";
import type { WorkflowEnv } from "./env.js";
import { nextDue } from "./schedule.js";
import { RUN_LEASE_MS } from "./start.js";

/**
 * The Agent side's Overview: what is going on, and what has been done.
 *
 * - **Active**: every workflow that is on, or that something is waiting on —
 *   what stage it is at, and what it is waiting for: a person's approval, the
 *   next check, an agent to be asked, or somebody to turn it back on.
 * - **Completed**: every task done, newest first — each step a run did, and
 *   each proposal a person applied.
 *
 * Each item names its workflow, its agent where there is one, and its task
 * (the kind of step), which are what the Overview filters by.
 */

export type ActiveState = "running" | "waiting_approval" | "waiting_schedule" | "waiting_trigger" | "waiting_agent" | "paused";

export interface ActiveWorkflow {
  readonly workflow: string;
  readonly name: string;
  /** The agents involved: whose tools start it, or who started its latest run. */
  readonly agents: readonly string[];
  readonly state: ActiveState;
  /** Where it is, in words: "Step 2 of 3: Change a record, record 14 of 40". */
  readonly stage: string;
  /** What it is waiting for, in words. */
  readonly waitingFor: string;
  /** The kinds of step it has: its tasks. */
  readonly tasks: readonly string[];
  /** Proposals waiting on a person. */
  readonly waiting: number;
  readonly since?: string | undefined;
  /** When it next starts by itself, for a time or API trigger. */
  readonly nextAt?: string | undefined;
  readonly run?: string | undefined;
}

export interface CompletedTask {
  readonly id: string;
  readonly at: string;
  /** The kind of step, or `approval` for a proposal a person applied. */
  readonly task: string;
  readonly title: string;
  readonly workflow?: string | undefined;
  readonly workflowName?: string | undefined;
  readonly agent?: string | undefined;
  readonly run?: string | undefined;
  /** Who applied it, for an approval. */
  readonly by?: string | undefined;
}

export interface Overview {
  readonly active: readonly ActiveWorkflow[];
  readonly completed: readonly CompletedTask[];
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const stageOf = (run: WorkflowRun, workflow: WorkflowSpec | undefined): string => {
  const stage = run.stage;
  if (!stage) return "Reading";
  const label = WORKFLOW_STEP_INFO[stage.kind as keyof typeof WORKFLOW_STEP_INFO]?.label ?? stage.kind;
  const row = stage.rowIndex !== undefined && stage.rows !== undefined ? `, record ${stage.rowIndex} of ${stage.rows}` : "";
  return `Step ${stage.index} of ${stage.of || workflow?.steps.length || stage.index}: ${label}${row}`;
};

const when = (at: number): string => new Date(at).toISOString();

export const buildOverview = async (
  env: WorkflowEnv,
  options: { readonly agents: readonly AgentSpec[]; readonly limit?: number },
): Promise<Overview> => {
  const now = env.now();
  const [workflows, runs, waiting, applied] = await Promise.all([
    env.store.list(),
    env.store.runs({ limit: options.limit ?? 200 }),
    env.proposals.list({ status: "waiting", limit: 500 }),
    env.proposals.list({ status: "applied", limit: options.limit ?? 200 }),
  ]);
  const byId = new Map(workflows.map((one) => [one.id, one]));
  const startedBy = (id: string) => options.agents.filter((agent) => agent.tools.some((tool) => tool.kind === "run_workflow" && tool.workflow === id));
  const waitingFor = (id: string): Proposal[] => waiting.filter((one) => one.workflow === id);

  const active: ActiveWorkflow[] = [];
  for (const workflow of workflows) {
    const latest = runs.find((run) => run.workflow === workflow.id);
    const pending = waitingFor(workflow.id);
    const agents = [...new Set([...startedBy(workflow.id).map((agent) => agent.id), ...(latest?.agent ? [latest.agent] : []), ...pending.flatMap((one) => (one.agent ? [one.agent] : []))])];
    const tasks = [...new Set(workflow.steps.map((step) => step.kind))];
    const base = { workflow: workflow.id, name: workflow.name, agents, tasks, waiting: pending.length };

    /* A run still going, unless it has gone quiet for longer than its lease: then it was interrupted. */
    if (latest?.status === "running" && now - Date.parse(latest.startedAt) < RUN_LEASE_MS) {
      active.push({ ...base, state: "running", stage: stageOf(latest, workflow), waitingFor: "Its current step to finish", since: latest.startedAt, run: latest.id });
      continue;
    }
    if (pending.length > 0) {
      const first = pending[pending.length - 1]!;
      active.push({
        ...base,
        state: "waiting_approval",
        stage: `${plural(pending.length, "item")} proposed`,
        waitingFor: `Your approval: ${pending.length === 1 ? first.title : plural(pending.length, "item")} in Waiting for you`,
        since: first.createdAt,
        ...(latest ? { run: latest.id } : {}),
      });
      continue;
    }
    if (!workflow.enabled) continue;
    if (workflow.parked) {
      active.push({ ...base, state: "paused", stage: "Paused", waitingFor: `Somebody to turn it back on: ${workflow.parked.reason}`, since: workflow.parked.at });
      continue;
    }
    const lastDone = latest ? `Last run: ${latest.status === "seeded" ? "took note of what exists" : (latest.summary || latest.status)}` : "Not run yet";
    if (isWatchedTrigger(workflow.trigger)) {
      const next = nextDue(workflow.trigger, latest ? Date.parse(latest.startedAt) : null, Date.parse(workflow.updatedAt));
      const api = workflow.trigger.kind === "record_created" || workflow.trigger.kind === "record_changed";
      active.push({
        ...base,
        state: api ? "waiting_trigger" : "waiting_schedule",
        stage: lastDone,
        waitingFor: api ? describeTrigger(workflow.trigger) : `Its schedule: ${describeTrigger(workflow.trigger)}`,
        ...(next !== null ? { nextAt: when(Math.max(next, now)) } : {}),
        ...(latest ? { since: latest.finishedAt ?? latest.startedAt, run: latest.id } : {}),
      });
      continue;
    }
    if (workflow.trigger.kind === "agent") {
      const names = startedBy(workflow.id).map((agent) => agent.name);
      active.push({
        ...base,
        state: "waiting_agent",
        stage: lastDone,
        waitingFor: names.length > 0 ? `${names.join(" or ")} to be asked` : "An agent to be given a tool that starts it",
        ...(latest ? { since: latest.finishedAt ?? latest.startedAt, run: latest.id } : {}),
      });
      continue;
    }
    /* By hand, and on: waiting for somebody to press Run now. */
    active.push({ ...base, state: "waiting_trigger", stage: lastDone, waitingFor: "Somebody to press Run now", ...(latest ? { run: latest.id } : {}) });
  }

  /* Steps of one run share its finish time; the later step is the newer task. */
  const completed: Array<CompletedTask & { readonly order: number }> = [];
  for (const run of runs) {
    run.outputs.forEach((output, index) => {
      if (output.outcome !== "done") return;
      completed.push({
        id: `${run.id}:${index}`,
        order: index,
        at: run.finishedAt ?? run.startedAt,
        task: output.kind,
        title: output.detail,
        workflow: run.workflow,
        workflowName: run.workflowName,
        ...(run.agent ? { agent: run.agent } : {}),
        run: run.id,
      });
    });
  }
  for (const proposal of applied) {
    completed.push({
      id: `approval:${proposal.id}`,
      order: 0,
      at: proposal.decidedAt ?? proposal.createdAt,
      task: "approval",
      title: `Approved: ${proposal.title}`,
      ...(proposal.workflow ? { workflow: proposal.workflow, workflowName: byId.get(proposal.workflow)?.name ?? proposal.workflow } : {}),
      ...(proposal.agent ? { agent: proposal.agent } : {}),
      ...(proposal.run ? { run: proposal.run } : {}),
      ...(proposal.decidedBy ? { by: proposal.decidedBy } : {}),
    });
  }
  completed.sort((a, b) => b.at.localeCompare(a.at) || b.order - a.order);

  /* Running first, then what waits on a person, then the rest by name. */
  const order: Readonly<Record<ActiveState, number>> = { running: 0, waiting_approval: 1, paused: 2, waiting_schedule: 3, waiting_trigger: 3, waiting_agent: 3 };
  active.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  return { active, completed: completed.slice(0, options.limit ?? 200).map(({ order: _order, ...task }) => task) };
};
