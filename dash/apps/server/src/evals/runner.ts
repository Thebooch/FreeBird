import { evalRunSchema, scenarioSchema, type EvalRun, type RunEvent, type Scenario, type ScenarioInput, type Verdict } from "@freebirdai/dash-spec";
import { checkAll, checkRules, type Judge } from "./checks.js";
import { Sandbox } from "./sandbox.js";

/**
 * Plays a scenario in a sandbox and scores it.
 *
 * The run's log comes first: each turn, step, task, verdict and snapshot is
 * appended as it happens, and the run's verdicts are read from it. Rule
 * checks run after every turn, so a failure shows up when it happens rather
 * than only at the end.
 */

export interface RunOptions {
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

export const runScenario = async (input: ScenarioInput | Scenario, options: RunOptions = {}): Promise<EvalRun> => {
  const scenario = scenarioSchema.parse(input);
  const driver = scenario.persona?.driver ?? "script";
  if (driver !== "script") throw new ScenarioError(`"${scenario.name}" is played by a ${driver}; only scripted scenarios run so far.`);
  const target = "workflow" in scenario.target ? scenario.world.workspace.workflows.find((one) => one.id === (scenario.target as { workflow: string }).workflow) : undefined;
  if ("workflow" in scenario.target && !target) throw new ScenarioError(`"${scenario.name}" tests workflow "${scenario.target.workflow}", which its world does not have.`);

  const events: RunEvent[] = [];
  let turn: string | undefined;
  let sandbox: Sandbox | undefined;
  const append = (kind: RunEvent["kind"], data: unknown): void => {
    const event: RunEvent = { seq: events.length, at: sandbox?.now ?? 0, ...(turn ? { turn } : {}), kind, data };
    events.push(event);
    options.onEvent?.(event);
  };
  sandbox = await Sandbox.start({
    id: `sandbox-${scenario.id}`,
    world: scenario.world,
    ...(scenario.scriptedModel ? { model: scenario.scriptedModel } : {}),
    onEvent: (event) => append(event.kind, event.data),
  });
  const startedAt = new Date(sandbox.now).toISOString();

  const latest = new Map<string, Verdict>();
  const score = (verdicts: readonly Verdict[]): void => {
    for (const verdict of verdicts) {
      if (sameVerdict(latest.get(verdict.check), verdict)) continue;
      latest.set(verdict.check, verdict);
      append("verdict", verdict);
    }
  };

  for (const one of [...scenario.turns, ...(scenario.persona?.script ?? [])]) {
    turn = one.id;
    append("turn", one);
    const session = await sandbox.step(one);
    if (session.status === "waiting") append("waiting", { status: session.status });
    append("snapshot", { id: sandbox.snapshot() });
    score(checkRules(scenario.checks, await sandbox.tasks(), sandbox.now));
  }
  turn = undefined;

  const verdicts = await checkAll(scenario.checks, await sandbox.tasks(), sandbox.now, options.judge);
  score(verdicts);
  sandbox.stop();
  append("ended", { intents: sandbox.intents });
  return evalRunSchema.parse({
    id: `run-${scenario.id}-v${scenario.version}`,
    scenario: scenario.id,
    scenarioVersion: scenario.version,
    target: scenario.target,
    ...(target ? { targetVersion: target.version } : {}),
    session: sandbox.id,
    driver,
    startedAt,
    finishedAt: new Date(sandbox.now).toISOString(),
    events,
    verdicts,
  });
};

/** A run in a line per check: what a person or CI reads first. */
export const describeRun = (run: EvalRun, scenario: Pick<Scenario, "name">): string => {
  const lines = [`${scenario.name} (${run.scenario} v${run.scenarioVersion})`];
  for (const verdict of run.verdicts) {
    const mark = verdict.result === "pass" ? "pass" : verdict.result === "unsure" ? "unsure" : verdict.said ? "fail (said)" : "FAIL (not said)";
    lines.push(`  ${mark.padEnd(16)} ${verdict.dimension.padEnd(12)} ${verdict.check}${verdict.note ? `: ${verdict.note}` : ""}`);
  }
  return lines.join("\n");
};
