import { Button } from "@freebirdai/dash-components";
import {
  ACTION_BASES,
  BASE_INFO,
  TRIGGER_NODE,
  describeTrigger,
  nodeOutcomes,
  variantsOf,
  type AgentSpec,
  type WorkflowInput,
  type WorkflowNode,
  type WorkflowSource,
  type WorkflowSpec,
  type WorkflowTemplate,
} from "@freebirdai/dash-spec";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ConnectionSummary, type WorkflowCheck, type WorkflowPreview } from "../../api";
import { Canvas, outcomeLabel } from "./Canvas.jsx";
import { NODE_H, autoLayout, blankNode, connect, fromSpec, removeNode, toInput } from "./draft.js";
import { recordTypeChoices, type Entities } from "../entities.js";
import { RecordPicker, TriggerEditor } from "./fields.jsx";
import { StepPanel } from "./StepPanel.jsx";

/**
 * The workflow builder: a canvas of steps and arrows, with a panel beside it.
 *
 * - The panel edits whatever is selected: the trigger (and the workflow's own
 *   settings), a step (its settings from the catalog, and the settings every
 *   step shares), or an arrow.
 * - **Add a step** from the catalog, grouped by base action; it lands below
 *   the selected step and, if that step has a free way out, is joined to it.
 * - **Insert a template**: its blanks are asked for, its steps copied in.
 * - Above the canvas, the workflow in one sentence and what it still needs,
 *   checked by the same rules the chat uses, as you edit.
 * - **Preview** runs it dry, as you: which records match and each one's path.
 */

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const WorkflowEditor = ({
  workflow,
  agents,
  workflows,
  connections,
  templates,
  onSaved,
  onCancel,
  onTemplatesChanged,
}: {
  /** Absent: a new workflow. */
  workflow: WorkflowSpec | null;
  agents: readonly AgentSpec[];
  workflows: readonly WorkflowSpec[];
  connections: readonly ConnectionSummary[];
  templates: readonly WorkflowTemplate[];
  onSaved: (saved: WorkflowSpec) => void;
  onCancel: () => void;
  onTemplatesChanged: () => void;
}): JSX.Element => {
  const [draft, setDraft] = useState<WorkflowInput>(() => fromSpec(workflow));
  const [selected, setSelected] = useState<string | null>(TRIGGER_NODE);
  const [entities, setEntities] = useState<Entities>({});
  const [adding, setAdding] = useState("outreach.text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [check, setCheck] = useState<WorkflowCheck | null>(null);
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [inserting, setInserting] = useState<{ template: WorkflowTemplate; values: Record<string, string> } | null>(null);
  const [templateName, setTemplateName] = useState("");

  const nodes = draft.nodes ?? [];
  const edges = draft.edges ?? [];
  const set = (patch: Partial<WorkflowInput>) => setDraft((held) => ({ ...held, ...patch }));
  const isApi = draft.trigger.kind === "record_created" || draft.trigger.kind === "record_changed";
  const readsConnection = isApi ? (draft.trigger as { connection: string }).connection : draft.source?.connection;

  const loadEntities = useCallback((connection: string) => {
    if (!connection) return;
    setEntities((held) => {
      if (held[connection]) return held;
      void api
        .connectionEntities(connection)
        .then((list) => setEntities((now) => ({ ...now, [connection]: recordTypeChoices(list) })))
        .catch(() => setEntities((now) => ({ ...now, [connection]: [] })));
      return { ...held, [connection]: [] };
    });
  }, []);
  useEffect(() => {
    if (readsConnection) loadEntities(readsConnection);
  }, [readsConnection, loadEntities]);

  /* The sentence and the questions, checked a moment after an edit. */
  const sequence = useRef(0);
  const draftKey = JSON.stringify(toInput({ ...draft, name: draft.name.trim() || "Draft" }));
  useEffect(() => {
    const mine = ++sequence.current;
    const timer = setTimeout(() => {
      void api
        .checkWorkflow(workflow?.id ?? "new", toInput({ ...draft, name: draft.name.trim() || "Draft" }))
        .then((result) => mine === sequence.current && setCheck(result))
        .catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [draftKey]);

  const problemsByStep = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const one of check?.problems ?? []) if (one.step) out[one.step] = [...(out[one.step] ?? []), one.message];
    for (const one of check?.questions ?? []) if (one.step && one.kind === "missing") out[one.step] = [...(out[one.step] ?? []), one.question];
    return out;
  }, [check]);

  /* Delete removes the selected step or arrow, unless a field has the keyboard. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "Delete" || !selected || selected === TRIGGER_NODE) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (nodes.some((one) => one.id === selected)) setDraft((held) => ({ ...held, ...removeNode(held, selected) }));
      else set({ edges: edges.filter((edge) => edge.id !== selected) });
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Below the selected step (or the lowest one), joined to it by its first free way out. */
  const placeAndJoin = (added: WorkflowNode[], newEdges: WorkflowInput["edges"] = [], entry?: string) => {
    const anchor = nodes.find((one) => one.id === selected) ?? nodes.reduce<WorkflowNode | undefined>((low, one) => (!low || one.position.y > low.position.y ? one : low), undefined);
    const from = anchor?.id ?? (selected === TRIGGER_NODE || nodes.length === 0 ? TRIGGER_NODE : undefined);
    let nextEdges = [...edges, ...(newEdges ?? [])];
    const first = entry ?? added[0]?.id;
    if (from && first) {
      const free = from === TRIGGER_NODE ? (edges.some((edge) => edge.from === TRIGGER_NODE) ? undefined : "next") : nodeOutcomes(anchor!).find((outcome) => !edges.some((edge) => edge.from === from && edge.outcome === outcome));
      if (free) nextEdges = connect(nextEdges, from, free, first);
    }
    set({ nodes: [...nodes, ...added], edges: nextEdges });
    setSelected(first ?? null);
  };

  const addStep = () => {
    const anchor = nodes.find((one) => one.id === selected);
    const lowest = Math.max(0, ...nodes.map((one) => one.position.y));
    const position = anchor ? { x: anchor.position.x, y: anchor.position.y + NODE_H + 64 } : { x: 360, y: nodes.length === 0 ? NODE_H + 112 : lowest + NODE_H + 64 };
    placeAndJoin([blankNode(adding, nodes.map((one) => one.id), position, agents[0]?.id)]);
  };

  const insertTemplate = async (template: WorkflowTemplate, values: Record<string, string>) => {
    setError(null);
    try {
      const anchor = nodes.find((one) => one.id === selected);
      const at = anchor ? { x: anchor.position.x, y: anchor.position.y + NODE_H + 64 } : { x: 360, y: Math.max(NODE_H + 112, ...nodes.map((one) => one.position.y + NODE_H + 64)) };
      const result = await api.insertTemplate(template.id, values, at);
      placeAndJoin(result.nodes ?? [], result.edges, result.entry);
      setInserting(null);
      setNotice(`Inserted "${template.name}" (version ${template.version}).`);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

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

  const saveTemplate = async (kind: "step" | "workflow", steps?: string[]) => {
    if (!workflow) {
      setError("Save the workflow first: a template is made from what is saved.");
      return;
    }
    if (!templateName.trim()) {
      setError("Give the template a name.");
      return;
    }
    try {
      const saved = await api.saveTemplate({ workflow: workflow.id, kind, name: templateName.trim(), ...(steps ? { steps } : {}) });
      setNotice(`Saved template "${saved.name}" (version ${saved.version}${saved.blanks.length ? `, asks for ${saved.blanks.map((one) => one.name).join(", ")}` : ""}).`);
      setTemplateName("");
      onTemplatesChanged();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const selectedNode = nodes.find((one) => one.id === selected);
  const selectedEdge = edges.find((edge) => edge.id === selected);
  const names = { connection: (id: string) => connections.find((one) => one.id === id)?.title ?? id };

  const workflowPanel = (
    <div className="dash-step-panel" data-testid="workflow-settings">
      <label className="dash-workflow-field">
        <span className="dash-workflow-field__label">Name</span>
        <input className="dash-tool__when" aria-label="Workflow name" value={draft.name} maxLength={80} onChange={(event) => set({ name: event.target.value })} placeholder="New work orders" />
      </label>
      <label className="dash-workflow-field">
        <span className="dash-workflow-field__label">What it does</span>
        <input className="dash-tool__when" aria-label="What it does" value={draft.description ?? ""} onChange={(event) => set({ description: event.target.value })} placeholder="Shown to agents that can start it" />
      </label>
      <h5 className="dash-workflow-editor__heading">When it starts</h5>
      <TriggerEditor trigger={draft.trigger} onChange={(trigger) => set({ trigger })} connections={connections} entities={entities} loadEntities={loadEntities} />
      {isApi && (
        <div className="dash-reach__add">
          <input
            className="dash-tool__when dash-workflow__short"
            type="number"
            min={1}
            aria-label="Cases per record"
            placeholder="Cases per record"
            value={draft.triggerLimits?.maxPerRecord ?? ""}
            onChange={(event) => set({ triggerLimits: { ...draft.triggerLimits, ...(event.target.value ? { maxPerRecord: Number(event.target.value) } : { maxPerRecord: undefined }) } })}
          />
          <input
            className="dash-tool__when dash-workflow__short"
            aria-label="Cooldown"
            placeholder="Cooldown, e.g. 1d"
            value={draft.triggerLimits?.cooldown ?? ""}
            onChange={(event) => set({ triggerLimits: { ...draft.triggerLimits, cooldown: event.target.value || undefined } })}
          />
        </div>
      )}
      {!isApi && (
        <>
          <h5 className="dash-workflow-editor__heading">What it reads</h5>
          <RecordPicker
            connection={draft.source?.connection ?? ""}
            record={draft.source?.record ?? ""}
            connections={connections}
            entities={entities}
            loadEntities={loadEntities}
            allowNone="Nothing: one case each time it starts"
            onChange={(where) => {
              if (!where.connection) {
                const { source: _source, ...rest } = draft;
                setDraft(rest);
              } else set({ source: { connection: where.connection, ...(where.record ? { record: where.record } : {}) } as WorkflowSource });
            }}
          />
        </>
      )}
      {(isApi || draft.source) && (
        <label className="dash-workflow-field">
          <span className="dash-workflow-field__label">Only records where</span>
          <input className="dash-tool__when" aria-label="Criteria" placeholder='All, or e.g. status == "open"' value={draft.criteria ?? ""} onChange={(event) => set({ criteria: event.target.value })} />
        </label>
      )}
      <label className="dash-workflow-field">
        <span className="dash-workflow-field__label">Trial cases</span>
        <input className="dash-tool__when dash-workflow__short" type="number" min={0} max={100} aria-label="Trial cases" value={draft.trial ?? 0} onChange={(event) => set({ trial: Math.max(0, Number(event.target.value) || 0) })} />
      </label>
      <span className="dash-hint">While above zero, every step that leaves Dash asks for approval. It counts down as cases finish.</span>
      <label className="dash-workflow-field">
        <span className="dash-workflow-field__label">Guardrails</span>
        <textarea className="dash-tool__deny" rows={3} aria-label="Guardrails" placeholder="Never promise a repair date. Stop and ask if they mention a lawyer." value={draft.guardrails ?? ""} onChange={(event) => set({ guardrails: event.target.value })} />
      </label>
      <span className="dash-hint">Read by Think steps, and by agents writing Outreach for this workflow.</span>
      <div className="dash-reach__add">
        <label className="dash-hint">
          Visits per step{" "}
          <input className="dash-tool__when dash-workflow__tiny" type="number" min={1} value={draft.limits?.visitsPerStep ?? 10} onChange={(event) => set({ limits: { stepsPerCase: draft.limits?.stepsPerCase ?? 200, visitsPerStep: Number(event.target.value) || 10 } })} />
        </label>
        <label className="dash-hint">
          Steps per case{" "}
          <input className="dash-tool__when dash-workflow__tiny" type="number" min={1} value={draft.limits?.stepsPerCase ?? 200} onChange={(event) => set({ limits: { visitsPerStep: draft.limits?.visitsPerStep ?? 10, stepsPerCase: Number(event.target.value) || 200 } })} />
        </label>
      </div>
      <h5 className="dash-workflow-editor__heading">Save as a template</h5>
      <div className="dash-reach__add">
        <input className="dash-tool__when" aria-label="Template name" placeholder="Template name" value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
        <Button size="sm" onClick={() => void saveTemplate("workflow")}>
          Save whole workflow
        </Button>
      </div>
    </div>
  );

  return (
    <div className="dash-builder" data-testid="workflow-editor">
      <div className="dash-builder__bar">
        <strong className="dash-builder__title">{draft.name || "New workflow"}</strong>
        <span className="dash-row">
          <select aria-label="Step to add" value={adding} onChange={(event) => setAdding(event.target.value)} data-testid="step-picker">
            {ACTION_BASES.map((base) => (
              <optgroup key={base} label={BASE_INFO[base].label}>
                {variantsOf(base).map((variant) => (
                  <option key={variant.id} value={variant.id} disabled={!variant.available}>
                    {variant.label}
                    {variant.available ? "" : " (coming)"}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Button size="sm" onClick={addStep} testId="step-add">
            Add step
          </Button>
          {templates.length > 0 && (
            <select
              aria-label="Insert a template"
              value=""
              onChange={(event) => {
                const template = templates.find((one) => one.id === event.target.value);
                if (!template) return;
                if (template.blanks.length === 0) void insertTemplate(template, {});
                else setInserting({ template, values: Object.fromEntries(template.blanks.map((one) => [one.name, one.default ?? ""])) });
              }}
            >
              <option value="">Insert a template…</option>
              {templates
                .filter((one) => one.kind !== "workflow")
                .map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name} (v{one.version})
                  </option>
                ))}
            </select>
          )}
          <Button size="sm" tone="ghost" onClick={() => set({ nodes: autoLayout(nodes, edges) })}>
            Tidy
          </Button>
          <Button size="sm" onClick={() => void api.previewWorkflow(workflow?.id ?? "new", toInput({ ...draft, name: draft.name.trim() || "Draft" })).then(setPreview, (cause: unknown) => setError(errorText(cause)))} testId="workflow-preview-run">
            Preview
          </Button>
          <Button size="sm" tone="primary" busy={busy} disabled={draft.name.trim() === ""} onClick={() => void save()} testId="workflow-save">
            {workflow ? "Save" : "Create"}
          </Button>
          <Button size="sm" tone="ghost" onClick={onCancel}>
            Close
          </Button>
        </span>
      </div>

      {check && (
        <div className="dash-builder__check" data-testid="workflow-check">
          <p className="dash-builder__sentence">{check.sentence}</p>
          {check.questions.length > 0 && (
            <ul className="dash-builder__questions">
              {check.questions.map((one, index) => (
                <li key={index} data-kind={one.kind}>
                  {one.step ? (
                    <button type="button" className="dash-overview__link" onClick={() => setSelected(one.step!)}>
                      {one.question}
                    </button>
                  ) : (
                    one.question
                  )}
                  {one.default ? <span className="dash-hint"> ({one.default})</span> : null}
                </li>
              ))}
            </ul>
          )}
          {check.problems.filter((one) => !one.step).map((one) => (
            <p key={one.message} className="dash-hint dash-tool__warn">
              {one.message}
            </p>
          ))}
        </div>
      )}
      {inserting && (
        <div className="dash-callout" data-testid="template-blanks">
          <strong>{inserting.template.name}</strong> asks for:
          {inserting.template.blanks.map((blank) => (
            <label key={blank.name} className="dash-workflow-field">
              <span className="dash-workflow-field__label">{blank.label || blank.name}</span>
              <input className="dash-tool__when" value={inserting.values[blank.name] ?? ""} onChange={(event) => setInserting({ ...inserting, values: { ...inserting.values, [blank.name]: event.target.value } })} />
            </label>
          ))}
          <div className="dash-row">
            <Button size="sm" tone="primary" onClick={() => void insertTemplate(inserting.template, inserting.values)}>
              Insert
            </Button>
            <Button size="sm" onClick={() => setInserting(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="dash-callout dash-callout--bad" role="alert" data-testid="workflow-error">
          {error}
        </p>
      )}
      {notice && <p className="dash-callout">{notice}</p>}

      <div className="dash-builder__body">
        <Canvas
          nodes={nodes}
          edges={edges}
          triggerLabel={describeTrigger(draft.trigger, names)}
          trial={(draft.trial ?? 0) > 0}
          selected={selected}
          problems={problemsByStep}
          onSelect={setSelected}
          onMove={(id, position) => set({ nodes: nodes.map((one) => (one.id === id ? { ...one, position } : one)) })}
          onConnect={(from, outcome, to) => set({ edges: connect(edges, from, outcome, to) })}
        />
        <aside className="dash-builder__panel">
          {selectedNode ? (
            <>
              <StepPanel
                key={selectedNode.id}
                node={selectedNode}
                nodes={nodes}
                trial={(draft.trial ?? 0) > 0}
                problems={problemsByStep[selectedNode.id] ?? []}
                connections={connections}
                entities={entities}
                loadEntities={loadEntities}
                agents={agents}
                workflows={workflows.filter((one) => one.id !== workflow?.id && !one.source && one.trigger.kind !== "record_created" && one.trigger.kind !== "record_changed")}
                defaultConnection={readsConnection}
                onChange={(next) => set({ nodes: nodes.map((one) => (one.id === next.id ? next : one)) })}
                onRemove={() => {
                  setDraft((held) => ({ ...held, ...removeNode(held, selectedNode.id) }));
                  setSelected(null);
                }}
              />
              <div className="dash-reach__add">
                <input className="dash-tool__when" aria-label="Template name" placeholder="Template name" value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
                <Button size="sm" onClick={() => void saveTemplate("step", [selectedNode.id])} testId="step-save-template">
                  Save step as template
                </Button>
              </div>
            </>
          ) : selectedEdge ? (
            <div className="dash-step-panel" data-testid="edge-panel">
              <p>
                From <strong>{selectedEdge.from === TRIGGER_NODE ? "the trigger" : (nodes.find((one) => one.id === selectedEdge.from)?.name ?? selectedEdge.from)}</strong> when{" "}
                <strong>{outcomeLabel(selectedEdge.outcome)}</strong>, to <strong>{nodes.find((one) => one.id === selectedEdge.to)?.name ?? selectedEdge.to}</strong>.
              </p>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => {
                  set({ edges: edges.filter((edge) => edge.id !== selectedEdge.id) });
                  setSelected(null);
                }}
              >
                Remove arrow
              </Button>
            </div>
          ) : (
            workflowPanel
          )}
        </aside>
      </div>

      {preview && (
        <div className="dash-workflow-preview" data-testid="workflow-preview">
          {preview.problem ? (
            <p className="dash-callout dash-callout--bad">{preview.problem}</p>
          ) : preview.seeding ? (
            <p className="dash-hint">Its first look will only take note of the {preview.read} records there now. After that, new ones start it.</p>
          ) : (
            <>
              <p className="dash-hint">
                {preview.matched} of {preview.read} records would open a case{preview.complete ? "" : " (not every record was reached)"}.
              </p>
              <ul className="dash-workflow-preview__paths">
                {preview.rows.map((row) => (
                  <li key={row.key}>
                    <strong>{row.key || "The case"}</strong>:{" "}
                    {row.path.map((step, index) => (
                      <span key={`${step.node}-${index}`} data-mode={step.skipped ? "skip" : step.mode}>
                        {index > 0 ? " → " : ""}
                        {step.name}
                        {step.skipped ? " (skipped)" : step.mode === "approve" ? " (approve)" : ""}
                        {step.stops ? `, then ${step.stops}` : ""}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
};
