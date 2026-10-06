import { AgentChip, Badge, Button, EmptyState, ErrorState } from "@freebirdai/dash-components";
import { WriteReview } from "@freebirdai/dash-react";
import { describeTrigger, type AgentSpec, type Proposal, type WorkflowRun, type WorkflowSpec, type WriteReviewView } from "@freebirdai/dash-spec";
import { useEffect, useMemo, useState } from "react";
import { api, type ConnectionSummary } from "../../api";
import type { Route } from "../../route.js";
import { workflowState } from "./draft.js";
import { WorkflowEditor } from "./WorkflowEditor.jsx";

/**
 * Workflows: a trigger and a path.
 *
 * Three things, in the order a person needs them:
 * 1. **Waiting for you**: what an approve step, or an agent's tool set to
 *    approve, is asking a person to decide. A change opens as its review,
 *    prepared now, as you; Apply sends exactly that review.
 * 2. **Workflows**: each with its trigger in words and whether it is on.
 * 3. **Recent runs**: what each run read, matched and did.
 *
 * Every control is also something the chat can do (`create_workflow`,
 * `update_workflow`).
 */

const NEW = "new";

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const when = (iso: string | undefined): string => {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const useWorkflowsData = (reloadToken: number) => {
  const [state, setState] = useState<{
    workflows: WorkflowSpec[];
    agents: AgentSpec[];
    connections: ConnectionSummary[];
    waiting: Proposal[];
    runs: WorkflowRun[];
    error: string | null;
    loaded: boolean;
  }>({ workflows: [], agents: [], connections: [], waiting: [], runs: [], error: null, loaded: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [workflows, agents, connections, waiting, stale, runs] = await Promise.all([
          api.workflows(),
          api.agents(),
          api.connections(),
          api.proposals("waiting"),
          api.proposals("stale"),
          api.workflowRuns(),
        ]);
        if (!cancelled) setState({ workflows, agents, connections, waiting: [...waiting, ...stale], runs, error: null, loaded: true });
      } catch (cause) {
        if (!cancelled) setState((held) => ({ ...held, error: errorText(cause), loaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return state;
};

/** One thing waiting for a person. */
const ProposalCard = ({
  proposal,
  agent,
  workflowName,
  onDone,
}: {
  proposal: Proposal;
  agent: AgentSpec | undefined;
  workflowName: string | undefined;
  onDone: () => void;
}): JSX.Element => {
  const [review, setReview] = useState<WriteReviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(proposal.status === "stale" ? (proposal.error ?? "This no longer applies.") : null);

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const open = () =>
    act(async () => {
      const opened = await api.reviewProposal(proposal.id);
      if (opened.proposal.status === "stale") {
        setError(opened.proposal.error ?? "This no longer applies.");
        return;
      }
      setReview(opened.review ?? null);
    });

  return (
    <li className="dash-proposal" data-testid={`proposal-${proposal.id}`} data-status={proposal.status}>
      <div className="dash-proposal__head">
        {agent && <AgentChip name={agent.name} color={agent.color} size="sm" />}
        <strong className="dash-proposal__title">{proposal.title}</strong>
        {proposal.status === "stale" && <Badge tone="stale">No longer applies</Badge>}
      </div>
      <span className="dash-hint">
        {proposal.reason}
        {workflowName ? ` · ${workflowName}` : ""} · {when(proposal.createdAt)}
      </span>
      {error && (
        <p className="dash-callout dash-callout--bad" role="alert">
          {error}
        </p>
      )}
      {review ? (
        <WriteReview
          review={review}
          compact
          busy={busy}
          onCancel={() => setReview(null)}
          onConfirm={() =>
            void act(async () => {
              await api.applyProposal(proposal.id, { pendingId: review.pendingId, digest: review.digest });
              setReview(null);
              onDone();
            })
          }
        />
      ) : (
        <div className="dash-row">
          {proposal.status === "waiting" && proposal.kind === "change" && (
            <Button size="sm" tone="primary" busy={busy} onClick={() => void open()} testId={`proposal-review-${proposal.id}`}>
              Review
            </Button>
          )}
          {proposal.status === "waiting" && proposal.kind === "workflow_start" && (
            <Button
              size="sm"
              tone="primary"
              busy={busy}
              onClick={() =>
                void act(async () => {
                  await api.applyProposal(proposal.id);
                  onDone();
                })
              }
              testId={`proposal-start-${proposal.id}`}
            >
              Start it
            </Button>
          )}
          <Button
            size="sm"
            busy={busy}
            onClick={() =>
              void act(async () => {
                await api.dismissProposal(proposal.id);
                onDone();
              })
            }
            testId={`proposal-dismiss-${proposal.id}`}
          >
            Dismiss
          </Button>
        </div>
      )}
    </li>
  );
};

const RunsList = ({ runs, agents, empty }: { runs: readonly WorkflowRun[]; agents: ReadonlyMap<string, AgentSpec>; empty: string }): JSX.Element =>
  runs.length === 0 ? (
    <p className="dash-hint">{empty}</p>
  ) : (
    <ul className="dash-workflow-runs" data-testid="workflow-runs">
      {runs.map((run) => {
        const agent = run.agent ? agents.get(run.agent) : undefined;
        return (
          <li key={run.id} className="dash-workflow-run" data-status={run.status}>
            <div className="dash-proposal__head">
              {agent && <AgentChip name={agent.name} color={agent.color} size="sm" />}
              <strong>{run.workflowName}</strong>
              <Badge tone={run.status === "failed" ? "danger" : run.status === "parked" ? "warn" : run.status === "running" ? "accent" : "neutral"}>
                {run.status === "succeeded" ? "Done" : run.status === "seeded" ? "First look" : run.status === "parked" ? "Paused" : run.status === "failed" ? "Failed" : "Running"}
              </Badge>
              <span className="dash-hint">{when(run.startedAt)}</span>
            </div>
            <span className="dash-hint">{run.summary || run.error}</span>
            {run.outputs.length > 0 && (
              <details className="dash-agent-editor__preview">
                <summary>What it did</summary>
                <ul className="dash-workflow-run__outputs">
                  {run.outputs.map((output, index) => (
                    <li key={index} data-outcome={output.outcome}>
                      <span className="dash-workflow-run__outcome">{output.outcome}</span> {output.detail}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );

export const WorkflowsSection = ({
  selected,
  onNavigate,
}: {
  readonly selected: string | null;
  readonly onNavigate: (route: Route) => void;
}): JSX.Element => {
  const [reloadToken, setReloadToken] = useState(0);
  const { workflows, agents, connections, waiting, runs, error, loaded } = useWorkflowsData(reloadToken);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = (): void => setReloadToken((n) => n + 1);
  const go = (id?: string): void => onNavigate({ kind: "agent", section: "workflows", ...(id ? { id } : {}) });

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const workflowName = (id: string | undefined) => workflows.find((one) => one.id === id)?.name;
  const names = useMemo(
    () => ({ connection: (id: string) => connections.find((one) => one.id === id)?.title ?? id }),
    [connections],
  );
  /* The agents whose tools start each workflow, for "When Maintenance agent is asked". */
  const startedBy = (id: string): string[] =>
    agents.filter((agent) => agent.tools.some((tool) => tool.kind === "run_workflow" && tool.workflow === id)).map((agent) => agent.name);

  const current = selected && selected !== NEW ? (workflows.find((one) => one.id === selected) ?? null) : null;

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      reload();
    } catch (cause) {
      setActionError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="dash-agents" data-testid="workflows-section">
      <aside className="dash-agents__list" aria-label="Workflows">
        <div className="dash-agents__head">
          <h2 className="dash-agents__title">Workflows</h2>
          <Button size="sm" tone="primary" onClick={() => go(NEW)} testId="workflow-new">
            ＋ New workflow
          </Button>
        </div>
        <button type="button" className="dash-agent-row dash-agent-row--shared" data-active={!selected} onClick={() => go()} data-testid="workflow-row-waiting">
          <span className="dash-agent-row__title">
            Waiting for you {waiting.filter((one) => one.status === "waiting").length > 0 && <Badge tone="accent">{waiting.filter((one) => one.status === "waiting").length}</Badge>}
          </span>
          <span className="dash-agent-row__reach">And recent runs</span>
        </button>
        {loaded && workflows.length === 0 ? (
          <p className="dash-hint" data-testid="workflows-empty">
            No workflows yet. A workflow starts from a trigger — a schedule, a new record, an agent being asked — and follows its steps.
          </p>
        ) : (
          <ul className="dash-agents__rows">
            {workflows.map((workflow) => {
              const state = workflowState(workflow);
              return (
                <li key={workflow.id}>
                  <button
                    type="button"
                    className="dash-agent-row"
                    data-active={workflow.id === selected}
                    data-testid={`workflow-row-${workflow.id}`}
                    onClick={() => go(workflow.id)}
                  >
                    <span className="dash-agent-row__title">
                      {workflow.name} <Badge tone={state.tone === "on" ? "accent" : state.tone === "paused" ? "warn" : "neutral"}>{state.label}</Badge>
                    </span>
                    <span className="dash-agent-row__reach">{describeTrigger(workflow.trigger, { ...names, agents: startedBy(workflow.id) })}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="dash-agents__detail" aria-live="polite">
        {actionError && (
          <p className="dash-callout dash-callout--bad" role="alert">
            {actionError}
          </p>
        )}
        {selected === NEW ? (
          <>
            <h3 className="dash-agents__subtitle">New workflow</h3>
            <WorkflowEditor
              key="new"
              workflow={null}
              agents={agents}
              connections={connections}
              onSaved={(saved) => {
                reload();
                go(saved.id);
              }}
              onCancel={() => go()}
            />
          </>
        ) : current ? (
          <>
            <div className="dash-agents__subhead">
              <h3 className="dash-agents__subtitle">{current.name}</h3>
              <span className="dash-row">
                <Button
                  size="sm"
                  tone={current.enabled && !current.parked ? "default" : "primary"}
                  busy={busy}
                  onClick={() => void act(() => api.setWorkflowEnabled(current.id, !(current.enabled && !current.parked)))}
                  testId="workflow-toggle"
                >
                  {current.enabled && !current.parked ? "Turn off" : "Turn on"}
                </Button>
                {current.trigger.kind !== "agent" || current.trigger.inputs.length === 0 ? (
                  <Button size="sm" busy={busy} onClick={() => void act(() => api.runWorkflow(current.id))} testId="workflow-run">
                    Run now
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  tone="ghost"
                  busy={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.deleteWorkflow(current.id);
                      go();
                    })
                  }
                  testId="workflow-delete"
                >
                  Delete
                </Button>
              </span>
            </div>
            {current.parked && (
              <p className="dash-callout dash-callout--warn" role="status" data-testid="workflow-parked">
                Paused: {current.parked.reason} Turn it back on once that is fixed.
              </p>
            )}
            <p className="dash-hint">
              {describeTrigger(current.trigger, { ...names, agents: startedBy(current.id) })}
              {current.enabledBy ? ` · runs as ${current.enabledBy.kind === "local-owner" ? "the owner" : current.enabledBy.userId}` : ""}
            </p>
            <WorkflowEditor
              key={`${current.id}:${current.updatedAt}`}
              workflow={current}
              agents={agents}
              connections={connections}
              onSaved={() => reload()}
              onCancel={() => go()}
            />
            <h4 className="dash-workflow-editor__heading">Runs</h4>
            <RunsList runs={runs.filter((run) => run.workflow === current.id)} agents={agentById} empty="It has not run yet." />
          </>
        ) : selected ? (
          <EmptyState glyph="⇄" title="That workflow is not here" body="It may have been deleted." action={{ label: "Back to workflows", onClick: () => go() }} />
        ) : (
          <>
            <h3 className="dash-agents__subtitle">Waiting for you</h3>
            {waiting.length === 0 ? (
              <p className="dash-hint" data-testid="waiting-empty">
                Nothing is waiting. Steps set to Approve, and agents' requests to start a workflow, appear here.
              </p>
            ) : (
              <ul className="dash-proposals" data-testid="waiting">
                {waiting.map((proposal) => (
                  <ProposalCard
                    key={`${proposal.id}:${proposal.status}`}
                    proposal={proposal}
                    agent={proposal.agent ? agentById.get(proposal.agent) : undefined}
                    workflowName={workflowName(proposal.workflow)}
                    onDone={reload}
                  />
                ))}
              </ul>
            )}
            <h3 className="dash-agents__subtitle dash-workflow-editor__heading">Recent runs</h3>
            <RunsList runs={runs} agents={agentById} empty="No runs yet." />
          </>
        )}
      </section>
    </div>
  );
};
