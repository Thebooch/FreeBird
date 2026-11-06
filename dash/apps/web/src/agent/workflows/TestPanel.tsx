import { Badge, Button } from "@freebirdai/dash-components";
import type { EvalRun, RunEvent, Task, Turn, Verdict, WorkflowSpec } from "@freebirdai/dash-spec";
import { useEffect, useState } from "react";
import { api, type StepGraduation } from "../../api";

/**
 * Test a workflow before it touches a customer: its scenario played in a
 * sandbox, one turn at a time, read from the run's events as they come.
 * Nothing it does is sent, written or charged. When it ends, each check's
 * verdict, a mark on each step on the canvas, and how each outside step
 * stands on leaving trial.
 */

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const TURN_WORDS: Readonly<Record<Turn["kind"], string>> = {
  message: "An email arrives",
  booking: "A booking changes",
  record: "Records change",
  clock: "Time passes",
  start: "Someone starts it",
};

const STATUS_WORDS: Readonly<Partial<Record<Task["status"], string>>> = {
  waiting_approval: "asks for approval",
  waiting: "waits",
  running: "runs",
  done: "done",
  skipped: "skipped",
  failed: "failed",
  dismissed: "declined",
  timed_out: "timed out",
  lost: "lost",
};

/** One event, in a line a person reads. Steps the engine reports are left out: their tasks say more. */
const line = (event: RunEvent): string | null => {
  switch (event.kind) {
    case "turn": {
      const turn = event.data as Turn;
      return TURN_WORDS[turn.kind] ?? turn.kind;
    }
    case "task": {
      const task = event.data as Task;
      if (task.status === "running") return null;
      return `${task.title}: ${STATUS_WORDS[task.status] ?? task.status}`;
    }
    case "verdict": {
      const verdict = event.data as Verdict;
      return `${verdict.result === "pass" ? "Passes" : verdict.result === "fail" ? "Fails" : "Unsure"}: ${verdict.note ?? verdict.check}`;
    }
    case "waiting":
      return "Everything waits now.";
    case "ended":
      return "The test ended. Nothing left the sandbox.";
    default:
      return null;
  }
};

/** Each step's mark: failed when a failed check points at one of its tasks, passed when it ran and none did. */
export const marksOf = (run: EvalRun): Record<string, { result: "pass" | "fail"; why?: string }> => {
  const taskNode = new Map<string, string>();
  for (const event of run.events) if (event.kind === "task") {
    const task = event.data as Task;
    if (task.node) taskNode.set(task.id, task.node);
  }
  const out: Record<string, { result: "pass" | "fail"; why?: string }> = {};
  for (const node of taskNode.values()) out[node] = { result: "pass" };
  for (const verdict of run.verdicts) {
    if (verdict.result !== "fail") continue;
    for (const task of verdict.evidence) {
      const node = taskNode.get(task);
      if (node) out[node] = { result: "fail", why: verdict.note ?? verdict.check };
    }
  }
  return out;
};

const VerdictTable = ({ verdicts }: { verdicts: readonly Verdict[] }): JSX.Element => (
  <table className="dash-evals__verdicts" data-testid="test-verdicts">
    <tbody>
      {verdicts.map((verdict) => (
        <tr key={verdict.check} data-result={verdict.result}>
          <td>{verdict.result === "pass" ? "Pass" : verdict.result === "unsure" ? "Unsure" : verdict.said ? "Fail (a person was told)" : "Fail (nobody was told)"}</td>
          <td>{verdict.dimension}</td>
          <td>{verdict.note ?? verdict.check}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** How each outside step stands on leaving trial, and Auto for one that is ready. */
export const GraduationPanel = ({ workflow, refresh, onChanged }: { workflow: string; refresh: number; onChanged: (saved: WorkflowSpec) => void }): JSX.Element | null => {
  const [state, setState] = useState<{ enabled: boolean; steps: StepGraduation[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void api.workflowGraduation(workflow).then(setState, () => setState(null));
  }, [workflow, refresh]);
  if (!state?.enabled || state.steps.length === 0) return null;
  return (
    <div className="dash-evals" data-testid="graduation">
      <strong>Leaving trial</strong>
      <span className="dash-hint">Each step that leaves Dash goes on Auto once its test passes and enough trial cases were approved as proposed. You accept it.</span>
      <ul className="dash-evals__events">
        {state.steps.map((step) => (
          <li key={step.node}>
            <strong>{step.name}</strong>{" "}
            {step.graduated ? (
              <Badge tone="accent">On Auto</Badge>
            ) : step.ready ? (
              <Button
                size="sm"
                tone="primary"
                busy={busy === step.node}
                onClick={() => {
                  setBusy(step.node);
                  setError(null);
                  void api
                    .graduateStep(workflow, step.node)
                    .then(onChanged, (cause: unknown) => setError(errorText(cause)))
                    .finally(() => setBusy(null));
                }}
                testId={`graduate-${step.node}`}
              >
                Switch to Auto
              </Button>
            ) : (
              <span className="dash-hint">{step.blockers.join(" ")}</span>
            )}
            {step.demoted && !step.graduated ? <span className="dash-hint"> Back on Approve: {step.demoted.reason}</span> : null}
          </li>
        ))}
      </ul>
      {error && <p className="dash-callout dash-callout--bad">{error}</p>}
    </div>
  );
};

export const TestPanel = ({
  workflow,
  onMarks,
  onGraduated,
  onClose,
}: {
  workflow: string;
  onMarks: (marks: Record<string, { result: "pass" | "fail"; why?: string }>) => void;
  /** A step went on Auto: the workflow as saved now. */
  onGraduated: (saved: WorkflowSpec) => void;
  onClose: () => void;
}): JSX.Element => {
  const [session, setSession] = useState<{ id: string; name: string; turns: number } | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [run, setRun] = useState<EvalRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState(0);

  const start = async () => {
    setBusy(true);
    setError(null);
    setRun(null);
    setEvents([]);
    onMarks({});
    try {
      const started = await api.startEvalSession(workflow);
      setSession({ id: started.id, name: started.scenario.name, turns: started.turns });
      setEvents(started.events);
      setRemaining(started.turns);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  /* Starts as soon as it opens; stops the session if it closes early. */
  useEffect(() => {
    void start();
  }, [workflow]);
  useEffect(() => () => void (session && !run ? api.stopEvalSession(session.id).catch(() => undefined) : undefined), [session, run]);

  const step = async (all: boolean) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      for (;;) {
        const next = await api.stepEvalSession(session.id);
        setEvents((held) => [...held, ...next.events]);
        setRemaining(next.remaining);
        if (next.run) {
          setRun(next.run);
          onMarks(marksOf(next.run));
          setRan((count) => count + 1);
          break;
        }
        if (!all) break;
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const lines = events.map((event) => ({ event, text: line(event) })).filter((one): one is { event: RunEvent; text: string } => one.text !== null);
  return (
    <>
      <div className="dash-evals" data-testid="test-panel">
        <div className="dash-row">
          <strong>Test{session ? `: ${session.name}` : ""}</strong>
          <span className="dash-hint">In a sandbox: nothing is sent, written or charged.</span>
          <span className="dash-row" style={{ marginLeft: "auto" }}>
            {!run && session && (
              <>
                <Button size="sm" busy={busy} onClick={() => void step(false)} testId="test-step">
                  {remaining > 0 ? "Next step" : "Score it"}
                </Button>
                <Button size="sm" tone="primary" busy={busy} onClick={() => void step(true)} testId="test-run-all">
                  Run to the end
                </Button>
              </>
            )}
            {run && (
              <Button size="sm" busy={busy} onClick={() => void start()} testId="test-again">
                Test again
              </Button>
            )}
            <Button size="sm" tone="ghost" onClick={onClose}>
              Close
            </Button>
          </span>
        </div>
        {lines.length > 0 && (
          <ol className="dash-evals__events" data-testid="test-events">
            {lines.map(({ event, text }) => (
              <li key={event.seq} data-kind={event.kind} data-result={event.kind === "verdict" ? (event.data as Verdict).result : undefined}>
                {text}
              </li>
            ))}
          </ol>
        )}
        {run && <VerdictTable verdicts={run.verdicts} />}
        {error && (
          <p className="dash-callout dash-callout--bad" role="alert">
            {error}
          </p>
        )}
      </div>
      <GraduationPanel
        workflow={workflow}
        refresh={ran}
        onChanged={(saved) => {
          setRan((count) => count + 1);
          onGraduated(saved);
        }}
      />
    </>
  );
};
