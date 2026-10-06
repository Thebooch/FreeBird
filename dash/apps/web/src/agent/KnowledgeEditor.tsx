import { Button } from "@freebirdai/dash-components";
import type { AgentKnowledge, ContextRule } from "@freebirdai/dash-spec";
import { useState } from "react";
import type { ConnectionSummary } from "../api";
import { GenerateField } from "./GenerateField.jsx";
import { newRuleId } from "./ids.js";

/**
 * What an agent knows: free text, and context rules.
 *
 * A context rule is a trigger in plain words ("someone mentions an address")
 * and the endpoints to read when it fires. The tool the model calls is always
 * the same one; only what sets it off and where it looks change, and what it
 * finds goes into the reply as context. Used for one agent's knowledge and for
 * the knowledge every agent shares.
 */

const RuleRow = ({
  rule,
  connections,
  onChange,
  onRemove,
}: {
  rule: ContextRule;
  connections: readonly ConnectionSummary[];
  onChange: (next: ContextRule) => void;
  onRemove: () => void;
}): JSX.Element => {
  const [connection, setConnection] = useState(connections[0]?.id ?? "");
  const [op, setOp] = useState("");
  const ops = connections.find((one) => one.id === connection)?.ops ?? [];
  const titleOf = (connectionId: string, opId: string): string => {
    const found = connections.find((one) => one.id === connectionId);
    return `${found?.ops.find((one) => one.id === opId)?.title ?? opId} · ${found?.title ?? connectionId}`;
  };

  return (
    <div className="dash-rule" data-testid={`agent-rule-${rule.id}`}>
      <div className="dash-rule__head">
        <label className="dash-rule__on">
          <input type="checkbox" checked={rule.enabled} onChange={(event) => onChange({ ...rule, enabled: event.target.checked })} />
          When
        </label>
        <input
          className="dash-rule__trigger"
          aria-label="When this happens"
          value={rule.trigger}
          maxLength={300}
          placeholder="someone mentions an address"
          onChange={(event) => onChange({ ...rule, trigger: event.target.value })}
        />
        <button type="button" className="dash-reach__remove" aria-label="Remove this rule" onClick={onRemove}>
          ✕
        </button>
      </div>
      <div className="dash-rule__sources">
        <span className="dash-hint">look in</span>
        {rule.sources.length === 0 && <span className="dash-hint">nothing yet: add an endpoint</span>}
        {rule.sources.map((source) => (
          <span key={`${source.connection}/${source.op}`} className="dash-rule__chip">
            {titleOf(source.connection, source.op)}
            <button
              type="button"
              aria-label="Remove this endpoint"
              onClick={() =>
                onChange({ ...rule, sources: rule.sources.filter((one) => one.connection !== source.connection || one.op !== source.op) })
              }
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="dash-reach__add">
        <select aria-label="Connection" value={connection} onChange={(event) => { setConnection(event.target.value); setOp(""); }}>
          {connections.length === 0 && <option value="">No connections yet</option>}
          {connections.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
        <select aria-label="Endpoint" value={op} disabled={!connection} onChange={(event) => setOp(event.target.value)}>
          <option value="">Pick an endpoint</option>
          {ops.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title || one.id}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!connection || !op || rule.sources.length >= 10}
          onClick={() => {
            if (rule.sources.some((one) => one.connection === connection && one.op === op)) return;
            onChange({ ...rule, sources: [...rule.sources, { connection, op }] });
            setOp("");
          }}
        >
          Add endpoint
        </Button>
      </div>
    </div>
  );
};

export const KnowledgeEditor = ({
  knowledge,
  onChange,
  connections,
  agent,
  notesHint,
}: {
  knowledge: AgentKnowledge;
  onChange: (next: AgentKnowledge) => void;
  connections: readonly ConnectionSummary[];
  agent: { name?: string; role?: string };
  notesHint: string;
}): JSX.Element => (
  <div className="dash-knowledge">
    <GenerateField
      id="knowledge-notes"
      label="Knowledge"
      field="knowledge"
      rows={8}
      maxLength={20000}
      value={knowledge.notes}
      onChange={(notes) => onChange({ ...knowledge, notes })}
      agent={agent}
      placeholder="Office hours, policies, answers to common questions…"
      hint={notesHint}
    />

    <div className="dash-field">
      <label>Context aware</label>
      <span className="dash-hint">
        When a message matches a trigger, the agent reads the endpoints you pick and uses what it finds in its reply.
      </span>
      <div className="dash-rules">
        {knowledge.context.map((rule, index) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            connections={connections}
            onChange={(next) => onChange({ ...knowledge, context: knowledge.context.map((one, at) => (at === index ? next : one)) })}
            onRemove={() => onChange({ ...knowledge, context: knowledge.context.filter((_, at) => at !== index) })}
          />
        ))}
      </div>
      <div>
        <Button
          size="sm"
          disabled={knowledge.context.length >= 50}
          onClick={() =>
            onChange({
              ...knowledge,
              context: [...knowledge.context, { id: newRuleId(knowledge.context.map((one) => one.id)), trigger: "", sources: [], enabled: true }],
            })
          }
          testId="agent-rule-add"
        >
          ＋ Add a trigger
        </Button>
      </div>
    </div>
  </div>
);
