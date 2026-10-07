import { Button } from "@freebirdai/dash-components";
import {
  BASE_INFO,
  ON_FAILURE,
  actionVariant,
  fieldVisible,
  withDefaults,
  type ActionField,
  type AgentSpec,
  type WorkflowNode,
  type WorkflowSpec,
} from "@freebirdai/dash-spec";
import type { ConnectionSummary } from "../../api";
import { type Entities, ValuesEditor } from "./fields.jsx";

/**
 * The settings of one step, drawn from its catalog variant: each field the
 * way its kind wants (a template, a condition, a duration, a list, an agent,
 * a record type…), then the settings every step shares: its name, Auto or
 * Approve, only when, what to do on failure, and whether it can be reversed.
 */

const MODE_HINT = {
  auto: "Done during the run, with the permission of whoever saved the workflow.",
  approve: "Waits in “Waiting for you” until a person approves it.",
} as const;

const FAILURE_WORDS: Readonly<Record<(typeof ON_FAILURE)[number], string>> = {
  stop: "Stop the case",
  continue: "Carry on to the next step",
  path: "Follow its “failed” arrow",
};

const Field = ({
  field,
  value,
  onChange,
  connections,
  entities,
  loadEntities,
  agents,
  workflows,
  steps,
  connection,
}: {
  field: ActionField;
  value: unknown;
  onChange: (next: unknown) => void;
  connections: readonly ConnectionSummary[];
  entities: Entities;
  loadEntities: (connection: string) => void;
  agents: readonly AgentSpec[];
  workflows: readonly WorkflowSpec[];
  steps: readonly WorkflowNode[];
  /** The connection record types are listed from. */
  connection: string | undefined;
}): JSX.Element => {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const input = (placeholder?: string) => (
    <input className="dash-tool__when" aria-label={field.label} placeholder={placeholder ?? field.placeholder ?? ""} value={text} onChange={(event) => onChange(event.target.value)} />
  );
  let control: JSX.Element;
  switch (field.kind) {
    case "longtext":
      control = <textarea className="dash-tool__deny" aria-label={field.label} rows={3} placeholder={field.placeholder ?? ""} value={text} onChange={(event) => onChange(event.target.value)} />;
      break;
    case "number":
      control = <input className="dash-tool__when" type="number" aria-label={field.label} value={text} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />;
      break;
    case "boolean":
      control = (
        <label className="dash-reach__check">
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /> {field.label}
        </label>
      );
      break;
    case "select":
      control = (
        <select aria-label={field.label} value={text} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
      break;
    case "duration":
      control = input("2d");
      break;
    case "values":
      control = <ValuesEditor values={(value as Record<string, string> | undefined) ?? {}} onChange={(next) => onChange(next)} />;
      break;
    case "choices":
      control = (
        <input
          className="dash-tool__when"
          aria-label={field.label}
          placeholder="Separate with commas"
          value={Array.isArray(value) ? value.join(", ") : text}
          onChange={(event) => onChange(event.target.value.split(",").map((one) => one.trim()).filter((one, index, all) => one !== "" || index === all.length - 1))}
          onBlur={(event) => onChange(event.target.value.split(",").map((one) => one.trim()).filter(Boolean))}
        />
      );
      break;
    case "connection":
      control = (
        <select aria-label={field.label} value={text} onChange={(event) => (event.target.value && loadEntities(event.target.value), onChange(event.target.value || undefined))}>
          <option value="">The connection the workflow reads</option>
          {connections.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
      );
      break;
    case "record_type": {
      const list = connection ? (entities[connection] ?? []) : [];
      control =
        list.length > 0 ? (
          <select aria-label={field.label} value={text} onFocus={() => connection && loadEntities(connection)} onChange={(event) => onChange(event.target.value)}>
            <option value="">Pick a record type</option>
            {list.map((one) => (
              <option key={one.entity} value={one.entity}>
                {one.name}
              </option>
            ))}
            {text && !list.some((one) => one.entity === text) && <option value={text}>{text}</option>}
          </select>
        ) : (
          input("e.g. work_order")
        );
      break;
    }
    case "agent":
      control = (
        <select aria-label={field.label} value={text} onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">Pick an agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      );
      break;
    case "workflow":
      control = (
        <select aria-label={field.label} value={text} onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">Pick a workflow</option>
          {workflows.map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </select>
      );
      break;
    case "step":
      control = (
        <select aria-label={field.label} value={text} onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">Pick a step</option>
          {steps.map((one) => (
            <option key={one.id} value={one.id}>
              {one.name || actionVariant(one.action)?.label || one.id} ({one.id})
            </option>
          ))}
        </select>
      );
      break;
    default:
      control = input();
  }
  return (
    <label className="dash-workflow-field" data-required={field.required ?? false}>
      <span className="dash-workflow-field__label">
        {field.label}
        {field.required ? " *" : ""}
      </span>
      <span className="dash-workflow-field__control">
        {control}
        {field.help ? <span className="dash-hint">{field.help}</span> : null}
      </span>
    </label>
  );
};

export const StepPanel = ({
  node,
  nodes,
  trial,
  problems,
  connections,
  entities,
  loadEntities,
  agents,
  workflows,
  defaultConnection,
  onChange,
  onRemove,
  onSaveTemplate,
}: {
  node: WorkflowNode;
  nodes: readonly WorkflowNode[];
  trial: boolean;
  problems: readonly string[];
  connections: readonly ConnectionSummary[];
  entities: Entities;
  loadEntities: (connection: string) => void;
  agents: readonly AgentSpec[];
  workflows: readonly WorkflowSpec[];
  defaultConnection: string | undefined;
  onChange: (next: WorkflowNode) => void;
  onRemove: () => void;
  onSaveTemplate?: () => void;
}): JSX.Element => {
  const variant = actionVariant(node.action);
  if (!variant) {
    return (
      <div className="dash-step-panel">
        <p className="dash-callout dash-callout--bad">“{node.action}” is not an action this Dash knows.</p>
        <Button size="sm" tone="ghost" onClick={onRemove}>
          Remove this step
        </Button>
      </div>
    );
  }
  const settings = withDefaults(variant, node.settings);
  const set = (key: string, value: unknown) => {
    const next = { ...node.settings };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    onChange({ ...node, settings: next });
  };
  const connection = (typeof settings["connection"] === "string" && settings["connection"]) || defaultConnection;

  return (
    <div className="dash-step-panel" data-testid={`step-panel-${node.id}`}>
      <div className="dash-step-panel__head">
        <span className="dash-canvas__kind" data-base={variant.base}>
          {BASE_INFO[variant.base].label}
        </span>
        <strong>{variant.label}</strong>
      </div>
      <p className="dash-hint">{variant.does}</p>
      {problems.length > 0 && (
        <ul className="dash-step-panel__problems" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <label className="dash-workflow-field">
        <span className="dash-workflow-field__label">Name</span>
        <input className="dash-tool__when" aria-label="Step name" placeholder={variant.label} value={node.name ?? ""} onChange={(event) => onChange({ ...node, name: event.target.value })} />
      </label>

      {variant.fields
        .filter((field) => fieldVisible(field, settings))
        .map((field) => (
          <Field
            key={field.key}
            field={field}
            value={settings[field.key]}
            onChange={(value) => set(field.key, value)}
            connections={connections}
            entities={entities}
            loadEntities={loadEntities}
            agents={agents}
            workflows={workflows}
            steps={nodes.filter((one) => one.id !== node.id)}
            connection={connection}
          />
        ))}

      <h5 className="dash-workflow-editor__heading">Every step</h5>
      {variant.leavesDash && (
        <div className="dash-workflow-field">
          <span className="dash-workflow-field__label">Mode</span>
          <span className="dash-workflow-field__control">
            <span className="dash-tool__modes" role="radiogroup" aria-label="Auto or approve">
              {(["auto", "approve"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={node.mode === mode}
                  className="dash-tool__mode"
                  data-mode={mode}
                  data-active={node.mode === mode}
                  onClick={() => onChange({ ...node, mode })}
                  data-testid={`step-mode-${mode}`}
                >
                  {mode === "auto" ? "Auto" : "Approve"}
                </button>
              ))}
            </span>
            <span className="dash-hint">{trial ? "In trial, it asks for approval whatever this says. " : ""}{MODE_HINT[node.mode]}</span>
          </span>
        </div>
      )}
      <label className="dash-workflow-field">
        <span className="dash-workflow-field__label">Only when</span>
        <input className="dash-tool__when" aria-label="Only when" placeholder="Optional, e.g. cost >= 500" value={node.when ?? ""} onChange={(event) => onChange({ ...node, when: event.target.value })} />
      </label>
      <label className="dash-workflow-field">
        <span className="dash-workflow-field__label">If it fails</span>
        <select aria-label="If it fails" value={node.onFailure} onChange={(event) => onChange({ ...node, onFailure: event.target.value as WorkflowNode["onFailure"] })}>
          {ON_FAILURE.map((one) => (
            <option key={one} value={one}>
              {FAILURE_WORDS[one]}
            </option>
          ))}
        </select>
      </label>
      {variant.reversible && (
        <label className="dash-reach__check">
          <input type="checkbox" checked={node.reversible} onChange={(event) => onChange({ ...node, reversible: event.target.checked })} /> Offer Reverse on its tasks
        </label>
      )}

      <div className="dash-row">
        {onSaveTemplate && (
          <Button size="sm" onClick={onSaveTemplate} testId="step-save-template">
            Save as a template
          </Button>
        )}
        <Button size="sm" tone="ghost" onClick={onRemove} testId="step-remove">
          Remove step
        </Button>
      </div>
    </div>
  );
};
