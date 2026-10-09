import { AgentChip, Button, EmptyState, ErrorState, Tabs, agentColorVar } from "@freebirdai/dash-components";
import {
  AGENT_COLORS,
  composeResponsePrompt,
  summarizeReach,
  type AgentInput,
  type AgentKnowledge,
  type AgentSpec,
  type AgentTool,
  type Scope,
} from "@freebirdai/dash-spec";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ConnectionSummary } from "../api";
import type { Route } from "../route.js";
import { recordTypeChoices, type Entities } from "./entities.js";
import { GenerateField } from "./GenerateField.jsx";
import { usableRules } from "./ids.js";
import { KnowledgeEditor } from "./KnowledgeEditor.jsx";
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
import { ToolsEditor } from "./ToolsEditor.jsx";

/**
 * Agents: the named AI workers a person sets up.
 *
 * A list on the left, an editor on the right. The editor has four parts:
 * - **Replies**: name, colour, and the three parts of the prompt the agent
 *   replies with — role, instructions, personality — each with a Generate
 *   button. Laid over a base prompt every agent shares. Only for replies:
 *   workflows never use it.
 * - **Knowledge**: free text and context rules.
 * - **Tools**: what it may do in a conversation, each auto, approve or deny.
 * - **Access**: the most it may ever touch.
 *
 * Above the list, the knowledge every agent shares.
 *
 * Each control is also something the chat can do where it makes sense
 * (`create_agent`, `update_agent`, `archive_agent`), because a thing you can
 * click and cannot ask for is a thing the chat will be blamed for not doing.
 */

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


/** The id the shared knowledge page answers to; never an agent's, whose ids never start with "_". */
const SHARED = "_shared";

const EDITOR_TABS = [
  { id: "replies", label: "Replies" },
  { id: "knowledge", label: "Knowledge" },
  { id: "tools", label: "Tools" },
  { id: "access", label: "Access" },
] as const;
type EditorTab = (typeof EDITOR_TABS)[number]["id"];

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const Editor = ({
  agent,
  connections,
  shared,
  onSaved,
  onCancel,
}: {
  /** Absent: a new agent. */
  agent: AgentSpec | null;
  connections: readonly ConnectionSummary[];
  /** The knowledge every agent shares, for the prompt preview. */
  shared: AgentKnowledge | null;
  onSaved: (saved: AgentSpec) => void;
  onCancel: () => void;
}): JSX.Element => {
  const [tab, setTab] = useState<EditorTab>("replies");
  const [name, setName] = useState(agent?.name ?? "");
  const [color, setColor] = useState(agent?.color ?? 1);
  const [role, setRole] = useState(agent?.role ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [personality, setPersonality] = useState(agent?.personality ?? "");
  const [knowledge, setKnowledge] = useState<AgentKnowledge>(agent?.knowledge ?? { notes: "", context: [] });
  const [tools, setTools] = useState<AgentTool[]>(agent?.tools ?? []);
  const [rows, setRows] = useState<ReachRow[]>(() => rowsFromReach(agent?.reach ?? []));
  const [entities, setEntities] = useState<Entities>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntities = useCallback((connection: string) => {
    setEntities((held) => {
      if (held[connection]) return held;
      void api
        .connectionEntities(connection)
        .then((list) => setEntities((now) => ({ ...now, [connection]: recordTypeChoices(list) })))
        .catch(() => setEntities((now) => ({ ...now, [connection]: [] })));
      return { ...held, [connection]: [] };
    });
  }, []);

  /* Names for record types already in use, so a saved agent reads in words. */
  useEffect(() => {
    for (const row of rows) if (row.scope.connection && row.scope.entity) loadEntities(row.scope.connection);
    for (const tool of tools) if (tool.scope.connection) loadEntities(tool.scope.connection);
    // Once, for what the agent arrived with.
  }, []);

  const reach = reachFromRows(rows);
  const draft = { name: name.trim() || "this agent", role, instructions, personality, knowledge, tools };
  const preview = composeResponsePrompt({ agent: draft, shared });
  const about = { name: name.trim(), role };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const input: AgentInput = {
      name: name.trim(),
      color,
      role,
      instructions,
      personality,
      knowledge: { notes: knowledge.notes, context: usableRules(knowledge.context) },
      tools,
      reach,
      ...(agent?.model ? { model: agent.model } : {}),
    };
    try {
      onSaved(await api.saveAgent(agent?.id ?? NEW, input));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const active = tools.filter((tool) => tool.enabled).length;

  return (
    <form
      className="dash-agent-editor"
      data-testid="agent-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Tabs
        label="Agent settings"
        tabs={EDITOR_TABS.map((one) => ({
          ...one,
          ...(one.id === "tools" && tools.length > 0 ? { meta: `${active}/${tools.length}` } : {}),
          ...(one.id === "knowledge" && knowledge.context.length > 0 ? { meta: String(knowledge.context.length) } : {}),
        }))}
        activeId={tab}
        onSelect={(id) => setTab(id as EditorTab)}
      />

      <div className="dash-agent-editor__pane" hidden={tab !== "replies"}>
        <div className="dash-field">
          <label htmlFor="agent-name">Name</label>
          <input id="agent-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Research helper" />
        </div>
        <div className="dash-field">
          <label>Colour</label>
          <Swatches value={color} onPick={setColor} />
          <span className="dash-hint">Everything this agent does is marked with it.</span>
        </div>
        <p className="dash-hint dash-agent-editor__lede">
          These shape only the messages this agent writes to people. They sit on top of a base prompt every agent shares
          (honesty, privacy, when to hand off, how to write). Workflows never use them.
        </p>
        <GenerateField
          id="agent-role"
          label="Role"
          field="role"
          rows={3}
          maxLength={4000}
          value={role}
          onChange={setRole}
          agent={about}
          placeholder="You are a collections agent for [company]. You talk to residents who are behind on rent…"
          hint="Who it is, who it works for, who it talks to."
        />
        <GenerateField
          id="agent-instructions"
          label="Instructions"
          field="instructions"
          rows={6}
          maxLength={8000}
          value={instructions}
          onChange={setInstructions}
          agent={about}
          placeholder={"- DO NOT accept Friday as a pay date.\n- DO NOT take payment details over the phone."}
          hint="Specific rules your team has learned. These outrank personality."
        />
        <GenerateField
          id="agent-personality"
          label="Personality"
          field="personality"
          rows={3}
          maxLength={2000}
          value={personality}
          onChange={setPersonality}
          agent={about}
          placeholder="Firm and direct. Short sentences."
          hint="The tone of every message. It changes how things are said, never what the agent may do."
        />
        <details className="dash-agent-editor__preview">
          <summary>Preview the whole reply prompt</summary>
          <pre data-testid="agent-prompt-preview">{preview}</pre>
        </details>
      </div>

      <div className="dash-agent-editor__pane" hidden={tab !== "knowledge"}>
        <KnowledgeEditor
          knowledge={knowledge}
          onChange={setKnowledge}
          connections={connections}
          agent={about}
          notesHint="Only this agent knows this. Knowledge every agent shares is under Shared knowledge in the list."
        />
        <span className="dash-hint">A trigger can only read connections this agent may read (the Access tab).</span>
      </div>

      <div className="dash-agent-editor__pane" hidden={tab !== "tools"}>
        <ToolsEditor
          tools={tools}
          onChange={setTools}
          reach={reach}
          connections={connections}
          entities={entities}
          loadEntities={loadEntities}
        />
      </div>

      <div className="dash-agent-editor__pane" hidden={tab !== "access"}>
        <div className="dash-field">
          <label>What it may touch</label>
          <ReachEditor rows={rows} onChange={setRows} connections={connections} entities={entities} loadEntities={loadEntities} />
          <span className="dash-hint">
            This is the most it can ever do. Its tools and triggers stay inside it, and anything it changes is still limited to
            what the person approving it may do.
          </span>
        </div>
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

/** The knowledge every agent shares, beside its own. */
const SharedKnowledgePanel = ({
  shared,
  connections,
  onSaved,
}: {
  shared: AgentKnowledge;
  connections: readonly ConnectionSummary[];
  onSaved: () => void;
}): JSX.Element => {
  const [knowledge, setKnowledge] = useState<AgentKnowledge>(shared);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="dash-agent-editor"
      data-testid="shared-knowledge"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void api
          .saveSharedKnowledge({ notes: knowledge.notes, context: usableRules(knowledge.context) })
          .then(() => {
            setSaved(true);
            onSaved();
          })
          .catch((cause: unknown) => setError(errorText(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <p className="dash-hint dash-agent-editor__lede">
        Every agent knows this, beside its own knowledge. A trigger here reads only for agents that may read that connection.
      </p>
      <KnowledgeEditor
        knowledge={knowledge}
        onChange={(next) => {
          setSaved(false);
          setKnowledge(next);
        }}
        connections={connections}
        agent={{}}
        notesHint="Facts and policies that hold for the whole organisation."
      />
      {error && (
        <p className="dash-callout dash-callout--bad" role="alert">
          {error}
        </p>
      )}
      <div className="dash-agent-editor__actions">
        <Button type="submit" tone="primary" busy={busy} testId="shared-save">
          Save shared knowledge
        </Button>
        {saved && <span className="dash-hint">Saved.</span>}
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
  const [shared, setShared] = useState<AgentKnowledge | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const reload = (): void => setReloadToken((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    void api
      .sharedKnowledge()
      .then((held) => !cancelled && setShared({ notes: held.notes, context: held.context }))
      .catch(() => !cancelled && setShared({ notes: "", context: [] }));
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const go = (id?: string): void => onNavigate({ kind: "agent", section: "agents", ...(id ? { id } : {}) });
  const names = useMemo(
    () => ({ connection: (id: string) => connections.find((one) => one.id === id)?.title ?? id }),
    [connections],
  );

  const current =
    selected && selected !== NEW && selected !== SHARED
      ? ([...agents, ...archived].find((one) => one.id === selected) ?? null)
      : null;

  const toggleArchived = async (agent: AgentSpec): Promise<void> => {
    setActionError(null);
    try {
      if (agent.archived) await api.restoreAgent(agent.id);
      else await api.archiveAgent(agent.id);
      reload();
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;

  const row = (agent: AgentSpec): JSX.Element => {
    const active = agent.tools.filter((tool) => tool.enabled).length;
    return (
      <li key={agent.id}>
        <button
          type="button"
          className="dash-agent-row"
          data-active={agent.id === selected}
          data-testid={`agent-row-${agent.id}`}
          onClick={() => go(agent.id)}
        >
          <AgentChip name={agent.name} color={agent.color} />
          <span className="dash-agent-row__reach">
            {active > 0 ? `${active} tool${active === 1 ? "" : "s"} · ` : ""}
            {summarizeReach(agent.reach, names)}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="dash-agents">
      <aside className="dash-agents__list" aria-label="Agents">
        <div className="dash-agents__head">
          <h2 className="dash-agents__title">Agents</h2>
          <Button size="sm" tone="primary" onClick={() => go(NEW)} testId="agent-new">
            ＋ New agent
          </Button>
        </div>
        <button
          type="button"
          className="dash-agent-row dash-agent-row--shared"
          data-active={selected === SHARED}
          data-testid="agent-row-shared"
          onClick={() => go(SHARED)}
        >
          <span className="dash-agent-row__title">Shared knowledge</span>
          <span className="dash-agent-row__reach">Applies to every agent</span>
        </button>
        {loaded && agents.length === 0 ? (
          <p className="dash-hint" data-testid="agents-empty">
            No agents yet. An agent is a named AI worker that replies to messages and uses the tools you give it.
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
        {selected === SHARED ? (
          <>
            <h3 className="dash-agents__subtitle">Shared knowledge</h3>
            {shared ? (
              <SharedKnowledgePanel key={JSON.stringify(shared)} shared={shared} connections={connections} onSaved={reload} />
            ) : null}
          </>
        ) : selected === NEW ? (
          <>
            <h3 className="dash-agents__subtitle">New agent</h3>
            <Editor
              key="new"
              agent={null}
              connections={connections}
              shared={shared}
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
              shared={shared}
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
