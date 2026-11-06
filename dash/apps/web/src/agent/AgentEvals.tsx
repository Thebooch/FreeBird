import { EmptyState } from "@freebirdai/dash-components";
import { EVAL_DIMENSIONS, type EvalDimension, type EvalRun } from "@freebirdai/dash-spec";
import { useEffect, useState } from "react";
import { api, type EvalTrendPoint } from "../api";

/**
 * An agent's Evals tab: the tests of the workflows whose steps act for it.
 * The latest run of each by dimension, and how each dimension went across
 * versions. Dimensions are never added up into one score.
 */

const DIMENSION_WORDS: Readonly<Record<EvalDimension, string>> = {
  completion: "Completion",
  correctness: "Correctness",
  authority: "Authority",
  disclosure: "Disclosure",
  resistance: "Resistance",
  honesty: "Honesty",
  friction: "Friction",
  tone: "Tone",
};

type Tally = { pass: number; fail: number; silent: number; unsure: number };

const tallyWords = (tally: Tally | undefined): string => {
  if (!tally) return "—";
  const parts = [`${tally.pass} passed`];
  if (tally.fail > 0) parts.push(`${tally.fail} failed`);
  if (tally.silent > 0) parts.push(`${tally.silent} failed unsaid`);
  if (tally.unsure > 0) parts.push(`${tally.unsure} unsure`);
  return parts.join(", ");
};

const tallyOf = (run: Omit<EvalRun, "events">): Partial<Record<EvalDimension, Tally>> => {
  const out: Partial<Record<EvalDimension, Tally>> = {};
  for (const verdict of run.verdicts) {
    const row = (out[verdict.dimension] ??= { pass: 0, fail: 0, silent: 0, unsure: 0 });
    if (verdict.result === "pass") row.pass++;
    else if (verdict.result === "unsure") row.unsure++;
    else if (verdict.said) row.fail++;
    else row.silent++;
  }
  return out;
};

export const AgentEvals = ({ agentId }: { agentId: string }): JSX.Element => {
  const [runs, setRuns] = useState<Array<Omit<EvalRun, "events">> | null>(null);
  const [trend, setTrend] = useState<EvalTrendPoint[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([api.evalRuns({ agent: agentId }), api.evalTrend({ agent: agentId }), api.workflows()]).then(
      ([listed, points, workflows]) => {
        setRuns(listed);
        setTrend(points);
        setNames(Object.fromEntries(workflows.map((one) => [one.id, one.name])));
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [agentId]);

  const workflowName = (id: string): string => names[id] ?? id;
  if (error) return <p className="dash-callout dash-callout--bad">{error}</p>;
  if (!runs) return <p className="dash-hint">Loading…</p>;
  if (runs.length === 0) return <EmptyState icon="sparkle" title="No tests yet" body="Open a workflow this agent acts in and press Test. Its results show here." />;

  /* The latest run of each workflow. */
  const latest = [...new Map(runs.map((run) => ["workflow" in run.target ? run.target.workflow : run.scenario, run] as const)).values()].reverse();
  const used = EVAL_DIMENSIONS.filter((dimension) => runs.some((run) => run.verdicts.some((verdict) => verdict.dimension === dimension)));
  return (
    <div className="dash-evals" data-testid="agent-evals">
      <strong>Latest tests</strong>
      <table className="dash-evals__verdicts">
        <thead>
          <tr>
            <th>Workflow</th>
            {used.map((dimension) => (
              <th key={dimension}>{DIMENSION_WORDS[dimension]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {latest.map((run) => {
            const tally = tallyOf(run);
            const workflow = "workflow" in run.target ? run.target.workflow : "";
            return (
              <tr key={run.id} data-result={run.verdicts.some((verdict) => verdict.result === "fail") ? "fail" : "pass"}>
                <td>
                  {workflowName(workflow)} <span className="dash-hint">v{run.targetVersion ?? "?"}</span>
                </td>
                {used.map((dimension) => (
                  <td key={dimension}>{tallyWords(tally[dimension])}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {trend.length > 1 && (
        <>
          <strong>Across versions</strong>
          <table className="dash-evals__verdicts" data-testid="agent-evals-trend">
            <thead>
              <tr>
                <th>Version</th>
                {used.map((dimension) => (
                  <th key={dimension}>{DIMENSION_WORDS[dimension]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trend.map((point) => (
                <tr key={`${point.workflow}@${point.version}`}>
                  <td>
                    {workflowName(point.workflow)} v{point.version}
                  </td>
                  {used.map((dimension) => (
                    <td key={dimension}>{tallyWords(point.dimensions[dimension])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
};
