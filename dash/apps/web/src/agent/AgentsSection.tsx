import { AgentChip, Button, EmptyState, ErrorState, agentColorVar } from "@freebirdai/dash-components";
import {
  AGENT_COLORS,
  summarizeReach,
  type AgentInput,
  type AgentSpec,
  type Scope,
} from "@freebirdai/dash-spec";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ConnectionSummary } from "../api";
import type { Route } from "../route.js";
import {
  REACH_CHOICES,
  addRow,
  reachFromRows,
  removeRow,
  rowKey,
  rowsFromReach,
  togglePermission,
  type ReachRow,
} from "./reach.js";

/**
 * Agents: the named AI workers a person sets up.
 *
 * A list on the left, an editor on the right. Each control here is also
 * something the chat can do (`create_agent`, `update_agent`, `archive_agent`),
 * because a thing you can click and cannot ask for is a thing the chat will be
 * blamed for not doing.
 */

type Entities = Record<string, Array<{ entity: string; name: string }>>;

const NEW = "new";

const useAgents = (reloadToken: number) => {
  const [state, setState] = useState<{
    agents: AgentSpec[];
    archived: AgentSpec[];
    connections: ConnectionSummary[];
    error: string | null;
    loaded: boolean;
  }>({ agents: [], archived: [], connections: [], error: null, loaded: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [all, connections] = await Promise.all([api.agents(true), api.connections()]);
        if (cancelled) return;
        setState({
          agents: all.filter((one) => !one.archived),
          archived: all.filter((one) => one.archived),
          connections,
          error: null,
          loaded: true,
        });
      } catch (cause) {
        if (!cancelled) {
          setState((held) => ({ ...held, error: cause instanceof Error ? cause.message : String(cause), loaded: true }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return state;
};

const Swatches = ({ value, onPick }: { value: number; onPick: (color: number) => void }): JSX.Element => (
  <div className="dash-swatches" role="radiogroup" aria-label="Colour">
    {Array.from({ length: AGENT_COLORS }, (_, index) => index + 1).map((color) => (
      <button
        key={color}
        type="button"
        role="radio"
        aria-checked={value === color}
        aria-label={`Colour ${color}`}
        className="dash-swatch"
        data-active={value === color}
        style={{ background: agentColorVar(color) }}
        data-testid={`agent-color-${color}`}
        onClick={() => onPick(color)}
      />
    ))}
  </div>
);

const ReachEditor = ({
  rows,
  onChange,
  connections,
  entities,
  loadEntities,
}: {
  rows: readonly ReachRow[];
  onChange: (rows: ReachRow[]) => void;
  connections: readonly ConnectionSummary[];
  entities: Entities;
  loadEntities: (connection: string) => void;
}): JSX.Element => {
  const [connection, setConnection] = useState("");
  const [entity, setEntity] = useState("");

  const titleOf = (id: string): string => connections.find((one) => one.id === id)?.title ?? id;
  const nameOf = (connectionId: string, id: string): string =>
    entities[connectionId]?.find((one) => one.entity === id)?.name ?? id;

  const scope: Scope = { ...(connection ? { connection } : {}), ...(connection && entity ? { entity } : {}) };

  return (
    <div className="dash-reach" data-testid="agent-reach">
      {rows.length === 0 && <p className="dash-hint">Nothing yet: this agent reads nothing and changes nothing.</p>}
      {rows.map((row) => (
        <div key={rowKey(row.scope)} className="dash-reach__row">
          <span className="dash-reach__where">
            {row.scope.connection
              ? row.scope.entity
                ? `${nameOf(row.scope.connection, row.scope.entity)} on ${titleOf(row.scope.connection)}`
                : `Everything on ${titleOf(row.scope.connection)}`
              : "Everything, on every connection"}
          </span>
          <span className="dash-reach__checks">
            {REACH_CHOICES.map((choice) => (
              <label key={choice.permission} className="dash-reach__check">
                <input
                  type="checkbox"
                  checked={row.permissions.includes(choice.permission)}
                  onChange={() => onChange(togglePermission(rows, row.scope, choice.permission))}
                />
                {choice.label}
              </label>
            ))}
          </span>
          <button
            type="button"
            className="dash-reach__remove"
            aria-label="Remove this access"
            onClick={() => onChange(removeRow(rows, row.scope))}
          >
            ✕
          </button>
        </div>
      ))}

      <div className="dash-reach__add">
        <select
          aria-label="Connection"
          value={connection}
          onChange={(event) => {
            setConnection(event.target.value);
            setEntity("");
            if (event.target.value) loadEntities(event.target.value);
          }}
        >
          <option value="">Every connection</option>
          {connections.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
        <select aria-label="Record type" value={entity} disabled={!connection} onChange={(event) => setEntity(event.target.value)}>
          <option value="">All record types</option>
          {(entities[connection] ?? []).map((one) => (
            <option key={one.entity} value={one.entity}>
              {one.name}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={() => onChange(addRow(rows, scope))} testId="agent-reach-add">
          Add access
        </Button>
      </div>
    </div>
  );
};

const Editor = ({
  agent,
  connections,
  onSaved,
  onCancel,
}: {
  /** Absent: a new agent. */
  agent: AgentSpec | null;
  connections: readonly ConnectionSummary[];
  onSaved: (saved: AgentSpec) => void;
  onCancel: () => void;
}): JSX.Element => {
  const [name, setName] = useState(agent?.name ?? "");
  const [color, setColor] = useState(agent?.color ?? 1);
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [rows, setRows] = useState<ReachRow[]>(() => rowsFromReach(agent?.reach ?? []));
  const [entities, setEntities] = useState<Entities>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntities = useCallback((connection: string) => {
    setEntities((held) => {
      if (held[connection]) return held;
      void api
        .connectionEntities(connection)
        .then((list) => setEntities((now) => ({ ...now, [connection]: list })))
        .catch(() => setEntities((now) => ({ ...now, [connection]: [] })));
      return { ...held, [connection]: [] };
    });
  }, []);

  /* Names for record types already in the reach, so a saved agent reads in words. */
  useEffect(() => {
    for (const row of rows) if (row.scope.connection && row.scope.entity) loadEntities(row.scope.connection);
    // Once, for what the agent arrived with.
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const input: AgentInput = {
      name: name.trim(),
      color,
      instructions,
      reach: reachFromRows(rows),
      ...(agent?.model ? { model: agent.model } : {}),
    };
    try {
      onSaved(await api.saveAgent(agent?.id ?? NEW, input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="dash-agent-editor"
      data-testid="agent-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="dash-field">
        <label htmlFor="agent-name">Name</label>
        <input id="agent-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Research helper" />
      </div>
      <div className="dash-field">
        <label>Colour</label>
        <Swatches value={color} onPick={setColor} />
        <span className="dash-hint">Everything this agent does is marked with it.</span>
      </div>
      <div className="dash-field">
        <label htmlFor="agent-instructions">Instructions</label>
        <textarea
          id="agent-instructions"
          rows={6}
          maxLength={8000}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="What this agent is for and how it should work."
        />
      </div>
      <div className="dash-field">
        <label>What it may touch</label>
        <ReachEditor rows={rows} onChange={setRows} connections={connections} entities={entities} loadEntities={loadEntities} />
        <span className="dash-hint">
          This is the most it can ever do. Anything it changes is still limited to what the person approving it may do.
        </span>
      </div>
      {error && (
        <p className="dash-callout dash-callout--bad" role="alert" data-testid="agent-error">
          {error}
        </p>
      )}
      <div className="dash-agent-editor__actions">
        <Button type="submit" tone="primary" busy={busy} disabled={name.trim() === ""} testId="agent-save">
          {agent ? "Save changes" : "Create agent"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
};

export const AgentsSection = ({
  selected,
  onNavigate,
}: {
  readonly selected: string | null;
  readonly onNavigate: (route: Route) => void;
}): JSX.Element => {
  const [reloadToken, setReloadToken] = useState(0);
  const { agents, archived, connections, error, loaded } = useAgents(reloadToken);
  const [showArchived, setShowArchived] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const reload = (): void => setReloadToken((n) => n + 1);

  const go = (id?: string): void => onNavigate({ kind: "agent", section: "agents", ...(id ? { id } : {}) });
  const names = useMemo(
    () => ({ connection: (id: string) => connections.find((one) => one.id === id)?.title ?? id }),
    [connections],
  );

  const current =
    selected && selected !== NEW ? ([...agents, ...archived].find((one) => one.id === selected) ?? null) : null;

  const toggleArchived = async (agent: AgentSpec): Promise<void> => {
    setActionError(null);
    try {
      if (agent.archived) await api.restoreAgent(agent.id);
      else await api.archiveAgent(agent.id);
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;

  const row = (agent: AgentSpec): JSX.Element => (
    <li key={agent.id}>
      <button
        type="button"
        className="dash-agent-row"
        data-active={agent.id === selected}
        data-testid={`agent-row-${agent.id}`}
        onClick={() => go(agent.id)}
      >
        <AgentChip name={agent.name} color={agent.color} />
        <span className="dash-agent-row__reach">{summarizeReach(agent.reach, names)}</span>
      </button>
    </li>
  );

  return (
    <div className="dash-agents">
      <aside className="dash-agents__list" aria-label="Agents">
        <div className="dash-agents__head">
          <h2 className="dash-agents__title">Agents</h2>
          <Button size="sm" tone="primary" onClick={() => go(NEW)} testId="agent-new">
            ＋ New agent
          </Button>
        </div>
        {loaded && agents.length === 0 ? (
          <p className="dash-hint" data-testid="agents-empty">
            No agents yet. An agent is a named AI worker with its own colour, instructions and limits on what it may touch.
          </p>
        ) : (
          <ul className="dash-agents__rows">{agents.map(row)}</ul>
        )}
        {archived.length > 0 && (
          <>
            <button type="button" className="dash-agents__toggle" onClick={() => setShowArchived((held) => !held)}>
              {showArchived ? "Hide" : "Show"} archived ({archived.length})
            </button>
            {showArchived && <ul className="dash-agents__rows dash-agents__rows--archived">{archived.map(row)}</ul>}
          </>
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
            <h3 className="dash-agents__subtitle">New agent</h3>
            <Editor
              key="new"
              agent={null}
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
              <h3 className="dash-agents__subtitle">
                <AgentChip name={current.name} color={current.color} />
                {current.archived && <span className="dash-hint"> archived</span>}
              </h3>
              <Button size="sm" onClick={() => void toggleArchived(current)} testId="agent-archive">
                {current.archived ? "Restore" : "Archive"}
              </Button>
            </div>
            <Editor
              key={`${current.id}:${current.updatedAt}`}
              agent={current}
              connections={connections}
              onSaved={() => reload()}
              onCancel={() => go()}
            />
          </>
        ) : loaded ? (
          <EmptyState
            glyph="✦"
            title={selected ? "That agent is not here" : "Pick an agent, or make one"}
            body="You can also ask the assistant to make one, for example: create an agent called Helper that can read one kind of record."
            action={{ label: "＋ New agent", onClick: () => go(NEW) }}
          />
        ) : null}
      </section>
    </div>
  );
};
