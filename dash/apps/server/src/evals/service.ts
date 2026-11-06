import type { EmailAdapter } from "@freebirdai/core";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import { scenarioSchema, taskLabel, verdictsByDimension, type AgentSpec, type EvalRun, type Principal, type RunEvent, type ScenarioInput, type WorkflowSpec } from "@freebirdai/dash-spec";
import type { WorkflowEnv } from "../workflows/env.js";
import { DEFAULT_CLEAN_CASES, graduate, graduationOf, type StepGraduation } from "../workflows/graduation.js";
import { ScenarioError, ScenarioSession } from "./runner.js";
import type { Judge } from "./checks.js";
import { SaveError, scenarioFromTask } from "./from-task.js";
import { AGREEMENT_NEEDED, calibrate, calibrated, EXAMPLES_NEEDED, modelJudge, rubricKey, toneCheck, TONE_RUBRIC, type Calibration } from "./judge.js";
import { evalSettingsSchema, type EvalRunStore, type EvalSettings } from "./store.js";
import { packForWorkflow, personaPack } from "./workflow-pack.js";

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
  /** A model for judges and calibration. Null or absent: judge checks stay `unsure`. */
  readonly llm?: () => LlmAdapter | null;
  /** The weekly summary: the mail it goes out with, the team it goes to, and the inbound screen's week. */
  readonly report?: {
    readonly email: () => EmailAdapter | null;
    readonly team: () => Promise<readonly string[]>;
    readonly inbound?: () => Promise<{ readonly screened: number; readonly wouldHold: number; readonly held: number }>;
    /** Where people open the app: the summary links there. */
    readonly origin?: string;
  };
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
    const saved = (await this.deps.runs.scenarios()).filter((one) => "workflow" in one.target && one.target.workflow === workflow.id);
    return [...packForWorkflow(workflow, await this.agentsOf(workflow)), ...saved];
  }

  /** The judge a run uses: a model against calibrated rubrics, or none. */
  private judge(): Judge | undefined {
    const llm = this.deps.llm?.() ?? null;
    return llm ? modelJudge(llm, (rubric) => this.deps.runs.calibration(rubric)) : undefined;
  }

  /** The judges and how far each agrees with the team: shown only once it agrees often enough. */
  async judges(): Promise<Array<{ readonly id: string; readonly rubric: string; readonly calibration: Calibration | null; readonly shown: boolean; readonly needed: { readonly agreement: number; readonly examples: number } }>> {
    const calibration = await this.deps.runs.calibration(rubricKey(TONE_RUBRIC));
    return [{ id: toneCheck.id, rubric: TONE_RUBRIC, calibration, shown: calibrated(calibration), needed: { agreement: AGREEMENT_NEEDED, examples: EXAMPLES_NEEDED } }];
  }

  /** Calibrates the Tone judge against the team's recent approvals of messages. Spends model calls, one per example. */
  async calibrateTone(): Promise<Calibration> {
    const llm = this.deps.llm?.() ?? null;
    if (!llm) throw new EvalError("No AI model is set up, so the judge cannot be calibrated.", 409);
    const tasks = (await this.deps.env.tasks.list({ limit: 1000 })).filter((task) => task.base === "outreach" && taskLabel(task) !== null);
    const calibration = await calibrate(llm, TONE_RUBRIC, tasks, this.deps.env.now());
    await this.deps.runs.putCalibration(calibration);
    return calibration;
  }

  /** Saves a real task's case as a scenario, its people redacted, with a check that what went wrong does not happen again unattended. */
  async saveTask(taskId: string): Promise<ScenarioInput> {
    const task = await this.deps.env.tasks.get(taskId);
    if (!task?.case || !task.workflow) throw new EvalError("Only a workflow's task can be saved as a scenario.", 404);
    const one = await this.deps.env.cases.get(task.case);
    if (!one) throw new EvalError("The case behind this task is gone.", 404);
    const workflow = await this.workflow(task.workflow);
    /* The workflow as the case ran it: its own steps, frozen when it opened. */
    const ran: WorkflowSpec = { ...workflow, ...(one.definition ? { nodes: one.definition.nodes, edges: one.definition.edges } : {}) };
    let scenario: ScenarioInput;
    try {
      scenario = scenarioFromTask(task, one, ran, await this.agentsOf(ran), `saved-${this.deps.env.newId()}`.slice(0, 64));
    } catch (error) {
      if (error instanceof SaveError) throw new EvalError(error.message, 409);
      throw error;
    }
    const parsed = scenarioSchema.parse(scenario);
    await this.deps.runs.putScenario(parsed);
    return parsed;
  }

  savedScenarios(): Promise<ScenarioInput[]> {
    return this.deps.runs.scenarios();
  }

  removeScenario(id: string): Promise<void> {
    return this.deps.runs.deleteScenario(id);
  }

  settings(): Promise<EvalSettings> {
    return this.deps.runs.settings();
  }

  async putSettings(input: unknown): Promise<EvalSettings> {
    const held = await this.deps.runs.settings();
    const parsed = evalSettingsSchema.safeParse({ ...held, ...(input && typeof input === "object" ? input : {}) });
    if (!parsed.success) throw new EvalError(parsed.error.issues.map((issue) => issue.message).join(" "), 400);
    await this.deps.runs.putSettings(parsed.data);
    return parsed.data;
  }

  /** The week in evals, as an email: tests by workflow and dimension, live tasks that failed a check, what people did, the inbound screen. */
  async weeklySummary(): Promise<{ readonly subject: string; readonly text: string; readonly html: string }> {
    const now = this.deps.env.now();
    const since = new Date(now - 7 * 86_400_000).toISOString();
    const runs = (await this.deps.runs.list({ limit: 500 })).filter((run) => (run.finishedAt ?? run.startedAt) >= since);
    const workflows = new Map((await this.deps.env.store.list()).map((one) => [one.id, one.name]));
    const tasks = (await this.deps.env.tasks.list({ limit: 1000 })).filter((task) => (task.finishedAt ?? task.createdAt) >= since);
    const scored = tasks.filter((task) => task.eval && task.eval.length > 0);
    const failing = scored.filter((task) => task.eval!.some((verdict) => verdict.result === "fail"));
    const inbound = await this.deps.report?.inbound?.().catch(() => null);
    const lines: string[] = [`Tests run: ${runs.length}.`];
    const byWorkflow = new Map<string, EvalRun[]>();
    for (const run of runs) {
      const workflow = "workflow" in run.target ? run.target.workflow : run.scenario;
      byWorkflow.set(workflow, [...(byWorkflow.get(workflow) ?? []), run]);
    }
    for (const [workflow, group] of byWorkflow) {
      const tally = verdictsByDimension(group.flatMap((run) => run.verdicts));
      const parts = Object.entries(tally).map(([dimension, one]) => `${dimension} ${one!.pass} passed${one!.fail ? `, ${one!.fail} failed` : ""}${one!.silent ? `, ${one!.silent} failed unsaid` : ""}`);
      lines.push(`- ${workflows.get(workflow) ?? workflow}: ${parts.join("; ")}.`);
    }
    lines.push("", `Live tasks scored by their checks: ${scored.length}, of which ${failing.length} failed one.`);
    for (const task of failing.slice(0, 10)) lines.push(`- ${task.title} (${task.workflowName ?? "a workflow"}): ${task.eval!.find((verdict) => verdict.result === "fail")?.note ?? "a check failed"}.`);
    const labels = tasks.map((task) => taskLabel(task));
    const count = (label: string) => labels.filter((one) => one === label).length;
    lines.push("", `What people did: ${count("good")} approved as proposed, ${count("partly_wrong")} edited first, ${count("wrong")} declined, ${count("wrong_shipped")} reversed.`);
    if (inbound) lines.push("", `Inbound screen: ${inbound.screened} screened, ${inbound.wouldHold} a rule flagged, ${inbound.held} held.`);
    const judge = (await this.judges())[0];
    if (judge?.calibration) lines.push("", `The Tone judge agrees with your team ${Math.round(judge.calibration.agreement * 100)}% of ${judge.calibration.examples} times${judge.shown ? "" : ", not enough to show its verdicts yet"}.`);
    if (this.deps.report?.origin) lines.push("", `Open Dash: ${this.deps.report.origin}/#/agent/workflows`);
    const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111827">${lines.map((line) => (line === "" ? "<br>" : `<p style="margin:0 0 6px">${escapeHtml(line)}</p>`)).join("")}</div>`;
    return { subject: "Dash evals: the week", text: lines.join("\n"), html };
  }

  /** Sends the weekly summary when it is on and a week has passed, or now when asked. Returns how many it went to. */
  async sendWeekly(force = false): Promise<number> {
    const settings = await this.deps.runs.settings();
    if (!force && !settings.weekly.enabled) return 0;
    const now = this.deps.env.now();
    if (!force && settings.lastSentAt && now - Date.parse(settings.lastSentAt) < 7 * 86_400_000) return 0;
    const email = this.deps.report?.email() ?? null;
    if (!email) {
      if (force) throw new EvalError("Email isn't set up on this server, so the summary cannot be sent.", 409);
      return 0;
    }
    const to = settings.weekly.to.length > 0 ? settings.weekly.to : (await this.deps.report!.team()).filter((one) => one.includes("@"));
    if (to.length === 0) return 0;
    const summary = await this.weeklySummary();
    /* Recorded first: a send that fails part way is not sent again the same week. */
    await this.deps.runs.putSettings({ ...settings, lastSentAt: new Date(now).toISOString() });
    for (const recipient of to) await email.send({ to: recipient, subject: summary.subject, text: summary.text, html: summary.html });
    return to.length;
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
      const judge = this.judge();
      session = await ScenarioSession.start(input, { id, ...(judge ? { judge } : {}), onEvent: (event) => listeners.forEach((listener) => listener(event)) });
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
  async test(workflowId: string, personas: readonly string[] = []): Promise<EvalRun[]> {
    const workflow = await this.workflow(workflowId);
    const pack = [...(await this.pack(workflowId)), ...personaPack(workflow, await this.agentsOf(workflow), personas)];
    if (pack.length === 0) throw new EvalError("Dash has no scenarios for what starts this workflow yet.", 404);
    const out: EvalRun[] = [];
    for (const input of pack) {
      const judge = this.judge();
      const run = await (await ScenarioSession.start(input, { id: `eval-${this.deps.env.newId()}`, ...(judge ? { judge } : {}) })).finish();
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
