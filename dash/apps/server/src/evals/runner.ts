import { evalRunSchema, scenarioSchema, type EvalRun, type RunEvent, type Scenario, type ScenarioInput, type Turn, type Verdict } from "@freebirdai/dash-spec";
import { checkAll, checkRules, type Judge } from "./checks.js";
import { Sandbox } from "./sandbox.js";

/**
 * Plays a scenario in a sandbox and scores it.
 *
 * The run's log comes first: each turn, step, task, verdict and snapshot is
 * appended as it happens, and the run's verdicts are read from it. Rule
 * checks run after every turn, so a failure shows up when it happens rather
 * than only at the end. A `ScenarioSession` plays one turn at a time (the
 * Test button); `runScenario` plays them all (CI, `pnpm eval:scenarios`).
 */

export interface RunOptions {
  /** The run's id. Default made from the scenario and its version. */
  readonly id?: string;
  /** Scores judge checks. Absent (scripted mode, CI): they are `unsure`. */
  readonly judge?: Judge;
  /** Each event as it is appended: a stepped view reads these. */
  readonly onEvent?: (event: RunEvent) => void;
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

const sameVerdict = (a: Verdict | undefined, b: Verdict): boolean =>
  a !== undefined && a.result === b.result && a.said === b.said && a.evidence.join(",") === b.evidence.join(",");

/** One scenario being played: turn by turn, with its log growing as it goes. */
export class ScenarioSession {
  readonly events: RunEvent[] = [];
  private readonly latest = new Map<string, Verdict>();
  private readonly turns: Turn[];
  private next = 0;
  private turn: string | undefined;
  private sandbox!: Sandbox;
  private startedAt = "";
  private finished: EvalRun | null = null;

  private constructor(
    readonly scenario: Scenario,
    private readonly options: RunOptions,
  ) {
    this.turns = [...scenario.turns, ...(scenario.persona?.script ?? [])];
  }

  static async start(input: ScenarioInput | Scenario, options: RunOptions = {}): Promise<ScenarioSession> {
    const scenario = scenarioSchema.parse(input);
    const driver = scenario.persona?.driver ?? "script";
    if (driver !== "script") throw new ScenarioError(`"${scenario.name}" is played by a ${driver}; only scripted scenarios run so far.`);
    if ("workflow" in scenario.target && !scenario.world.workspace.workflows.some((one) => one.id === (scenario.target as { workflow: string }).workflow)) {
      throw new ScenarioError(`"${scenario.name}" tests workflow "${scenario.target.workflow}", which its world does not have.`);
    }
    const session = new ScenarioSession(scenario, options);
    session.sandbox = await Sandbox.start({
      id: `sandbox-${options.id ?? scenario.id}`,
      world: scenario.world,
      ...(scenario.scriptedModel ? { model: scenario.scriptedModel } : {}),
      onEvent: (event) => session.append(event.kind, event.data),
    });
    session.startedAt = new Date(session.sandbox.now).toISOString();
    return session;
  }

  get id(): string {
    return this.options.id ?? `run-${this.scenario.id}-v${this.scenario.version}`;
  }

  /** Turns not played yet. */
  get remaining(): number {
    return this.turns.length - this.next;
  }

  get done(): boolean {
    return this.finished !== null;
  }

  /** Plays the next turn and scores the rule checks. Returns the events it added. */
  async step(): Promise<RunEvent[]> {
    if (this.finished) throw new ScenarioError("This run has ended.");
    const one = this.turns[this.next];
    if (!one) return [];
    this.next++;
    const from = this.events.length;
    this.turn = one.id;
    this.append("turn", one);
    const session = await this.sandbox.step(one);
    if (session.status === "waiting") this.append("waiting", { status: session.status });
    this.append("snapshot", { id: this.sandbox.snapshot() });
    this.score(checkRules(this.scenario.checks, await this.sandbox.tasks(), this.sandbox.now));
    this.turn = undefined;
    return this.events.slice(from);
  }

  /** Plays what is left, scores every check (judges too) and ends. */
  async finish(): Promise<EvalRun> {
    if (this.finished) return this.finished;
    while (this.remaining > 0) await this.step();
    const verdicts = await checkAll(this.scenario.checks, await this.sandbox.tasks(), this.sandbox.now, this.options.judge);
    this.score(verdicts);
    this.sandbox.stop();
    this.append("ended", { intents: this.sandbox.intents });
    const target = "workflow" in this.scenario.target ? this.scenario.world.workspace.workflows.find((one) => one.id === (this.scenario.target as { workflow: string }).workflow) : undefined;
    this.finished = evalRunSchema.parse({
      id: this.id,
      scenario: this.scenario.id,
      scenarioVersion: this.scenario.version,
      target: this.scenario.target,
      ...(target ? { targetVersion: target.version } : {}),
      session: this.sandbox.id,
      driver: this.scenario.persona?.driver ?? "script",
      startedAt: this.startedAt,
      finishedAt: new Date(this.sandbox.now).toISOString(),
      events: this.events,
      verdicts,
    });
    return this.finished;
  }

  private append(kind: RunEvent["kind"], data: unknown): void {
    const event: RunEvent = { seq: this.events.length, at: this.sandbox?.now ?? 0, ...(this.turn ? { turn: this.turn } : {}), kind, data };
    this.events.push(event);
    this.options.onEvent?.(event);
  }

  private score(verdicts: readonly Verdict[]): void {
    for (const verdict of verdicts) {
      if (sameVerdict(this.latest.get(verdict.check), verdict)) continue;
      this.latest.set(verdict.check, verdict);
      this.append("verdict", verdict);
    }
  }
}

export const runScenario = async (input: ScenarioInput | Scenario, options: RunOptions = {}): Promise<EvalRun> => (await ScenarioSession.start(input, options)).finish();

/** A run in a line per check: what a person or CI reads first. */
export const describeRun = (run: EvalRun, scenario: Pick<Scenario, "name">): string => {
  const lines = [`${scenario.name} (${run.scenario} v${run.scenarioVersion})`];
  for (const verdict of run.verdicts) {
    const mark = verdict.result === "pass" ? "pass" : verdict.result === "unsure" ? "unsure" : verdict.said ? "fail (said)" : "FAIL (not said)";
    lines.push(`  ${mark.padEnd(16)} ${verdict.dimension.padEnd(12)} ${verdict.check}${verdict.note ? `: ${verdict.note}` : ""}`);
  }
  return lines.join("\n");
};
