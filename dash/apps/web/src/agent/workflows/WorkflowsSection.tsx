import { Badge, Button, EmptyState, ErrorState } from "@freebirdai/dash-components";
import { describeTrigger, type AgentSpec, type Task, type WorkflowCase, type WorkflowSpec, type WorkflowTemplate } from "@freebirdai/dash-spec";
import { useEffect, useMemo, useState } from "react";
import { api, type ConnectionSummary } from "../../api";
import type { Route } from "../../route.js";
import { workflowState } from "./draft.js";
import { TaskCard, when } from "./TaskCard.jsx";
import { WorkflowEditor } from "./WorkflowEditor.jsx";

/**
 * Workflows: a trigger and a graph of steps.
 *
 * With nothing open: **Waiting for you** (approvals and questions for the
 * team), the workflows with their triggers in words, and the templates saved
 * for reuse. With a workflow open: the builder, its open cases, and the
 * buttons to turn it on, run it or delete it.
 *
 * Every control is also something the chat can do (`draft_workflow`,
 * `create_workflow`, `update_workflow`, `save_workflow_template`,
 * `use_workflow_template`).
 */

const NEW = "new";

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const useData = (reloadToken: number) => {
  const [state, setState] = useState<{
    workflows: WorkflowSpec[];
    agents: AgentSpec[];
    connections: ConnectionSummary[];
    waiting: Task[];
    templates: WorkflowTemplate[];
    error: string | null;
    loaded: boolean;
  }>({ workflows: [], agents: [], connections: [], waiting: [], templates: [], error: null, loaded: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [workflows, agents, connections, approvals, questions, templates] = await Promise.all([
          api.workflows(),
          api.agents(true),
          api.connections(),
          api.tasks({ status: "waiting_approval" }),
          api.tasks({ status: "waiting" }),
          api.templates(),
        ]);
        if (cancelled) return;
        setState({
          workflows,
          agents,
          connections,
          waiting: [...approvals, ...questions.filter((task) => task.body.kind === "question")],
          templates,
          error: null,
          loaded: true,
        });
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

const CASE_WORDS: Readonly<Record<string, string>> = { approval: "your approval", ask: "a teammate's answer", time: "a time", reply: "a reply", record_change: "a record to change", workflow_done: "another workflow", webhook: "its webhook" };

const CasesList = ({ workflow, reloadToken, onChanged }: { workflow: WorkflowSpec; reloadToken: number; onChanged: () => void }): JSX.Element => {
  const [cases, setCases] = useState<WorkflowCase[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.workflowCases(workflow.id).then((list) => !cancelled && setCases(list), () => !cancelled && setCases([]));
    return () => {
      cancelled = true;
    };
  }, [workflow.id, reloadToken]);
  if (!cases) return <p className="dash-hint">Loading cases…</p>;
  if (cases.length === 0) return <p className="dash-hint">No cases yet. Each record the trigger matches opens one.</p>;
  return (
    <table className="dash-cases" data-testid="workflow-cases">
      <thead>
        <tr>
          <th>Record</th>
          <th>Status</th>
          <th>At</th>
          <th>Waiting for</th>
          <th>Updated</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {cases.map((one) => {
          const step = workflow.nodes.find((node) => node.id === (one.waiting?.node ?? one.at));
          return (
            <tr key={one.id} data-status={one.status}>
              <td>{one.rowKey || "—"}</td>
              <td>{one.status}</td>
              <td>{step ? (step.name ?? step.id) : "—"}</td>
              <td>
                {one.waiting ? `${CASE_WORDS[one.waiting.kind] ?? one.waiting.kind}${one.waiting.deadline ? `, until ${when(one.waiting.deadline)}` : ""}` : (one.error ?? "")}
              </td>
              <td>{when(one.updatedAt)}</td>
              <td>
                {(one.status === "waiting" || one.status === "running") && (
                  <Button size="sm" tone="ghost" onClick={() => void api.cancelCase(one.id).then(onChanged)}>
                    Cancel
                  </Button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export const WorkflowsSection = ({ selected, onNavigate }: { readonly selected: string | null; readonly onNavigate: (route: Route) => void }): JSX.Element => {
  const [reloadToken, setReloadToken] = useState(0);
  const { workflows, agents, connections, waiting, templates, error, loaded } = useData(reloadToken);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = (): void => setReloadToken((n) => n + 1);
  const go = (id?: string): void => onNavigate({ kind: "agent", section: "workflows", ...(id ? { id } : {}) });
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const names = useMemo(() => ({ connection: (id: string) => connections.find((one) => one.id === id)?.title ?? id }), [connections]);
  const startedBy = (id: string): string[] => agents.filter((agent) => agent.tools.some((tool) => tool.kind === "run_workflow" && tool.workflow === id)).map((agent) => agent.name);
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

  /* A workflow open: the builder, full width. */
  if (selected === NEW || current) {
    const state = current ? workflowState(current) : null;
    return (
      <div className="dash-workflow-page" data-testid="workflows-section">
        <div className="dash-agents__subhead">
          <button type="button" className="dash-overview__link" onClick={() => go()}>
            ← Workflows
          </button>
          {current && (
            <span className="dash-row">
              <Badge tone={state!.tone === "on" ? "accent" : state!.tone === "paused" ? "danger" : state!.tone === "trial" ? "warn" : "neutral"}>{state!.label}</Badge>
              <Button size="sm" tone={current.enabled && !current.parked ? "default" : "primary"} busy={busy} onClick={() => void act(() => api.setWorkflowEnabled(current.id, !(current.enabled && !current.parked)))} testId="workflow-toggle">
                {current.enabled && !current.parked ? "Turn off" : "Turn on"}
              </Button>
              {(current.trigger.kind !== "agent" || current.trigger.inputs.length === 0) && (
                <Button size="sm" busy={busy} onClick={() => void act(() => api.runWorkflow(current.id))} testId="workflow-run">
                  Run now
                </Button>
              )}
              <Button size="sm" tone="ghost" busy={busy} onClick={() => void act(async () => (await api.deleteWorkflow(current.id), go()))} testId="workflow-delete">
                Delete
              </Button>
            </span>
          )}
        </div>
        {actionError && (
          <p className="dash-callout dash-callout--bad" role="alert">
            {actionError}
          </p>
        )}
        {current?.parked && (
          <p className="dash-callout dash-callout--warn" role="status" data-testid="workflow-parked">
            Paused: {current.parked.reason} Turn it back on once that is fixed.
          </p>
        )}
        {loaded && (
          <WorkflowEditor
            key={current ? `${current.id}:${current.updatedAt}` : NEW}
            workflow={current}
            agents={agents.filter((agent) => !agent.archived)}
            workflows={workflows}
            connections={connections}
            templates={templates}
            onSaved={(saved) => {
              reload();
              go(saved.id);
            }}
            onCancel={() => go()}
            onTemplatesChanged={reload}
          />
        )}
        {current && (
          <>
            <h4 className="dash-workflow-editor__heading">Cases</h4>
            <CasesList workflow={current} reloadToken={reloadToken} onChanged={reload} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="dash-agents" data-testid="workflows-section">
      <aside className="dash-agents__list" aria-label="Workflows">
        <div className="dash-agents__head">
          <h2 className="dash-agents__title">Workflows</h2>
          <Button size="sm" tone="primary" onClick={() => go(NEW)} testId="workflow-new">
            ＋ New workflow
          </Button>
        </div>
        {loaded && workflows.length === 0 ? (
          <p className="dash-hint" data-testid="workflows-empty">
            No workflows yet. A workflow starts from a trigger and follows its steps. You can also ask the assistant to make one.
          </p>
        ) : (
          <ul className="dash-agents__rows">
            {workflows.map((workflow) => {
              const state = workflowState(workflow);
              return (
                <li key={workflow.id}>
                  <button type="button" className="dash-agent-row" data-testid={`workflow-row-${workflow.id}`} onClick={() => go(workflow.id)}>
                    <span className="dash-agent-row__title">
                      {workflow.name} <Badge tone={state.tone === "on" ? "accent" : state.tone === "paused" ? "danger" : state.tone === "trial" ? "warn" : "neutral"}>{state.label}</Badge>
                    </span>
                    <span className="dash-agent-row__reach">
                      {describeTrigger(workflow.trigger, { ...names, agents: startedBy(workflow.id) })} · {workflow.nodes.length} step{workflow.nodes.length === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {templates.length > 0 && (
          <>
            <h3 className="dash-workflow-editor__heading">Templates</h3>
            <ul className="dash-agents__rows" data-testid="templates">
              {templates.map((template) => (
                <li key={template.id} className="dash-template-row">
                  <span>
                    {template.name} <span className="dash-hint">{template.kind} · v{template.version}</span>
                  </span>
                  <span className="dash-row">
                    {template.kind === "workflow" && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void act(async () => {
                            const values: Record<string, string> = {};
                            for (const blank of template.blanks) values[blank.name] = blank.default ?? "";
                            const made = await api.workflowFromTemplate(template.id, values);
                            go(made.id);
                          })
                        }
                      >
                        Use
                      </Button>
                    )}
                    <Button size="sm" tone="ghost" onClick={() => void act(() => api.deleteTemplate(template.id))}>
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>

      <section className="dash-agents__detail" aria-live="polite">
        {actionError && (
          <p className="dash-callout dash-callout--bad" role="alert">
            {actionError}
          </p>
        )}
        <h3 className="dash-agents__subtitle">Waiting for you</h3>
        {waiting.length === 0 ? (
          <p className="dash-hint" data-testid="waiting-empty">
            Nothing is waiting. Steps set to Approve, questions for the team, and agents' requests to start a workflow appear here.
          </p>
        ) : (
          <ul className="dash-proposals" data-testid="waiting">
            {waiting.map((task) => (
              <TaskCard key={`${task.id}:${task.status}`} task={task} agent={task.agent ? agentById.get(task.agent) : undefined} onChanged={reload} />
            ))}
          </ul>
        )}
        {selected && !current && loaded && <EmptyState glyph="⇄" title="That workflow is not here" body="It may have been deleted." action={{ label: "Back to workflows", onClick: () => go() }} />}
      </section>
    </div>
  );
};
