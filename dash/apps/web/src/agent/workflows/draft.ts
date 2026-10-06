import {
  TRIGGER_NODE,
  actionVariant,
  withDefaults,
  type WorkflowEdge,
  type WorkflowInput,
  type WorkflowNode,
  type WorkflowSpec,
  type WorkflowTrigger,
  type WorkflowTriggerKind,
} from "@freebirdai/dash-spec";

/**
 * The builder's working copy of a workflow, and the small pieces it is made
 * from: a fresh step of any catalog variant, a fresh trigger, an arrow, a
 * tidy layout, and what is sent to the server when it is saved.
 */

const nextFree = (base: string, taken: readonly string[]): string => {
  const held = new Set(taken);
  if (!held.has(base)) return base;
  for (let n = 2; ; n++) if (!held.has(`${base}-${n}`)) return `${base}-${n}`;
};

/** A step id from its variant: `outreach.text` → `text`, `wait.for` → `wait-for`. */
export const newNodeId = (action: string, taken: readonly string[]): string => {
  const [base, variant] = action.split(".");
  const word = variant && !["record", "team", "records", "start", "if"].includes(variant) ? variant : (base ?? "step");
  return nextFree(word.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) || "step", [...taken, TRIGGER_NODE]);
};

/** A new step of a variant, with its defaults, in the mode it starts in. */
export const blankNode = (action: string, taken: readonly string[], position: { x: number; y: number }, agentId?: string): WorkflowNode => {
  const variant = actionVariant(action);
  const settings = variant ? withDefaults(variant, {}) : {};
  if (variant?.fields.some((field) => field.key === "agentId") && agentId) settings["agentId"] = agentId;
  return {
    id: newNodeId(action, taken),
    action,
    settings,
    mode: variant?.defaultMode ?? "approve",
    onFailure: "stop",
    reversible: true,
    position,
  };
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

/** Draw (or redraw) the arrow out of a step for one outcome: one arrow per outcome. */
export const connect = (edges: readonly WorkflowEdge[], from: string, outcome: string, to: string): WorkflowEdge[] => [
  ...edges.filter((edge) => !(edge.from === from && edge.outcome === outcome)),
  { id: `e-${from}-${outcome}-${to}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64), from, outcome, to },
];

/** A step taken out: its arrows go with it. */
export const removeNode = (draft: Pick<WorkflowInput, "nodes" | "edges">, id: string): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } => ({
  nodes: (draft.nodes ?? []).filter((one) => one.id !== id),
  edges: (draft.edges ?? []).filter((edge) => edge.from !== id && edge.to !== id),
});

export const NODE_W = 248;
export const NODE_H = 96;
const GAP_X = 48;
const GAP_Y = 64;

/**
 * A tidy layout: each step one row below the deepest step that leads to it
 * (an arrow back up a loop does not count), steps in a row side by side.
 */
export const autoLayout = (nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]): WorkflowNode[] => {
  const depth = new Map<string, number>();
  const order: string[] = [];
  const start = edges.filter((edge) => edge.from === TRIGGER_NODE).map((edge) => edge.to);
  const queue = (start.length > 0 ? start : nodes.slice(0, 1).map((one) => one.id)).map((id) => ({ id, level: 0 }));
  while (queue.length > 0) {
    const { id, level } = queue.shift()!;
    if (depth.has(id)) continue;
    depth.set(id, level);
    order.push(id);
    for (const edge of edges) if (edge.from === id && !depth.has(edge.to)) queue.push({ id: edge.to, level: level + 1 });
  }
  let last = Math.max(-1, ...depth.values());
  for (const one of nodes) if (!depth.has(one.id)) depth.set(one.id, ++last);
  const rows = new Map<number, string[]>();
  for (const one of nodes) rows.set(depth.get(one.id)!, [...(rows.get(depth.get(one.id)!) ?? []), one.id]);
  const widest = Math.max(1, ...[...rows.values()].map((row) => row.length));
  const span = widest * NODE_W + (widest - 1) * GAP_X;
  return nodes.map((one) => {
    const level = depth.get(one.id)!;
    const row = rows.get(level)!;
    const rowSpan = row.length * NODE_W + (row.length - 1) * GAP_X;
    const x = (span - rowSpan) / 2 + row.indexOf(one.id) * (NODE_W + GAP_X);
    return { ...one, position: { x: Math.round(x) + 24, y: 24 + (level + 1) * (NODE_H + GAP_Y) } };
  });
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
    ...(draft.triggerLimits ? { triggerLimits: draft.triggerLimits } : {}),
    ...(draft.source && !isApi ? { source: draft.source } : {}),
    ...(criteria ? { criteria } : {}),
    ...(rowKey ? { rowKey } : {}),
    once: draft.once ?? "per-row",
    ...(draft.trial !== undefined ? { trial: draft.trial } : {}),
    guardrails: draft.guardrails ?? "",
    nodes: (draft.nodes ?? []).map((one) => {
      const { when, ...rest } = one;
      return when?.trim() ? { ...rest, when: when.trim() } : rest;
    }),
    edges: draft.edges ?? [],
    ...(draft.limits ? { limits: draft.limits } : {}),
  };
};

export const fromSpec = (workflow: WorkflowSpec | null): WorkflowInput =>
  workflow
    ? {
        name: workflow.name,
        enabled: workflow.enabled,
        description: workflow.description,
        trigger: workflow.trigger,
        triggerLimits: workflow.triggerLimits,
        ...(workflow.source ? { source: workflow.source } : {}),
        ...(workflow.criteria ? { criteria: workflow.criteria } : {}),
        ...(workflow.rowKey ? { rowKey: workflow.rowKey } : {}),
        once: workflow.once,
        trial: workflow.trial,
        guardrails: workflow.guardrails,
        nodes: workflow.nodes,
        edges: workflow.edges,
        limits: workflow.limits,
      }
    : { name: "", enabled: false, description: "", trigger: { kind: "manual" }, once: "per-row", nodes: [], edges: [], guardrails: "" };

/** "Off", "On", "Trial", or "Paused: why". */
export const workflowState = (workflow: Pick<WorkflowSpec, "enabled" | "parked"> & { trial?: number }): { readonly tone: "on" | "off" | "paused" | "trial"; readonly label: string } =>
  workflow.parked
    ? { tone: "paused", label: "Paused" }
    : workflow.enabled
      ? workflow.trial && workflow.trial > 0
        ? { tone: "trial", label: `Trial (${workflow.trial})` }
        : { tone: "on", label: "On" }
      : { tone: "off", label: "Off" };
