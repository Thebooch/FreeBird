import type { WorkflowInput, WorkflowSpec, WorkflowStep, WorkflowStepKind, WorkflowTrigger, WorkflowTriggerKind } from "@freebirdai/dash-spec";

/**
 * The editor's working copy of a workflow, and the small pieces it is built
 * from: a fresh step of each kind, a fresh trigger of each kind, and what is
 * sent to the server when it is saved.
 */

const nextFree = (base: string, taken: readonly string[]): string => {
  const held = new Set(taken);
  if (!held.has(base)) return base;
  for (let n = 2; ; n++) if (!held.has(`${base}-${n}`)) return `${base}-${n}`;
};

export const newStepId = (kind: WorkflowStepKind, taken: readonly string[]): string => nextFree(kind.replace(/_/g, "-"), taken);

/** A new step of a kind, set to approve wherever that matters. */
export const blankStep = (kind: WorkflowStepKind, taken: readonly string[], agentId = ""): WorkflowStep => {
  const id = newStepId(kind, taken);
  switch (kind) {
    case "calendar":
      return { id, kind, mode: "auto", title: "", at: "", allDay: false, deadline: false };
    case "propose_change":
      return { id, kind, mode: "approve", entity: "", change: "update", recordId: "{{ id }}", values: {} };
    case "message":
      return { id, kind, mode: "approve", agentId, channel: "text", to: "", purpose: "" };
    case "think":
      return { id, kind, mode: "approve", prompt: "" };
    case "note":
      return { id, kind, mode: "auto", text: "" };
  }
};

export const TRIGGER_CHOICES: ReadonlyArray<{ readonly kind: WorkflowTriggerKind; readonly label: string }> = [
  { kind: "record_created", label: "When a record appears" },
  { kind: "record_changed", label: "When a record changes" },
  { kind: "schedule", label: "On a schedule" },
  { kind: "every", label: "Every so often" },
  { kind: "agent", label: "When an agent is asked" },
  { kind: "manual", label: "By hand" },
];

/** A fresh trigger of a kind, keeping the connection and record type of the one it replaces where it had them. */
export const blankTrigger = (kind: WorkflowTriggerKind, from?: WorkflowTrigger): WorkflowTrigger => {
  const where = from && (from.kind === "record_created" || from.kind === "record_changed") ? { connection: from.connection, record: from.record } : { connection: "", record: "" };
  switch (kind) {
    case "schedule":
      return { kind, cron: "0 7 * * 1-5", timezone: browserZone() };
    case "every":
      return { kind, every: "1h" };
    case "record_created":
      return { kind, ...where, every: "15m" };
    case "record_changed":
      return { kind, ...where, every: "15m" };
    case "agent":
      return { kind, inputs: [] };
    case "manual":
      return { kind };
  }
};

export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** What is sent to save: the person's fields only. Empty optional text is left out. */
export const toInput = (draft: WorkflowInput): WorkflowInput => {
  const criteria = draft.criteria?.trim();
  const rowKey = draft.rowKey?.trim();
  const isApi = draft.trigger.kind === "record_created" || draft.trigger.kind === "record_changed";
  return {
    name: draft.name.trim(),
    ...(draft.enabled !== undefined ? { enabled: draft.enabled } : {}),
    description: draft.description ?? "",
    trigger: draft.trigger,
    ...(draft.source && !isApi ? { source: draft.source } : {}),
    ...(criteria ? { criteria } : {}),
    ...(rowKey ? { rowKey } : {}),
    once: draft.once ?? "per-row",
    steps: (draft.steps ?? []).map((step) => (step.when?.trim() ? { ...step, when: step.when.trim() } : withoutWhen(step))),
  };
};

const withoutWhen = (step: WorkflowStep): WorkflowStep => {
  const { when: _when, ...rest } = step;
  return rest as WorkflowStep;
};

export const fromSpec = (workflow: WorkflowSpec | null): WorkflowInput =>
  workflow
    ? {
        name: workflow.name,
        enabled: workflow.enabled,
        description: workflow.description,
        trigger: workflow.trigger,
        ...(workflow.source ? { source: workflow.source } : {}),
        ...(workflow.criteria ? { criteria: workflow.criteria } : {}),
        ...(workflow.rowKey ? { rowKey: workflow.rowKey } : {}),
        once: workflow.once,
        steps: workflow.steps,
      }
    : { name: "", enabled: false, description: "", trigger: { kind: "manual" }, once: "per-row", steps: [] };

/** "Off", "On", or "Paused: why". */
export const workflowState = (workflow: Pick<WorkflowSpec, "enabled" | "parked">): { readonly tone: "on" | "off" | "paused"; readonly label: string } =>
  workflow.parked ? { tone: "paused", label: "Paused" } : workflow.enabled ? { tone: "on", label: "On" } : { tone: "off", label: "Off" };
