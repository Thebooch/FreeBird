import { AgentChip, Badge, ErrorState } from "@freebirdai/dash-components";
import type { AgentSpec, WorkflowSpec } from "@freebirdai/dash-spec";
import { useEffect, useMemo, useState } from "react";
import { api, type AgentOverview } from "../../api";
import type { Route } from "../../route.js";
import { NO_FILTER, byDay, keepActive, keepCompleted, taskLabel, tasksIn, type OverviewFilter } from "./filter.js";

/**
 * The Agent side's first page: what is going on, and what has been done.
 *
 * **Active workflows**: each that is on or has something waiting — the stage
 * it is at and what it is waiting for (your approval, its schedule, an API
 * change, an agent being asked, or somebody to turn it back on).
 * **Completed tasks**: everything done, newest first, by day.
 *
 * Both filter by agent, task and workflow. Refreshed every 15 seconds while
 * open, so a running workflow's stage moves on by itself.
 */

const REFRESH_MS = 15_000;

const STATE: Readonly<Record<AgentOverview["active"][number]["state"], { label: string; tone: "accent" | "warn" | "neutral" | "danger" }>> = {
  running: { label: "Running", tone: "accent" },
  waiting_approval: { label: "Needs approval", tone: "warn" },
  paused: { label: "Paused", tone: "danger" },
  waiting_schedule: { label: "Scheduled", tone: "neutral" },
  waiting_trigger: { label: "Watching", tone: "neutral" },
  waiting_agent: { label: "Waiting for an agent", tone: "neutral" },
};

const time = (iso: string | undefined, withDay = true): string => {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString(undefined, withDay ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" });
};

export const OverviewSection = ({ onNavigate }: { readonly onNavigate: (route: Route) => void }): JSX.Element => {
  const [overview, setOverview] = useState<AgentOverview | null>(null);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSpec[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<OverviewFilter>(NO_FILTER);
  const [token, setToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.overview(), api.agents(true), api.workflows()])
      .then(([next, agentList, workflowList]) => {
        if (cancelled) return;
        setOverview(next);
        setAgents(agentList);
        setWorkflows(workflowList);
        setError(null);
      })
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)));
    const timer = setTimeout(() => setToken((n) => n + 1), REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token]);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const tasks = useMemo(() => (overview ? tasksIn(overview) : []), [overview]);

  if (error && !overview) return <ErrorState message={error} onRetry={() => setToken((n) => n + 1)} />;
  if (!overview) return <p className="dash-hint">Loading…</p>;

  const active = overview.active.filter((one) => keepActive(one, filter));
  const completed = overview.completed.filter((one) => keepCompleted(one, filter));
  const filtered = filter.agent !== "" || filter.task !== "" || filter.workflow !== "";
  const openWorkflow = (id: string | undefined) => onNavigate({ kind: "agent", section: "workflows", ...(id ? { id } : {}) });
  const chip = (id: string) => {
    const agent = agentById.get(id);
    return agent ? <AgentChip key={id} name={agent.name} color={agent.color} size="sm" /> : null;
  };

  return (
    <div className="dash-overview" data-testid="agent-overview">
      <div className="dash-overview__filters" role="group" aria-label="Filter">
        <select aria-label="Agent" value={filter.agent} onChange={(event) => setFilter({ ...filter, agent: event.target.value })} data-testid="overview-filter-agent">
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <select aria-label="Task" value={filter.task} onChange={(event) => setFilter({ ...filter, task: event.target.value })} data-testid="overview-filter-task">
          <option value="">All tasks</option>
          {tasks.map((task) => (
            <option key={task} value={task}>
              {taskLabel(task)}
            </option>
          ))}
        </select>
        <select aria-label="Workflow" value={filter.workflow} onChange={(event) => setFilter({ ...filter, workflow: event.target.value })} data-testid="overview-filter-workflow">
          <option value="">All workflows</option>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </select>
        {filtered && (
          <button type="button" className="dash-agents__toggle" onClick={() => setFilter(NO_FILTER)}>
            Clear filters
          </button>
        )}
      </div>

      <section className="dash-agents__detail dash-overview__panel" aria-labelledby="overview-active">
        <h2 id="overview-active" className="dash-agents__title">
          Active workflows <span className="dash-hint">{active.length}</span>
        </h2>
        {active.length === 0 ? (
          <p className="dash-hint" data-testid="overview-active-empty">
            {filtered ? "Nothing active matches these filters." : "No workflow is on. Turn one on in Workflows, and it shows here with what it is waiting for."}
          </p>
        ) : (
          <ul className="dash-proposals" data-testid="overview-active">
            {active.map((item) => (
              <li key={item.workflow} className="dash-overview__item" data-state={item.state}>
                <div className="dash-proposal__head">
                  <button type="button" className="dash-overview__link" onClick={() => openWorkflow(item.workflow)}>
                    {item.name}
                  </button>
                  <Badge tone={STATE[item.state].tone}>{STATE[item.state].label}</Badge>
                  {item.agents.map(chip)}
                </div>
                <div className="dash-overview__facts">
                  <span>
                    <span className="dash-overview__fact">Stage</span> {item.stage}
                  </span>
                  <span>
                    <span className="dash-overview__fact">Waiting for</span>{" "}
                    {item.state === "waiting_approval" ? (
                      <button type="button" className="dash-overview__link" onClick={() => openWorkflow(undefined)}>
                        {item.waitingFor}
                      </button>
                    ) : (
                      item.waitingFor
                    )}
                    {item.nextAt ? ` · next ${time(item.nextAt)}` : ""}
                  </span>
                  {item.since && <span className="dash-hint">Since {time(item.since)}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dash-agents__detail dash-overview__panel" aria-labelledby="overview-completed">
        <h2 id="overview-completed" className="dash-agents__title">
          Completed tasks <span className="dash-hint">{completed.length}</span>
        </h2>
        {completed.length === 0 ? (
          <p className="dash-hint" data-testid="overview-completed-empty">
            {filtered ? "Nothing completed matches these filters." : "Nothing done yet. Each step a workflow does, and each change you approve, shows here."}
          </p>
        ) : (
          <div data-testid="overview-completed">
            {byDay(completed).map((group) => (
              <div key={group.day} className="dash-overview__day">
                <h3 className="dash-workflow-editor__heading">{group.day}</h3>
                <ul className="dash-overview__timeline">
                  {group.items.map((item) => (
                    <li key={item.id} className="dash-overview__done">
                      <span className="dash-overview__time">{time(item.at, false)}</span>
                      <span className="dash-overview__what">
                        <span className="dash-overview__task">{taskLabel(item.task)}</span> {item.title}
                        <span className="dash-hint">
                          {item.workflowName ? (
                            <>
                              {" · "}
                              <button type="button" className="dash-overview__link" onClick={() => openWorkflow(item.workflow)}>
                                {item.workflowName}
                              </button>
                            </>
                          ) : null}
                        </span>
                      </span>
                      {item.agent && chip(item.agent)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
