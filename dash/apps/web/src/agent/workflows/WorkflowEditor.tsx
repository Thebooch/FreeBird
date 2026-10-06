import { Button } from "@freebirdai/dash-components";
import {
  MESSAGE_CHANNELS,
  WORKFLOW_EVERY,
  WORKFLOW_STEP_INFO,
  WORKFLOW_STEP_KINDS,
  describeCron,
  type AgentSpec,
  type WorkflowInput,
  type WorkflowInputDef,
  type WorkflowSource,
  type WorkflowSpec,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowTrigger,
} from "@freebirdai/dash-spec";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ConnectionSummary, type WorkflowPreview } from "../../api";
import { TRIGGER_CHOICES, blankStep, blankTrigger, fromSpec, toInput } from "./draft.js";

/**
 * Setting up a workflow: a trigger, what it reads, which rows matter, and its
 * steps.
 *
 * Each step that reaches outside Dash has an **Auto / Approve** switch: approve
 * puts it in "Waiting for you"; auto does it in the run, with the permission
 * of whoever saves the workflow. A step's "Only when" condition is what makes
 * a path: auto for small ones, approve for large ones. Calendar entries and
 * notes stay inside Dash and are always done.
 *
 * Preview runs it dry, as you: how many records match the criteria (live, as
 * you type), and the path each would take.
 */

type Entities = Record<string, Array<{ entity: string; name: string }>>;

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const MODES = [
  { id: "auto", label: "Auto", hint: "Done during the run, with the permission of whoever saved the workflow." },
  { id: "approve", label: "Approve", hint: "Waits in “Waiting for you” until a person reviews and applies it." },
] as const;

const EVERY_LABEL: Readonly<Record<(typeof WORKFLOW_EVERY)[number], string>> = {
  "5m": "every 5 minutes",
  "15m": "every 15 minutes",
  "1h": "every hour",
  "6h": "every 6 hours",
  "1d": "every day",
};

const RecordPicker = ({
  connection,
  record,
  connections,
  entities,
  loadEntities,
  onChange,
  allowNone,
}: {
  connection: string;
  record: string;
  connections: readonly ConnectionSummary[];
  entities: Entities;
  loadEntities: (connection: string) => void;
  onChange: (next: { connection: string; record: string }) => void;
  allowNone?: string;
}): JSX.Element => (
  <div className="dash-reach__add">
    <select
      aria-label="Connection"
      value={connection}
      onChange={(event) => {
        if (event.target.value) loadEntities(event.target.value);
        onChange({ connection: event.target.value, record: "" });
      }}
    >
      <option value="">{allowNone ?? "Pick a connection"}</option>
      {connections.map((one) => (
        <option key={one.id} value={one.id}>
          {one.title}
        </option>
      ))}
    </select>
    <select
      aria-label="Record type"
      value={record}
      disabled={!connection}
      onFocus={() => connection && loadEntities(connection)}
      onChange={(event) => onChange({ connection, record: event.target.value })}
    >
      <option value="">Pick a record type</option>
      {(entities[connection] ?? []).map((one) => (
        <option key={one.entity} value={one.entity}>
          {one.name}
        </option>
      ))}
      {record && !(entities[connection] ?? []).some((one) => one.entity === record) && <option value={record}>{record}</option>}
    </select>
  </div>
);

const InputsEditor = ({ inputs, onChange }: { inputs: readonly WorkflowInputDef[]; onChange: (next: WorkflowInputDef[]) => void }): JSX.Element => (
  <div className="dash-tools">
    <span className="dash-hint">
      What the agent asks the person for before it can start this. Steps read each one as {"{{ input.name }}"}.
    </span>
    {inputs.map((one, index) => (
      <div key={index} className="dash-reach__add">
        <input
          className="dash-tool__when dash-workflow__short"
          aria-label="Input name"
          placeholder="name"
          value={one.name}
          onChange={(event) => onChange(inputs.map((each, at) => (at === index ? { ...each, name: event.target.value.replace(/[^a-zA-Z0-9_]/g, "") } : each)))}
        />
        <input
          className="dash-tool__when"
          aria-label="What to ask for"
          placeholder="What to ask for, e.g. Which unit is moving out"
          value={one.description}
          onChange={(event) => onChange(inputs.map((each, at) => (at === index ? { ...each, description: event.target.value } : each)))}
        />
        <label className="dash-reach__check">
          <input
            type="checkbox"
            checked={one.required}
            onChange={(event) => onChange(inputs.map((each, at) => (at === index ? { ...each, required: event.target.checked } : each)))}
          />
          Required
        </label>
        <button type="button" className="dash-reach__remove" aria-label="Remove this input" onClick={() => onChange(inputs.filter((_, at) => at !== index))}>
          ✕
        </button>
      </div>
    ))}
    <div>
      <Button size="sm" disabled={inputs.length >= 12} onClick={() => onChange([...inputs, { name: "", description: "", required: true }])}>
        Add input
      </Button>
    </div>
  </div>
);

const TriggerEditor = ({
  trigger,
  onChange,
  connections,
  entities,
  loadEntities,
}: {
  trigger: WorkflowTrigger;
  onChange: (next: WorkflowTrigger) => void;
  connections: readonly ConnectionSummary[];
  entities: Entities;
  loadEntities: (connection: string) => void;
}): JSX.Element => (
  <div className="dash-tools" data-testid="workflow-trigger">
    <select aria-label="Trigger" value={trigger.kind} onChange={(event) => onChange(blankTrigger(event.target.value as WorkflowTrigger["kind"], trigger))}>
      {TRIGGER_CHOICES.map((one) => (
        <option key={one.kind} value={one.kind}>
          {one.label}
        </option>
      ))}
    </select>
    {(trigger.kind === "record_created" || trigger.kind === "record_changed") && (
      <>
        <RecordPicker
          connection={trigger.connection}
          record={trigger.record}
          connections={connections}
          entities={entities}
          loadEntities={loadEntities}
          onChange={(where) => onChange({ ...trigger, ...where })}
        />
        {trigger.kind === "record_changed" && (
          <input
            className="dash-tool__when"
            aria-label="Fields to watch"
            placeholder="Fields to watch, comma separated (leave empty for any change)"
            value={(trigger.fields ?? []).join(", ")}
            onChange={(event) => {
              const fields = event.target.value.split(",").map((one) => one.trim()).filter(Boolean);
              const { fields: _old, ...rest } = trigger;
              onChange(fields.length > 0 ? { ...rest, fields } : rest);
            }}
          />
        )}
        <label className="dash-hint">
          Checked{" "}
          <select aria-label="How often to check" value={trigger.every} onChange={(event) => onChange({ ...trigger, every: event.target.value as typeof trigger.every })}>
            {WORKFLOW_EVERY.map((one) => (
              <option key={one} value={one}>
                {EVERY_LABEL[one]}
              </option>
            ))}
          </select>
          . The first check only takes note of what is already there.
        </label>
      </>
    )}
    {trigger.kind === "schedule" && (
      <>
        <div className="dash-reach__add">
          <input
            className="dash-tool__when dash-workflow__short"
            aria-label="Schedule"
            value={trigger.cron}
            onChange={(event) => onChange({ ...trigger, cron: event.target.value })}
            placeholder="0 7 * * 1-5"
          />
          <input
            className="dash-tool__when dash-workflow__short"
            aria-label="Time zone"
            value={trigger.timezone}
            onChange={(event) => onChange({ ...trigger, timezone: event.target.value })}
            placeholder="America/Chicago"
          />
        </div>
        <span className="dash-hint">
          {describeCron(trigger.cron)}. Minute, hour, day of month, month, day of week, in the time zone beside it.
        </span>
      </>
    )}
    {trigger.kind === "every" && (
      <select aria-label="How often" value={trigger.every} onChange={(event) => onChange({ ...trigger, every: event.target.value as typeof trigger.every })}>
        {WORKFLOW_EVERY.map((one) => (
          <option key={one} value={one}>
            {EVERY_LABEL[one]}
          </option>
        ))}
      </select>
    )}
    {trigger.kind === "agent" && <InputsEditor inputs={trigger.inputs} onChange={(inputs) => onChange({ ...trigger, inputs })} />}
    {trigger.kind === "agent" && (
      <span className="dash-hint">Give an agent a “Run a workflow” tool for this on its Tools tab. That tool decides whether it starts on its own or asks the team.</span>
    )}
    {trigger.kind === "manual" && <span className="dash-hint">Runs when someone presses Run now.</span>}
  </div>
);

/** Fields to set on a record: path and value, each value a template. */
const ValuesEditor = ({ values, onChange }: { values: Record<string, string>; onChange: (next: Record<string, string>) => void }): JSX.Element => {
  const pairs = Object.entries(values);
  return (
    <div className="dash-tools">
      {pairs.map(([field, value], index) => (
        <div key={index} className="dash-reach__add">
          <input
            className="dash-tool__when dash-workflow__short"
            aria-label="Field"
            placeholder="field"
            value={field}
            onChange={(event) => onChange(Object.fromEntries(pairs.map(([f, v], at) => (at === index ? [event.target.value, v] : [f, v]))))}
          />
          <input
            className="dash-tool__when"
            aria-label="Value"
            placeholder="value, or {{ a field of the row }}"
            value={value}
            onChange={(event) => onChange(Object.fromEntries(pairs.map(([f, v], at) => (at === index ? [f, event.target.value] : [f, v]))))}
          />
          <button type="button" className="dash-reach__remove" aria-label="Remove this field" onClick={() => onChange(Object.fromEntries(pairs.filter((_, at) => at !== index)))}>
            ✕
          </button>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => onChange({ ...values, [pairs.some(([f]) => f === "") ? `field${pairs.length + 1}` : ""]: "" })}>
          Add a field
        </Button>
      </div>
    </div>
  );
};

const StepCard = ({
  step,
  agents,
  connections,
  onChange,
  onRemove,
  onMove,
}: {
  step: WorkflowStep;
  agents: readonly AgentSpec[];
  connections: readonly ConnectionSummary[];
  onChange: (next: WorkflowStep) => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}): JSX.Element => {
  const info = WORKFLOW_STEP_INFO[step.kind];
  /* Each field keeps its name beside it, so a filled-in template still says what it is. */
  const text = (label: string, value: string | undefined, set: (value: string) => void, placeholder: string, multiline = false) => (
    <label className="dash-workflow-field">
      <span className="dash-workflow-field__label">{label}</span>
      {multiline ? (
        <textarea className="dash-tool__deny" aria-label={label} rows={3} placeholder={placeholder} value={value ?? ""} onChange={(event) => set(event.target.value)} />
      ) : (
        <input className="dash-tool__when" aria-label={label} placeholder={placeholder} value={value ?? ""} onChange={(event) => set(event.target.value)} />
      )}
    </label>
  );

  return (
    <div className="dash-tool dash-workflow-step" data-testid={`workflow-step-${step.id}`} data-mode={info.leavesDash ? step.mode : "auto"}>
      <div className="dash-tool__head">
        <span className="dash-tool__name">{info.label}</span>
        <span className="dash-workflow-step__spacer" />
        {info.leavesDash ? (
          <span className="dash-tool__modes" role="radiogroup" aria-label="Auto or approve">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={step.mode === mode.id}
                className="dash-tool__mode"
                data-mode={mode.id}
                data-active={step.mode === mode.id}
                title={mode.hint}
                onClick={() => onChange({ ...step, mode: mode.id })}
              >
                {mode.label}
              </button>
            ))}
          </span>
        ) : (
          <span className="dash-hint">Always done</span>
        )}
        <button type="button" className="dash-reach__remove" aria-label="Move up" onClick={() => onMove(-1)}>
          ↑
        </button>
        <button type="button" className="dash-reach__remove" aria-label="Move down" onClick={() => onMove(1)}>
          ↓
        </button>
        <button type="button" className="dash-reach__remove" aria-label="Remove this step" onClick={onRemove}>
          ✕
        </button>
      </div>
      <div className="dash-tool__body">
        {info.leavesDash && <span className="dash-hint">{MODES.find((mode) => mode.id === step.mode)?.hint}</span>}
        {!info.perRun &&
          text("Only when", step.when, (when) => onChange({ ...step, when }), "Optional, e.g. cost >= 500")}

        {step.kind === "calendar" && (
          <>
            {text("Title", step.title, (title) => onChange({ ...step, title }), "e.g. Inspect unit {{ unit.name }}")}
            {text("When", step.at, (at) => onChange({ ...step, at }), "A date, or {{ due_date }}")}
            <label className="dash-reach__check">
              <input type="checkbox" checked={step.deadline} onChange={(event) => onChange({ ...step, deadline: event.target.checked })} />
              It is a deadline
            </label>
          </>
        )}

        {step.kind === "propose_change" && (
          <>
            <div className="dash-reach__add">
              <select aria-label="Connection" value={step.connection ?? ""} onChange={(event) => onChange(event.target.value ? { ...step, connection: event.target.value } : (({ connection: _c, ...rest }) => rest)(step))}>
                <option value="">The connection it reads</option>
                {connections.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.title}
                  </option>
                ))}
              </select>
              <select aria-label="Change" value={step.change} onChange={(event) => onChange({ ...step, change: event.target.value as typeof step.change })}>
                <option value="update">Update a record</option>
                <option value="action">Run a record's action</option>
                <option value="create">Create a record</option>
              </select>
            </div>
            {text("Record type", step.entity, (entity) => onChange({ ...step, entity }), "e.g. work_order")}
            {step.change === "action" && text("Action", step.action, (action) => onChange({ ...step, action }), "e.g. assign_vendor")}
            {step.change !== "create" && text("Which record", step.recordId, (recordId) => onChange({ ...step, recordId }), "{{ id }}")}
            <ValuesEditor values={step.values ?? {}} onChange={(values) => onChange({ ...step, values })} />
          </>
        )}

        {step.kind === "message" && (
          <>
            <div className="dash-reach__add">
              <select aria-label="Agent" value={step.agentId} onChange={(event) => onChange({ ...step, agentId: event.target.value })}>
                <option value="">Pick an agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <select aria-label="Channel" value={step.channel} onChange={(event) => onChange({ ...step, channel: event.target.value as typeof step.channel })}>
                {MESSAGE_CHANNELS.map((one) => (
                  <option key={one} value={one}>
                    {one === "text" ? "Text" : one === "call" ? "Call" : "Email"}
                  </option>
                ))}
              </select>
            </div>
            {text("To", step.to, (to) => onChange({ ...step, to }), "{{ tenant.phone }}")}
            {text("What it is for", step.purpose, (purpose) => onChange({ ...step, purpose }), "e.g. Let them know the work order was received", true)}
            <span className="dash-hint">The agent writes the words with its own reply prompt. Texts, calls and email arrive with Communications; until then the run notes what it would have sent.</span>
          </>
        )}

        {step.kind === "think" && (
          <>
            {text("What to think through", step.prompt, (prompt) => onChange({ ...step, prompt }), "e.g. Raise the priority of anything that looks urgent.", true)}
            <span className="dash-hint">Runs once a run, over every matched record, on the Workflow steps model. It can propose changes, add calendar entries and write notes. No agent's reply prompt is used.</span>
            {step.mode === "auto" && (
              <span className="dash-hint dash-tool__warn" role="alert">
                On auto, the changes it decides on are made without anyone reviewing them first.
              </span>
            )}
          </>
        )}

        {step.kind === "note" && text("Note", step.text, (value) => onChange({ ...step, text: value }), "e.g. {{ count }} orders were overdue")}
      </div>
    </div>
  );
};

const PreviewTable = ({ preview, steps }: { preview: WorkflowPreview; steps: readonly WorkflowStep[] }): JSX.Element => {
  if (preview.problem) return <p className="dash-callout dash-callout--bad">{preview.problem}</p>;
  if (preview.seeding) return <p className="dash-hint">Its first check will only take note of the {preview.read} records there now. After that, new ones start it.</p>;
  const label = (id: string) => {
    const step = steps.find((one) => one.id === id);
    return step ? WORKFLOW_STEP_INFO[step.kind].label : id;
  };
  return (
    <div className="dash-workflow-preview" data-testid="workflow-preview">
      <p className="dash-hint">
        {preview.matched} of {preview.read} record{preview.read === 1 ? "" : "s"} would be acted on{preview.complete ? "" : " (not every record was reached)"}.
      </p>
      {preview.rows.length > 0 && (
        <table className="dash-workflow-preview__table">
          <thead>
            <tr>
              <th>Record</th>
              {preview.rows[0]!.steps.map((one) => (
                <th key={one.step}>{label(one.step)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.key}>
                <td title={JSON.stringify(row.fields)}>{row.key}</td>
                {row.steps.map((one) => (
                  <td key={one.step} data-mode={one.runs ? one.mode : "skip"}>
                    {one.runs ? (one.mode === "auto" ? "Auto" : "Approve") : "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export const WorkflowEditor = ({
  workflow,
  agents,
  connections,
  onSaved,
  onCancel,
}: {
  /** Absent: a new workflow. */
  workflow: WorkflowSpec | null;
  agents: readonly AgentSpec[];
  connections: readonly ConnectionSummary[];
  onSaved: (saved: WorkflowSpec) => void;
  onCancel: () => void;
}): JSX.Element => {
  const [draft, setDraft] = useState<WorkflowInput>(() => fromSpec(workflow));
  const [entities, setEntities] = useState<Entities>({});
  const [kind, setKind] = useState<WorkflowStepKind>("propose_change");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [matchCount, setMatchCount] = useState<string | null>(null);

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

  useEffect(() => {
    const trigger = draft.trigger;
    if (trigger.kind === "record_created" || trigger.kind === "record_changed") loadEntities(trigger.connection);
    if (draft.source?.connection) loadEntities(draft.source.connection);
    // Once, for what the workflow arrived with.
  }, []);

  const set = (patch: Partial<WorkflowInput>) => setDraft((held) => ({ ...held, ...patch }));
  const steps = draft.steps ?? [];
  const isApi = draft.trigger.kind === "record_created" || draft.trigger.kind === "record_changed";
  const reads = isApi ? true : Boolean(draft.source?.connection);

  /* The live match count: a dry run a moment after the criteria or the source stop changing. */
  const sequence = useRef(0);
  const criteriaKey = JSON.stringify([draft.criteria ?? "", draft.source ?? null, draft.trigger]);
  useEffect(() => {
    if (!reads) {
      setMatchCount(null);
      return;
    }
    const mine = ++sequence.current;
    const timer = setTimeout(() => {
      void api
        .previewWorkflow(workflow?.id ?? "new", toInput({ ...draft, name: draft.name.trim() || "Draft", steps: [] }))
        .then((result) => {
          if (mine !== sequence.current) return;
          setMatchCount(
            result.problem
              ? result.problem
              : result.seeding
                ? `${result.read} records there now; the first check only takes note of them.`
                : `${result.matched} of ${result.read} records match.`,
          );
        })
        .catch((cause: unknown) => mine === sequence.current && setMatchCount(errorText(cause)));
    }, 700);
    return () => clearTimeout(timer);
  }, [criteriaKey, reads]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.saveWorkflow(workflow?.id ?? "new", toInput(draft)));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (): Promise<void> => {
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await api.previewWorkflow(workflow?.id ?? "new", toInput({ ...draft, name: draft.name.trim() || "Draft" })));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPreviewing(false);
    }
  };

  const setStep = (index: number, next: WorkflowStep) => set({ steps: steps.map((one, at) => (at === index ? next : one)) });
  const moveStep = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    [next[index], next[to]] = [next[to]!, next[index]!];
    set({ steps: next });
  };
  const source: WorkflowSource | undefined = draft.source;

  return (
    <form
      className="dash-agent-editor dash-workflow-editor"
      data-testid="workflow-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="dash-field">
        <label htmlFor="workflow-name">Name</label>
        <input id="workflow-name" value={draft.name} maxLength={80} onChange={(event) => set({ name: event.target.value })} placeholder="New work orders" />
      </div>
      <div className="dash-field">
        <label htmlFor="workflow-description">What it does</label>
        <input
          id="workflow-description"
          value={draft.description ?? ""}
          maxLength={1000}
          onChange={(event) => set({ description: event.target.value })}
          placeholder="Shown to agents that can start it, and in the list."
        />
      </div>

      <h4 className="dash-workflow-editor__heading">When it starts</h4>
      <TriggerEditor trigger={draft.trigger} onChange={(trigger) => set({ trigger })} connections={connections} entities={entities} loadEntities={loadEntities} />

      {!isApi && (
        <>
          <h4 className="dash-workflow-editor__heading">What it reads</h4>
          <RecordPicker
            connection={source?.connection ?? ""}
            record={source?.record ?? ""}
            connections={connections}
            entities={entities}
            loadEntities={loadEntities}
            allowNone="Nothing: run its steps once"
            onChange={(where) => {
              if (!where.connection) {
                const { source: _source, ...rest } = draft;
                setDraft(rest);
              } else set({ source: { connection: where.connection, ...(where.record ? { record: where.record } : {}) } as WorkflowSource });
            }}
          />
        </>
      )}

      {reads && (
        <>
          <h4 className="dash-workflow-editor__heading">Which records matter</h4>
          <input
            className="dash-tool__when"
            aria-label="Criteria"
            placeholder='All of them, or e.g. status == "open" && vendor == null'
            value={draft.criteria ?? ""}
            onChange={(event) => set({ criteria: event.target.value })}
            data-testid="workflow-criteria"
          />
          {matchCount && (
            <span className="dash-hint" data-testid="workflow-match-count">
              {matchCount}
            </span>
          )}
          {!isApi && (
            <label className="dash-hint">
              <select aria-label="How often a record is acted on" value={draft.once ?? "per-row"} onChange={(event) => set({ once: event.target.value as "per-row" | "per-run" })}>
                <option value="per-row">Act on each record once</option>
                <option value="per-run">Act on every match, every run</option>
              </select>
            </label>
          )}
        </>
      )}

      <h4 className="dash-workflow-editor__heading">Steps</h4>
      <div className="dash-tools" data-testid="workflow-steps">
        {steps.length === 0 && <p className="dash-hint">No steps yet. Each step that reaches outside Dash is set to Auto or Approve.</p>}
        {steps.map((step, index) => (
          <StepCard
            key={step.id}
            step={step}
            agents={agents}
            connections={connections}
            onChange={(next) => setStep(index, next)}
            onRemove={() => set({ steps: steps.filter((_, at) => at !== index) })}
            onMove={(by) => moveStep(index, by)}
          />
        ))}
        <div className="dash-reach__add">
          <select aria-label="Step" value={kind} onChange={(event) => setKind(event.target.value as WorkflowStepKind)}>
            {WORKFLOW_STEP_KINDS.map((one) => (
              <option key={one} value={one}>
                {WORKFLOW_STEP_INFO[one].label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={steps.length >= 30}
            onClick={() => set({ steps: [...steps, blankStep(kind, steps.map((one) => one.id), agents[0]?.id ?? "")] })}
            testId="workflow-step-add"
          >
            Add step
          </Button>
        </div>
      </div>

      {preview && <PreviewTable preview={preview} steps={steps} />}

      {error && (
        <p className="dash-callout dash-callout--bad" role="alert" data-testid="workflow-error">
          {error}
        </p>
      )}
      <div className="dash-agent-editor__actions">
        <Button type="submit" tone="primary" busy={busy} disabled={draft.name.trim() === ""} testId="workflow-save">
          {workflow ? "Save changes" : "Create workflow"}
        </Button>
        <Button onClick={() => void runPreview()} busy={previewing} testId="workflow-preview-run">
          Preview
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
      <span className="dash-hint">Saving makes you the person it runs as: its automatic steps use your permission.</span>
    </form>
  );
};
