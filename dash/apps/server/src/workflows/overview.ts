import { describeTrigger, isWatchedTrigger, nodeName, type AgentSpec, type Task, type WorkflowCase, type WorkflowSpec } from "@freebirdai/dash-spec";
import type { WorkflowEnv } from "./env.js";
import { nextDue } from "./schedule.js";

/**
 * The Agent side's Overview: what is going on, and what has been done.
 *
 * - **Active**: each workflow that is on or has open cases: how many cases are
 *   where, and what each is waiting for — an approval, an answer, a reply, a
 *   time, a change — or, with none open, what starts the next one.
 * - **Completed**: every task done, newest first.
 *
 * Each item names its workflow, its agents and its tasks (kinds of step),
 * which are what the Overview filters by.
 */

export type ActiveState = "running" | "waiting_approval" | "waiting" | "waiting_schedule" | "waiting_trigger" | "waiting_agent" | "paused";

export interface ActiveCase {
  readonly id: string;
  readonly rowKey?: string | undefined;
  readonly status: string;
  readonly step?: string | undefined;
  readonly waitingFor?: string | undefined;
  readonly deadline?: string | undefined;
  readonly since: string;
}

export interface ActiveWorkflow {
  readonly workflow: string;
  readonly name: string;
  readonly agents: readonly string[];
  readonly state: ActiveState;
  readonly stage: string;
  readonly waitingFor: string;
  /** The kinds of step it has. */
  readonly tasks: readonly string[];
  /** Tasks waiting on a person's approval. */
  readonly waiting: number;
  readonly cases: readonly ActiveCase[];
  readonly since?: string | undefined;
  readonly nextAt?: string | undefined;
}

export interface CompletedTask {
  readonly id: string;
  readonly at: string;
  /** The kind of step (`base`), or `approval` when a person approved it. */
  readonly task: string;
  readonly action: string;
  readonly title: string;
  readonly status: string;
  readonly workflow?: string | undefined;
  readonly workflowName?: string | undefined;
  readonly agent?: string | undefined;
  readonly case?: string | undefined;
  readonly by?: string | undefined;
  readonly reversible: boolean;
}

export interface Overview {
  readonly active: readonly ActiveWorkflow[];
  readonly completed: readonly CompletedTask[];
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const WAIT_WORDS: Readonly<Record<string, string>> = {
  approval: "your approval",
  ask: "a teammate's answer",
  time: "a time to come",
  reply: "a reply",
  record_change: "a record to change",
  decision: "an answer",
  workflow_done: "another workflow to finish",
  webhook: "a call to its webhook",
};

const caseWaits = (one: WorkflowCase): string => (one.waiting ? (WAIT_WORDS[one.waiting.kind] ?? one.waiting.kind) : "");

export const buildOverview = async (env: WorkflowEnv, options: { readonly agents: readonly AgentSpec[]; readonly limit?: number }): Promise<Overview> => {
  const now = env.now();
  const [workflows, open, waitingCases, approvals, finished] = await Promise.all([
    env.store.list(),
    env.cases.list({ status: "running", limit: 1000 }),
    env.cases.list({ status: "waiting", limit: 1000 }),
    env.tasks.list({ status: "waiting_approval", limit: 1000 }),
    env.tasks.list({ limit: options.limit ?? 300 }),
  ]);
  const startedBy = (id: string) => options.agents.filter((agent) => agent.tools.some((tool) => tool.kind === "run_workflow" && tool.workflow === id)).map((agent) => agent.id);

  const active: ActiveWorkflow[] = [];
  for (const workflow of workflows) {
    const cases = [...open, ...waitingCases].filter((one) => one.workflow === workflow.id);
    const asking = approvals.filter((task) => task.workflow === workflow.id);
    const agents = [...new Set([...startedBy(workflow.id), ...cases.flatMap((one) => (one.agent ? [one.agent] : [])), ...asking.flatMap((task) => (task.agent ? [task.agent] : []))])];
    const tasks = [...new Set(workflow.nodes.map((node) => node.action.split(".")[0]!))];
    const listed: ActiveCase[] = cases.map((one) => {
      const node = workflow.nodes.find((each) => each.id === (one.waiting?.node ?? one.at));
      return {
        id: one.id,
        ...(one.rowKey ? { rowKey: one.rowKey } : {}),
        status: one.status,
        ...(node ? { step: nodeName(node) } : {}),
        ...(one.status === "waiting" ? { waitingFor: caseWaits(one) } : {}),
        ...(one.waiting?.deadline ? { deadline: one.waiting.deadline } : {}),
        since: one.updatedAt,
      };
    });
    const base = { workflow: workflow.id, name: workflow.name, agents, tasks, waiting: asking.length, cases: listed };

    if (cases.length > 0 || asking.length > 0) {
      const byWait = new Map<string, number>();
      for (const one of cases) {
        const key = one.status === "running" ? "running" : caseWaits(one);
        byWait.set(key, (byWait.get(key) ?? 0) + 1);
      }
      const running = byWait.get("running") ?? 0;
      const firstStep = listed[0]?.step;
      const state: ActiveState = running > 0 ? "running" : asking.length > 0 ? "waiting_approval" : "waiting";
      const waitParts = [...byWait].filter(([key]) => key !== "running").map(([key, count]) => `${key} (${count})`);
      const soonest = cases.map((one) => one.waiting?.deadline).filter((one): one is string => Boolean(one)).sort()[0];
      active.push({
        ...base,
        state,
        stage: `${plural(cases.length || asking.length, "case")} open${cases.length === 1 && firstStep ? `, at ${firstStep}` : ""}`,
        waitingFor: running > 0 && waitParts.length === 0 ? "Its current steps to finish" : waitParts.length > 0 ? waitParts.join(", ") : `Your approval (${asking.length})`,
        since: cases.map((one) => one.updatedAt).sort()[0] ?? asking[0]?.createdAt,
        ...(soonest ? { nextAt: soonest } : {}),
      });
      continue;
    }
    if (!workflow.enabled) continue;
    if (workflow.parked) {
      active.push({ ...base, state: "paused", stage: "Paused", waitingFor: `Somebody to turn it back on: ${workflow.parked.reason}`, since: workflow.parked.at });
      continue;
    }
    const [latest] = await env.store.runs({ workflow: workflow.id, limit: 1 });
    const lastDone = latest ? `Last run: ${latest.status === "seeded" ? "took note of what exists" : latest.summary || latest.status}` : "Not run yet";
    if (isWatchedTrigger(workflow.trigger)) {
      const next = nextDue(workflow.trigger, latest ? Date.parse(latest.startedAt) : null, Date.parse(workflow.updatedAt));
      const api = workflow.trigger.kind === "record_created" || workflow.trigger.kind === "record_changed";
      active.push({
        ...base,
        state: api ? "waiting_trigger" : "waiting_schedule",
        stage: lastDone,
        waitingFor: api ? describeTrigger(workflow.trigger) : `Its schedule: ${describeTrigger(workflow.trigger)}`,
        ...(next !== null ? { nextAt: new Date(Math.max(next, now)).toISOString() } : {}),
        ...(latest ? { since: latest.finishedAt ?? latest.startedAt } : {}),
      });
      continue;
    }
    if (workflow.trigger.kind === "agent") {
      const names = options.agents.filter((agent) => startedBy(workflow.id).includes(agent.id)).map((agent) => agent.name);
      active.push({ ...base, state: "waiting_agent", stage: lastDone, waitingFor: names.length > 0 ? `${names.join(" or ")} to be asked` : "An agent to be given a tool that starts it" });
      continue;
    }
    active.push({ ...base, state: "waiting_trigger", stage: lastDone, waitingFor: "Somebody to press Run now" });
  }

  /* Agents' requests to start a workflow are approvals with no case. */
  const order: Readonly<Record<ActiveState, number>> = { running: 0, waiting_approval: 1, waiting: 2, paused: 3, waiting_schedule: 4, waiting_trigger: 4, waiting_agent: 4 };
  active.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));

  const completed: CompletedTask[] = finished
    .filter((task: Task) => task.status === "done" || task.status === "reversed")
    .map((task) => ({
      id: task.id,
      at: task.finishedAt ?? task.createdAt,
      task: task.approvedBy && task.action !== "ask.approve" ? "approval" : task.base,
      action: task.action,
      title: task.title,
      status: task.status,
      ...(task.workflow ? { workflow: task.workflow } : {}),
      ...(task.workflowName ? { workflowName: task.workflowName } : {}),
      ...(task.agent ? { agent: task.agent } : {}),
      ...(task.case ? { case: task.case } : {}),
      ...(task.approvedBy ? { by: task.approvedBy } : {}),
      reversible: task.status === "done" && Boolean(task.reversal?.available),
    }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  return { active, completed };
};
