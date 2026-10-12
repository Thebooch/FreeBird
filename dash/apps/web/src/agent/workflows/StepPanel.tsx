import { Button } from "@freebirdai/dash-components";
import { useEffect, useState } from "react";
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
import { api, type ConnectionSummary, type ReportView } from "../../api";
import type { Entities } from "../entities.js";
import { ValuesEditor } from "./fields.jsx";

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

/** The team's timed reports, read when a Send a report step is opened. */
const ReportSelect = ({ label, value, onChange }: { label: string; value: string; onChange: (next: unknown) => void }): JSX.Element => {
  const [reports, setReports] = useState<ReportView[] | null>(null);
  useEffect(() => {
    api.reports().then(
      (answer) => setReports(answer.reports),
      () => setReports([]),
    );
  }, []);
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value || undefined)}>
      <option value="">{reports === null ? "Loading…" : reports.length === 0 ? "No reports yet: make one from a tab's ⋯ menu" : "Pick a report"}</option>
      {(reports ?? []).map((one) => (
        <option key={one.id} value={one.id}>
          {one.name}
        </option>
      ))}
      {value && reports && !reports.some((one) => one.id === value) && <option value={value}>{value}</option>}
    </select>
  );
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
    case "report":
      control = <ReportSelect label={field.label} value={text} onChange={onChange} />;
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

/** "Contact type is …": the types the match rules give, written into Only when as a condition. */
export const contactTypeCondition = (type: string): string =>
  type === "" ? "len(contact.types) == 0" : `contains(contact.types, ${JSON.stringify(type)})`;

/** "Contact type is …" and "Contact field …": conditions on the contact a case is about, written into Only when. */
const ContactTypePick = ({ onPick }: { readonly onPick: (condition: string) => void }): JSX.Element | null => {
  const [types, setTypes] = useState<readonly string[]>([]);
  const [fields, setFields] = useState<readonly { readonly key: string; readonly label: string; readonly kind: string }[]>([]);
  useEffect(() => {
    void api.contactSetup().then(
      (setup) => {
        setTypes([...new Set(setup.matchRules.flatMap((rule) => (rule.type?.trim() ? [rule.type.trim()] : [])))]);
        setFields(setup.fields.map((one) => ({ key: one.key, label: one.label, kind: one.kind })));
      },
      () => setTypes([]),
    );
  }, []);
  if (types.length === 0 && fields.length === 0) return null;
  return (
    <span className="dash-workflow-field__picks">
      {types.length > 0 && (
        <select
          aria-label="Contact type is"
          value=""
          onChange={(event) => {
            if (event.target.value === "") return;
            onPick(contactTypeCondition(event.target.value === "(none)" ? "" : event.target.value));
          }}
        >
          <option value="">Contact type is…</option>
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
          <option value="(none)">No type yet (someone unknown)</option>
        </select>
      )}
      {fields.length > 0 && (
        <select
          aria-label="Contact field"
          value=""
          onChange={(event) => {
            const field = fields.find((one) => one.key === event.target.value);
            if (field) onPick(contactFieldCondition(field.key, field.kind));
          }}
        >
          <option value="">Contact field…</option>
          {fields.map((field) => (
            <option key={field.key} value={field.key}>
              {field.label}
            </option>
          ))}
        </select>
      )}
    </span>
  );
};

/** A condition on one contact field to finish in place: it has a value, or equals one. */
export const contactFieldCondition = (key: string, kind: string): string =>
  kind === "boolean" ? `contact.${key} == true` : kind === "number" ? `contact.${key} >= 0` : `contact.${key} != ""`;

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
        <ContactTypePick onPick={(condition) => onChange({ ...node, when: node.when?.trim() ? `${node.when.trim()} and ${condition}` : condition })} />
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
