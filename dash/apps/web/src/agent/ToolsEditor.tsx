import { Button } from "@freebirdai/dash-components";
import {
  AGENT_TOOL_INFO,
  AGENT_TOOL_KINDS,
  reachCovers,
  type AgentReach,
  type AgentTool,
  type AgentToolKind,
  type AgentToolMode,
} from "@freebirdai/dash-spec";
import { useState } from "react";
import type { ConnectionSummary } from "../api";
import { newToolId } from "./ids.js";

/**
 * What an agent may do in a conversation.
 *
 * Each tool is on or off, and set to one of three modes:
 * - Auto: it does it, then tells the person what it did.
 * - Approve: it tells the person the team will look into it, and the team gets
 *   an approval request.
 * - Deny: it understands the request and declines, answering the way the
 *   tool's reply says.
 *
 * A record tool can only act within what the agent may touch (the Access
 * tab); one that would act beyond it is flagged here and refused on save.
 */

type Entities = Record<string, Array<{ entity: string; name: string }>>;

const MODES: ReadonlyArray<{ readonly id: AgentToolMode; readonly label: string; readonly hint: string }> = [
  { id: "auto", label: "Auto", hint: "Does it, then tells them what it did." },
  { id: "approve", label: "Approve", hint: "Tells them the team will look into it; the team gets an approval request." },
  { id: "deny", label: "Deny", hint: "Declines, answering the way you say below." },
];

/** Workflows arrive with plan 2; until then the kind is shown but cannot be added. */
const AVAILABLE = (kind: AgentToolKind): boolean => kind !== "run_workflow";

const ToolRow = ({
  tool,
  reach,
  connections,
  entities,
  loadEntities,
  onChange,
  onRemove,
}: {
  tool: AgentTool;
  reach: readonly AgentReach[];
  connections: readonly ConnectionSummary[];
  entities: Entities;
  loadEntities: (connection: string) => void;
  onChange: (next: AgentTool) => void;
  onRemove: () => void;
}): JSX.Element => {
  const info = AGENT_TOOL_INFO[tool.kind];
  const beyond = tool.enabled && tool.mode !== "deny" && info.permission !== undefined && !reachCovers(reach, info.permission, tool.scope);

  return (
    <div className="dash-tool" data-enabled={tool.enabled} data-testid={`agent-tool-${tool.id}`}>
      <div className="dash-tool__head">
        <label className="dash-tool__on">
          <input
            type="checkbox"
            checked={tool.enabled}
            aria-label={tool.enabled ? "Active" : "Inactive"}
            onChange={(event) => onChange({ ...tool, enabled: event.target.checked })}
          />
          <span className="dash-tool__name">{tool.label || info.label}</span>
        </label>
        <span className="dash-tool__modes" role="radiogroup" aria-label="What it does">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={tool.mode === mode.id}
              className="dash-tool__mode"
              data-mode={mode.id}
              data-active={tool.mode === mode.id}
              title={mode.hint}
              onClick={() => onChange({ ...tool, mode: mode.id })}
            >
              {mode.label}
            </button>
          ))}
        </span>
        <button type="button" className="dash-reach__remove" aria-label="Remove this tool" onClick={onRemove}>
          ✕
        </button>
      </div>

      <div className="dash-tool__body">
        <span className="dash-hint">{MODES.find((mode) => mode.id === tool.mode)?.hint}</span>
        {info.scoped && (
          <div className="dash-reach__add">
            <select
              aria-label="Connection"
              value={tool.scope.connection ?? ""}
              onChange={(event) => {
                const connection = event.target.value;
                if (connection) loadEntities(connection);
                onChange({ ...tool, scope: connection ? { connection } : {} });
              }}
            >
              <option value="">Any connection it may touch</option>
              {connections.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
            <select
              aria-label="Record type"
              value={tool.scope.entity ?? ""}
              disabled={!tool.scope.connection}
              onFocus={() => tool.scope.connection && loadEntities(tool.scope.connection)}
              onChange={(event) =>
                onChange({
                  ...tool,
                  scope: { connection: tool.scope.connection!, ...(event.target.value ? { entity: event.target.value } : {}) },
                })
              }
            >
              <option value="">All record types</option>
              {(entities[tool.scope.connection ?? ""] ?? []).map((one) => (
                <option key={one.entity} value={one.entity}>
                  {one.name}
                </option>
              ))}
              {tool.scope.entity && !(entities[tool.scope.connection ?? ""] ?? []).some((one) => one.entity === tool.scope.entity) && (
                <option value={tool.scope.entity}>{tool.scope.entity}</option>
              )}
            </select>
          </div>
        )}
        <input
          className="dash-tool__when"
          aria-label="When to use it"
          placeholder="When to use it (optional), e.g. when they ask to set up a payment plan"
          maxLength={1000}
          value={tool.whenToUse}
          onChange={(event) => onChange({ ...tool, whenToUse: event.target.value })}
        />
        {tool.mode === "deny" && (
          <textarea
            className="dash-tool__deny"
            aria-label="How to reply instead"
            rows={2}
            maxLength={1000}
            placeholder="How to reply instead, e.g. Payments can't be taken by phone; point them to the online portal."
            value={tool.denyReply}
            onChange={(event) => onChange({ ...tool, denyReply: event.target.value })}
          />
        )}
        {beyond && (
          <span className="dash-hint dash-tool__warn" role="alert">
            This needs {info.permission?.replace("records.", "")} access in the Access tab before it can be Auto or Approve.
          </span>
        )}
      </div>
    </div>
  );
};

export const ToolsEditor = ({
  tools,
  onChange,
  reach,
  connections,
  entities,
  loadEntities,
}: {
  tools: readonly AgentTool[];
  onChange: (next: AgentTool[]) => void;
  reach: readonly AgentReach[];
  connections: readonly ConnectionSummary[];
  entities: Entities;
  loadEntities: (connection: string) => void;
}): JSX.Element => {
  const [kind, setKind] = useState<AgentToolKind>("look_up_record");

  return (
    <div className="dash-tools" data-testid="agent-tools">
      {tools.length === 0 && (
        <p className="dash-hint">No tools yet: this agent can answer from what it knows, and hands anything else to the team.</p>
      )}
      {tools.map((tool, index) => (
        <ToolRow
          key={tool.id}
          tool={tool}
          reach={reach}
          connections={connections}
          entities={entities}
          loadEntities={loadEntities}
          onChange={(next) => onChange(tools.map((one, at) => (at === index ? next : one)))}
          onRemove={() => onChange(tools.filter((_, at) => at !== index))}
        />
      ))}
      <div className="dash-reach__add">
        <select aria-label="Tool" value={kind} onChange={(event) => setKind(event.target.value as AgentToolKind)}>
          {AGENT_TOOL_KINDS.map((one) => (
            <option key={one} value={one} disabled={!AVAILABLE(one)}>
              {AGENT_TOOL_INFO[one].label}
              {AVAILABLE(one) ? "" : " (once workflows exist)"}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!AVAILABLE(kind) || tools.length >= 60}
          onClick={() =>
            onChange([
              ...tools,
              {
                id: newToolId(kind, tools.map((one) => one.id)),
                kind,
                enabled: true,
                mode: AGENT_TOOL_INFO[kind].defaultMode,
                scope: {},
                whenToUse: "",
                denyReply: "",
              },
            ])
          }
          testId="agent-tool-add"
        >
          Add tool
        </Button>
      </div>
    </div>
  );
};
