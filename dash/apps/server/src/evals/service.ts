import { verdictsByDimension, type AgentSpec, type EvalRun, type Principal, type RunEvent, type ScenarioInput, type WorkflowSpec } from "@freebirdai/dash-spec";
import type { WorkflowEnv } from "../workflows/env.js";
import { DEFAULT_CLEAN_CASES, graduate, graduationOf, type StepGraduation } from "../workflows/graduation.js";
import { ScenarioError, ScenarioSession } from "./runner.js";
import type { EvalRunStore } from "./store.js";
import { packForWorkflow } from "./workflow-pack.js";

/**
 * Evals in the product: the Test button's sessions, the runs it keeps, the
 * Evals tab's history, and the graduation rule. One place for the routes and,
 * later, the chat.
 */

export class EvalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EvalError";
  }
}

export interface EvalServiceDeps {
  readonly env: WorkflowEnv;
  readonly runs: EvalRunStore;
  /** Clean trial cases a step needs before Dash proposes Auto. */
  readonly cleanCases?: number;
}

/** A session being stepped, and who is watching it. */
interface Live {
  readonly session: ScenarioSession;
  readonly workflow: string;
  readonly by: string;
  readonly listeners: Set<(event: RunEvent) => void>;
  touched: number;
}

/** Sessions kept at once per workspace, and how long one may sit untouched. */
const MAX_SESSIONS = 20;
const IDLE_MS = 30 * 60_000;

/** The agents a workflow's steps act for. */
const agentIdsOf = (workflow: WorkflowSpec): string[] => [
  ...new Set(workflow.nodes.flatMap((node) => [node.agentId, typeof node.settings["agentId"] === "string" ? node.settings["agentId"] : undefined]).filter((id): id is string => Boolean(id))),
];

export class EvalService {
  private readonly live = new Map<string, Live>();

  constructor(private readonly deps: EvalServiceDeps) {}

  /** The scenarios Dash offers this workflow. */
  async pack(workflowId: string): Promise<ScenarioInput[]> {
    const workflow = await this.workflow(workflowId);
    return packForWorkflow(workflow, await this.agentsOf(workflow));
  }

  /** Starts a session on one of the workflow's scenarios (the first by default). Nothing has played yet. */
  async start(principal: Principal, workflowId: string, scenarioId?: string): Promise<{ readonly id: string; readonly scenario: { readonly id: string; readonly name: string }; readonly turns: number; readonly events: RunEvent[] }> {
    const pack = await this.pack(workflowId);
    const input = scenarioId ? pack.find((one) => one.id === scenarioId) : pack[0];
    if (!input) throw new EvalError(scenarioId ? `This workflow has no scenario "${scenarioId}".` : "Dash has no scenarios for what starts this workflow yet.", 404);
    this.sweep();
    if (this.live.size >= MAX_SESSIONS) throw new EvalError("Too many tests are open. Finish one, or wait a few minutes.", 429);
    const id = `eval-${this.deps.env.newId()}`;
    const listeners = new Set<(event: RunEvent) => void>();
    let session: ScenarioSession;
    try {
      session = await ScenarioSession.start(input, { id, onEvent: (event) => listeners.forEach((listener) => listener(event)) });
    } catch (error) {
      if (error instanceof ScenarioError) throw new EvalError(error.message, 400);
      throw error;
    }
    this.live.set(id, { session, workflow: workflowId, by: principal.userId, listeners, touched: this.deps.env.now() });
    return { id, scenario: { id: session.scenario.id, name: session.scenario.name }, turns: session.remaining, events: [...session.events] };
  }

  /** Plays the next turn. When none is left, scores everything, keeps the run and ends the session. */
  async step(id: string): Promise<{ readonly events: RunEvent[]; readonly remaining: number; readonly run?: EvalRun }> {
    const live = this.held(id);
    if (live.session.remaining > 0) {
      const events = await live.session.step();
      return { events, remaining: live.session.remaining };
    }
    const from = live.session.events.length;
    const run = await this.end(id, live);
    return { events: run.events.slice(from), remaining: 0, run };
  }

  /** Plays what is left and ends. */
  async finish(id: string): Promise<EvalRun> {
    return this.end(id, this.held(id));
  }

  /** The session's events from `since` on, and each new one as it is appended. Returns the unsubscribe. */
  watch(id: string, since: number, listener: (event: RunEvent) => void): () => void {
    const live = this.held(id);
    for (const event of live.session.events.slice(since)) listener(event);
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }

  stop(id: string): void {
    this.live.get(id)?.listeners.clear();
    this.live.delete(id);
  }

  /** Every scenario in the workflow's pack, played to the end and kept: the Test button without stepping. */
  async test(workflowId: string): Promise<EvalRun[]> {
    const pack = await this.pack(workflowId);
    if (pack.length === 0) throw new EvalError("Dash has no scenarios for what starts this workflow yet.", 404);
    const out: EvalRun[] = [];
    for (const input of pack) {
      const run = await (await ScenarioSession.start(input, { id: `eval-${this.deps.env.newId()}` })).finish();
      await this.deps.runs.put(run);
      out.push(run);
    }
    return out;
  }

  /** Kept runs, newest first: for a workflow, or for every workflow whose steps act for an agent. */
  async runs(filter: { readonly workflow?: string; readonly agent?: string; readonly limit?: number } = {}): Promise<EvalRun[]> {
    if (!filter.agent) return this.deps.runs.list({ ...(filter.workflow ? { workflow: filter.workflow } : {}), ...(filter.limit ? { limit: filter.limit } : {}) });
    const workflows = (await this.deps.env.store.list()).filter((one) => agentIdsOf(one).includes(filter.agent!)).map((one) => one.id);
    const all = await Promise.all(workflows.map((workflow) => this.deps.runs.list({ workflow, limit: filter.limit ?? 50 })));
    return all
      .flat()
      .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))
      .slice(0, filter.limit ?? 50);
  }

  run(id: string): Promise<EvalRun | null> {
    return this.deps.runs.get(id);
  }

  /** Each workflow version's latest runs by dimension: the Evals tab's trend. */
  async trend(filter: { readonly workflow?: string; readonly agent?: string }): Promise<Array<{ readonly workflow: string; readonly version: number; readonly at: string; readonly dimensions: ReturnType<typeof verdictsByDimension> }>> {
    const runs = await this.runs({ ...filter, limit: 200 });
    const byVersion = new Map<string, EvalRun[]>();
    for (const run of runs) {
      const workflow = "workflow" in run.target ? run.target.workflow : "";
      const key = `${workflow}@${run.targetVersion ?? 0}`;
      byVersion.set(key, [...(byVersion.get(key) ?? []), run]);
    }
    return [...byVersion.entries()]
      .map(([key, group]) => {
        const [workflow = "", version = "0"] = key.split("@");
        return { workflow, version: Number(version), at: group[0]!.finishedAt ?? group[0]!.startedAt, dimensions: verdictsByDimension(group.flatMap((run) => run.verdicts)) };
      })
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** How each outside step stands on leaving trial. */
  async graduation(workflowId: string): Promise<{ readonly enabled: boolean; readonly steps: StepGraduation[] }> {
    const workflow = await this.workflow(workflowId);
    const [runs, tasks] = await Promise.all([this.deps.runs.list({ workflow: workflow.id, limit: 50 }), this.deps.env.tasks.list({ workflow: workflow.id, limit: 1000 })]);
    return { enabled: this.deps.env.graduation === true, steps: graduationOf(workflow, runs, tasks, this.deps.cleanCases ?? DEFAULT_CLEAN_CASES) };
  }

  /** A person accepts Auto for a step that is ready. */
  async graduate(principal: Principal, workflowId: string, nodeId: string): Promise<WorkflowSpec> {
    if (!this.deps.env.graduation) throw new EvalError("Leaving trial on evidence is not turned on for this server (DASH_EVAL_GRADUATION).", 409);
    const workflow = await this.workflow(workflowId);
    const { steps } = await this.graduation(workflowId);
    try {
      return await graduate(this.deps.env, workflow, nodeId, principal, steps.find((one) => one.node === nodeId));
    } catch (error) {
      throw new EvalError(error instanceof Error ? error.message : String(error), 409);
    }
  }

  private async end(id: string, live: Live): Promise<EvalRun> {
    const run = await live.session.finish();
    await this.deps.runs.put(run);
    this.stop(id);
    return run;
  }

  private held(id: string): Live {
    const live = this.live.get(id);
    if (!live) throw new EvalError("This test has ended. Start it again.", 404);
    live.touched = this.deps.env.now();
    return live;
  }

  private sweep(): void {
    const now = this.deps.env.now();
    for (const [id, live] of this.live) if (now - live.touched > IDLE_MS) this.stop(id);
  }

  private async workflow(id: string): Promise<WorkflowSpec> {
    const workflow = await this.deps.env.store.get(id);
    if (!workflow) throw new EvalError(`There is no workflow "${id}".`, 404);
    return workflow;
  }

  private async agentsOf(workflow: WorkflowSpec): Promise<AgentSpec[]> {
    const found = await Promise.all(agentIdsOf(workflow).map((id) => this.deps.env.agents.get(id)));
    return found.filter((one): one is AgentSpec => one !== null);
  }
}
