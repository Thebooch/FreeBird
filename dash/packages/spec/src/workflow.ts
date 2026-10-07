import { idSchema } from "@freebirdai/connect-spec";
import { z } from "zod";
import { principalSchema } from "./access.js";
import { actionVariant, describeDuration, outcomesFor } from "./actions.js";

/**
 * A workflow: a trigger, and a graph of steps.
 *
 * Agents and workflows are two different things, and either can use the other
 * (`agent.ts`). A workflow starts from a trigger (time, a record appearing or
 * changing in an API, an agent being asked, or a person), and each record it
 * matches opens a **case** that walks the graph: a step runs, its outcome
 * names an arrow, and the arrow says which step is next. Arrows can go
 * anywhere, back to an earlier step included; limits per case stop a loop
 * going round forever.
 *
 * Each step is an action from the catalog (`actions.ts`): a base action, a
 * variant and its settings, plus settings every step shares: a condition,
 * Auto or Approve, who it acts as, what to do on failure. **Every step leaves
 * a task** (below), whatever happens.
 *
 * **No agent's reply prompt is used by a workflow's own reasoning.** Think
 * steps run on their own model task with the workflow's prompt; only Outreach
 * (an agent writing to a person) uses the agent's voice.
 */

/* ── modes ─────────────────────────────────────────────────────────────── */

/**
 * - `auto`: done during the run, as the person who turned the workflow on.
 * - `approve`: proposed, and waits in "Waiting for you" until a person applies it.
 *
 * The same words an agent's tools use; a workflow step has no `deny`, because
 * a step that should not happen is simply not added.
 */
export const WORKFLOW_STEP_MODES = ["auto", "approve"] as const;
export const workflowStepModeSchema = z.enum(WORKFLOW_STEP_MODES);
export type WorkflowStepMode = z.infer<typeof workflowStepModeSchema>;

/* ── triggers ──────────────────────────────────────────────────────────── */

/** How often an interval or a poll comes round. */
export const WORKFLOW_EVERY = ["5m", "15m", "1h", "6h", "1d"] as const;
export const workflowEverySchema = z.enum(WORKFLOW_EVERY);
export type WorkflowEvery = z.infer<typeof workflowEverySchema>;

export const WORKFLOW_EVERY_MS: Readonly<Record<WorkflowEvery, number>> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

/** Five fields, each `*`, a number, a range, a list or a step. No seconds, no `L`, `W` or `#`. */
export const cronSchema = z
  .string()
  .trim()
  .refine((value) => {
    const fields = value.split(/\s+/);
    return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field));
  }, "A schedule is five fields: minute, hour, day of month, month, day of week — e.g. 0 7 * * 1-5.");

/** Whether a time zone name is one this runtime knows. */
export const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export const workflowInputDefSchema = z.object({
  /** How a step names it: `{{ input.<name> }}`. */
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "An input's name is letters, digits and _, starting with a letter.").max(40),
  /** What the agent asks the person for, in plain words. */
  description: z.string().trim().min(1).max(300),
  required: z.boolean().default(true),
});
export type WorkflowInputDef = z.infer<typeof workflowInputDefSchema>;

export const workflowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), cron: cronSchema, timezone: z.string().default("UTC").refine(isTimeZone, "Not a time zone this server knows.") }),
  z.object({ kind: z.literal("every"), every: workflowEverySchema }),
  /** A record of this type appears. The first run only takes note of what exists. */
  z.object({ kind: z.literal("record_created"), connection: idSchema, record: z.string().trim().min(1).max(120), every: workflowEverySchema.default("15m") }),
  /** A record of this type changes: any of `fields`, or anything when none are named. */
  z.object({
    kind: z.literal("record_changed"),
    connection: idSchema,
    record: z.string().trim().min(1).max(120),
    fields: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
    every: workflowEverySchema.default("15m"),
  }),
  /** Started by an agent's `run_workflow` tool. Its inputs become the tool's parameters. */
  z.object({ kind: z.literal("agent"), inputs: z.array(workflowInputDefSchema).max(12).default([]) }),
  z.object({ kind: z.literal("manual") }),
]);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;
export type WorkflowTriggerKind = WorkflowTrigger["kind"];

/** Triggers the runner watches: time, and changes in an API. */
export const isWatchedTrigger = (trigger: WorkflowTrigger): boolean =>
  trigger.kind === "schedule" || trigger.kind === "every" || trigger.kind === "record_created" || trigger.kind === "record_changed";

/** Triggers that read an API for what is new. */
export const isApiTrigger = (trigger: WorkflowTrigger): trigger is Extract<WorkflowTrigger, { kind: "record_created" | "record_changed" }> =>
  trigger.kind === "record_created" || trigger.kind === "record_changed";

/* ── what it reads ─────────────────────────────────────────────────────── */

export const WORKFLOW_RANGES = ["1h", "24h", "7d", "30d", "90d", "12mo", "ytd"] as const;

export const workflowSourceSchema = z
  .object({
    connection: idSchema,
    /** A record type, by id or name: its list endpoint is read. */
    record: z.string().trim().min(1).max(120).optional(),
    /** Or an endpoint, by id. */
    op: idSchema.optional(),
    params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    range: z.enum(WORKFLOW_RANGES).optional(),
  })
  .refine((source) => Boolean(source.record) !== Boolean(source.op), "Read either a record type or an endpoint.");
export type WorkflowSource = z.infer<typeof workflowSourceSchema>;

/**
 * How often a trigger may fire for one record, how long it rests in between,
 * and when it stops. Conservative defaults; matching never asks a model.
 */
export const triggerLimitsSchema = z.object({
  /** Times one record may open a case. Absent: no limit (a change trigger fires on every change). */
  maxPerRecord: z.number().int().min(1).max(1000).optional(),
  /** The least time between two cases for one record. */
  cooldown: z.string().regex(/^\d+(m|h|d|w)$/).optional(),
  /** After this, the trigger stops firing. ISO date. */
  expiresAt: z.string().optional(),
});
export type TriggerLimits = z.infer<typeof triggerLimitsSchema>;

/* ── steps and arrows ──────────────────────────────────────────────────── */

export const ownerRefSchema = z.object({ kind: z.enum(["agent", "member"]), id: z.string().min(1).max(120) });
export type OwnerRef = z.infer<typeof ownerRefSchema>;

export const ON_FAILURE = ["stop", "continue", "path"] as const;

export const workflowNodeSchema = z.object({
  id: idSchema,
  /** A catalog variant id: `outreach.text`, `update.record`. */
  action: z.string().min(3).max(64),
  /** What it is called in the builder and on its tasks. */
  name: z.string().trim().max(80).optional(),
  settings: z.record(z.unknown()).default({}),
  /** For steps that leave Dash: done in the run, or waiting for a person. */
  mode: workflowStepModeSchema.default("approve"),
  /** Only when this holds (`@freebirdai/expr` over the case). Otherwise skipped, and the case goes on. */
  when: z.string().trim().max(2000).optional(),
  /** The agent it acts in the name of. Outreach always names one in its settings. */
  agentId: idSchema.optional(),
  /** `stop` the case, `continue` to the next step, or follow the step's `failed` arrow. */
  onFailure: z.enum(ON_FAILURE).default("stop"),
  /** Retries for errors worth retrying: never a step that finished, never a send whose outcome is unknown. */
  retry: z.object({ times: z.number().int().min(0).max(5), delay: z.string().regex(/^\d+(m|h|d)$/) }).optional(),
  /** Whether its task offers Reverse, where the variant can. */
  reversible: z.boolean().default(true),
  /** A model for this step alone. Hidden for now: every step follows its model task. */
  model: z.string().min(1).max(120).optional(),
  /** Where it sits on the canvas. */
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

/** The arrow out of the trigger is `from: "trigger"`. */
export const TRIGGER_NODE = "trigger";

export const workflowEdgeSchema = z.object({
  id: idSchema,
  from: z.string().min(1).max(64),
  /** Which of the step's outcomes it leaves from: next, happened, timed_out, yes, a category… */
  outcome: z.string().min(1).max(80).default("next"),
  to: idSchema,
});
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowLimitsSchema = z.object({
  /** Times a case may pass through one step. */
  visitsPerStep: z.number().int().min(1).max(1000).default(10),
  /** Steps a case may take in all. */
  stepsPerCase: z.number().int().min(1).max(10000).default(200),
});

/** The mode a step runs in: what it says for a step that leaves Dash (always approve in trial); auto otherwise. */
export const nodeMode = (node: Pick<WorkflowNode, "action" | "mode">, trial = false): WorkflowStepMode => {
  const variant = actionVariant(node.action);
  if (!variant?.leavesDash) return "auto";
  return trial ? "approve" : node.mode;
};

/** A step's ways out, given its settings. */
export const nodeOutcomes = (node: Pick<WorkflowNode, "action" | "settings">): string[] => {
  const variant = actionVariant(node.action);
  return variant ? outcomesFor(variant, node.settings) : ["next"];
};

/** What a step is called: its own name, or its variant's. */
export const nodeName = (node: Pick<WorkflowNode, "name" | "action">): string => node.name?.trim() || actionVariant(node.action)?.label || node.action;

/* ── the workflow ──────────────────────────────────────────────────────── */

export const WORKFLOW_ONCE = ["per-row", "per-run"] as const;

const workflowShape = {
  name: z.string().trim().min(1).max(80),
  /** Shown in an agent's tool list when an agent can start it. */
  description: z.string().max(1000).default(""),
  trigger: workflowTriggerSchema,
  /** How often the trigger may fire per record. */
  triggerLimits: triggerLimitsSchema.default({}),
  source: workflowSourceSchema.optional(),
  /** Which rows matter: an `@freebirdai/expr` predicate over one row. Absent: all of them. */
  criteria: z.string().trim().max(2000).optional(),
  /** The field that tells rows apart. Default the record type's id field, else `id`. */
  rowKey: z.string().trim().min(1).max(200).optional(),
  /** `per-row`: a record opens a case once (until it stops matching). `per-run`: every match, every run. */
  once: z.enum(WORKFLOW_ONCE).default("per-row"),
  nodes: z.array(workflowNodeSchema).max(100).default([]),
  edges: z.array(workflowEdgeSchema).max(300).default([]),
  limits: workflowLimitsSchema.default({}),
  /**
   * Things no step may do, and when to stop and ask: read by Think steps and
   * by agents doing Outreach for this workflow. Like a standing order.
   */
  guardrails: z.string().max(4000).default(""),
};

export const workflowSchema = z.object({
  id: idSchema,
  ...workflowShape,
  enabled: z.boolean().default(false),
  /** Trial: while above zero, every step that leaves Dash asks for approval. Counts down as cases finish. */
  trial: z.number().int().min(0).max(100).default(0),
  /** The person who last saved it or turned it on. Automatic steps run with their permission. */
  enabledBy: principalSchema.optional(),
  /** Why it stopped by itself, until someone turns it back on. */
  parked: z.object({ reason: z.string(), at: z.string() }).optional(),
  /** Runs that failed in a row. */
  failures: z.number().int().min(0).default(0),
  /** The template it was made from, and which version. */
  fromTemplate: z.object({ id: z.string(), version: z.number().int() }).optional(),
  /** Moves on each time its steps, arrows, limits or guardrails change. A case keeps the version it opened on. */
  version: z.number().int().min(1).default(1),
  /** The trial cases already counted down, so a case is never counted twice. */
  trialCases: z.array(z.string()).max(500).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowSpec = z.infer<typeof workflowSchema>;

/** What a person sends to make or change a workflow; the server owns the id, the dates and who enabled it. */
export const workflowInputSchema = z.object({
  name: workflowShape.name,
  description: z.string().max(1000).optional(),
  enabled: z.boolean().optional(),
  /** Cases to run in trial. The chat saves new workflows with 5. */
  trial: z.number().int().min(0).max(100).optional(),
  trigger: workflowTriggerSchema,
  triggerLimits: triggerLimitsSchema.optional(),
  source: workflowSourceSchema.optional(),
  criteria: workflowShape.criteria,
  rowKey: workflowShape.rowKey,
  once: z.enum(WORKFLOW_ONCE).optional(),
  nodes: z.array(workflowNodeSchema).max(100).optional(),
  edges: z.array(workflowEdgeSchema).max(300).optional(),
  limits: workflowLimitsSchema.optional(),
  guardrails: z.string().max(4000).optional(),
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

/**
 * Where a workflow's rows come from: its source, or for an API trigger the
 * records it watches. Absent: it reads nothing and opens one case over its inputs.
 */
export const workflowReads = (workflow: Pick<WorkflowSpec, "trigger" | "source">): WorkflowSource | undefined => {
  if (isApiTrigger(workflow.trigger)) return { connection: workflow.trigger.connection, record: workflow.trigger.record };
  return workflow.source;
};

/** The step a case starts on: where the trigger's arrow points. */
export const firstNode = (workflow: Pick<WorkflowSpec, "edges" | "nodes">): string | undefined =>
  workflow.edges.find((edge) => edge.from === TRIGGER_NODE)?.to ?? workflow.nodes[0]?.id;

/**
 * Where a step's outcome leads. An outcome with no arrow of its own falls
 * back to the step's `next` arrow, except a failure, a time-out or a declined approval, which end
 * the case unless an arrow says where they go.
 */
export const nextNode = (workflow: Pick<WorkflowSpec, "edges">, from: string, outcome: string): string | undefined =>
  workflow.edges.find((edge) => edge.from === from && edge.outcome === outcome)?.to ??
  (outcome === "failed" || outcome === "timed_out" || outcome === "declined" ? undefined : workflow.edges.find((edge) => edge.from === from && edge.outcome === "next")?.to);

/** Arrows for a plain list of steps: trigger → first → second → … */
export const chainEdges = (nodes: ReadonlyArray<{ id: string }>): WorkflowEdge[] =>
  nodes.map((node, index) => {
    const from = index === 0 ? TRIGGER_NODE : nodes[index - 1]!.id;
    return { id: `e-${from}-${node.id}`.slice(0, 64), from, outcome: "next", to: node.id };
  });

/* ── runs, cases ───────────────────────────────────────────────────────── */

/** How a run or a case started. */
export const workflowStartSchema = z.object({
  kind: z.enum(["schedule", "every", "record_created", "record_changed", "agent", "manual", "approval", "workflow"]),
  /** The person who started it by hand, or approved the request that did. */
  userId: z.string().optional(),
  /** The agent that started it, or asked to. */
  agentId: z.string().optional(),
  conversation: z.string().optional(),
  /** For a case another workflow's step started: that case. */
  parentCase: z.string().optional(),
  /** For a case one of several a For each step started: that step's attempt, so the parent hears when all have ended. */
  group: z.string().optional(),
  /** How many cases that group has in all, fixed before the first starts: the group is done only when this many have ended. */
  groupSize: z.number().int().min(1).optional(),
});
export type WorkflowStart = z.infer<typeof workflowStartSchema>;

export const RUN_STATUSES = ["running", "succeeded", "failed", "parked", "seeded"] as const;

/** One pass of a trigger: what it read and which cases it opened. */
export const workflowRunSchema = z.object({
  id: z.string(),
  workflow: z.string(),
  workflowName: z.string(),
  agent: z.string().optional(),
  start: workflowStartSchema,
  inputs: z.record(z.unknown()).optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(RUN_STATUSES),
  read: z.number().int().default(0),
  matched: z.number().int().default(0),
  cases: z.array(z.string()).default([]),
  complete: z.boolean().default(true),
  summary: z.string().default(""),
  error: z.string().optional(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const CASE_STATUSES = ["running", "waiting", "done", "failed", "cancelled", "timed_out"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** What a waiting case waits for. `key` is what the event that wakes it carries. */
export const caseWaitSchema = z.object({
  node: z.string(),
  /** `approval`, `ask`, `time`, `reply`, `record_change`, `workflow_done`, `webhook`. */
  kind: z.string(),
  /** `task:<id>`, `reply:<conversation>`, `case-done:<id>`, `hook:<token>`, `record:<connection>:<entity>:<id>`, or `time`. */
  key: z.string(),
  /** ISO time it gives up. */
  deadline: z.string().optional(),
  /** For a record change: what to read, and the condition. */
  match: z.record(z.unknown()).optional(),
  /** The task that shows this wait. */
  task: z.string().optional(),
  /** The agent the waiting step acts for, so a check made while waiting reads as that agent may. */
  agent: z.string().optional(),
});
export type CaseWait = z.infer<typeof caseWaitSchema>;

/**
 * The step a case is on, saved before anything is done for it. Its id is the
 * step's operation id: the same on every try, so an outside system can tell a
 * repeat from a new request. `executing` is set just before the step acts; a
 * case found running with it set, and nobody working on it, was interrupted
 * in the middle of acting.
 */
export const caseAttemptSchema = z.object({
  id: z.string(),
  node: z.string(),
  /** The task this step writes to, on every try. */
  task: z.string(),
  tries: z.number().int().min(1).default(1),
  executing: z.boolean().default(false),
  /** Who approved this step, so a retry runs as them without asking again. */
  approvedBy: principalSchema.optional(),
  startedAt: z.string(),
});
export type CaseAttempt = z.infer<typeof caseAttemptSchema>;

/** The part of a workflow a case follows, frozen when it opens: changes to the workflow reach new cases only. */
export const caseDefinitionSchema = z.object({
  version: z.number().int().min(1),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
  limits: workflowLimitsSchema,
  guardrails: z.string().default(""),
  trigger: workflowTriggerSchema,
  source: workflowSourceSchema.optional(),
  rowKey: z.string().optional(),
});
export type CaseDefinition = z.infer<typeof caseDefinitionSchema>;

/** What a case freezes of its workflow. */
export const definitionOf = (workflow: WorkflowSpec): CaseDefinition => ({
  version: workflow.version,
  nodes: workflow.nodes,
  edges: workflow.edges,
  limits: workflow.limits,
  guardrails: workflow.guardrails,
  trigger: workflow.trigger,
  ...(workflow.source ? { source: workflow.source } : {}),
  ...(workflow.rowKey ? { rowKey: workflow.rowKey } : {}),
});

/** Calls deeper than this (a workflow starting one that starts another…) are refused. */
export const MAX_CALL_DEPTH = 5;

/**
 * One record's way through a workflow: its data, where it is, what it waits
 * for. Durable and revisioned: a write that does not carry the revision it
 * read is refused, so two writers never overwrite each other's progress.
 */
export const workflowCaseSchema = z.object({
  id: z.string(),
  workflow: z.string(),
  workflowName: z.string(),
  run: z.string().optional(),
  rowKey: z.string().optional(),
  status: z.enum(CASE_STATUSES),
  /** The step it is on, or will run next. */
  at: z.string().optional(),
  /** `row`, `input`, `steps` (each step's outputs by step id), `vars` (Update · case value). */
  data: z.object({
    row: z.record(z.unknown()).default({}),
    input: z.record(z.unknown()).default({}),
    steps: z.record(z.unknown()).default({}),
    vars: z.record(z.unknown()).default({}),
  }),
  waiting: caseWaitSchema.optional(),
  /** The step being worked on, saved before it acts. */
  attempt: caseAttemptSchema.optional(),
  /** The workflow as it was when the case opened. */
  definition: caseDefinitionSchema,
  /** The workflows above this one, outermost first, for a case another workflow started. */
  chain: z.array(z.string()).default([]),
  visits: z.record(z.number().int()).default({}),
  steps: z.number().int().default(0),
  revision: z.number().int().default(0),
  /** Sticky: no new step starts once set, even after a restart. */
  cancelRequested: z.boolean().default(false),
  agent: z.string().optional(),
  /** Whose permission its automatic steps use: who started it by hand, else who turned the workflow on. */
  actor: principalSchema.optional(),
  start: workflowStartSchema,
  /** Whether it runs in trial (every outside step asks). */
  trial: z.boolean().default(false),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /**
   * For an ended case: whether what follows its ending (the trial counted
   * down, cases waiting on it told) has been done. Written false in the same
   * save that ends it, so an interruption in between is picked up.
   */
  announced: z.boolean().optional(),
});
export type WorkflowCase = z.infer<typeof workflowCaseSchema>;

/** What a step's templates and conditions read: the record's fields, plus `input`, `steps`, `vars`. */
export const caseScope = (one: Pick<WorkflowCase, "data">): Record<string, unknown> => ({
  ...one.data.row,
  input: one.data.input,
  steps: one.data.steps,
  vars: one.data.vars,
});

/* ── tasks ─────────────────────────────────────────────────────────────── */

export const TASK_STATUSES = [
  "waiting_approval",
  "waiting",
  "running",
  "done",
  "skipped",
  "failed",
  "timed_out",
  "lost",
  "reversed",
  "dismissed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses a task never moves on from: a late signal is recorded, never applied. */
export const FINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "skipped", "failed", "timed_out", "lost", "reversed", "dismissed"];

const fieldChangeSchema = z.object({ field: z.string(), label: z.string().optional(), before: z.unknown().optional(), after: z.unknown().optional() });

/** What a task shows, by kind (`actions.ts` `TASK_BODY_KINDS`). */
export const taskBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notice"), text: z.string().default(""), audience: z.string().optional() }),
  z.object({ kind: z.literal("change"), what: z.string(), changes: z.array(fieldChangeSchema).default([]) }),
  z.object({ kind: z.literal("created"), what: z.string(), id: z.string().optional(), link: z.string().optional(), record: z.unknown().optional() }),
  z.object({ kind: z.literal("removed"), what: z.string(), before: z.unknown().optional() }),
  z.object({
    kind: z.literal("conversation"),
    channel: z.string(),
    to: z.string(),
    agent: z.string(),
    sent: z.string().optional(),
    reply: z.string().optional(),
    conversation: z.string().optional(),
  }),
  z.object({ kind: z.literal("wait"), forWhat: z.string(), deadline: z.string().optional(), ended: z.enum(["happened", "timed_out"]).optional() }),
  z.object({ kind: z.literal("decision"), outcome: z.string().optional(), reason: z.string().optional(), answer: z.unknown().optional() }),
  z.object({ kind: z.literal("request"), url: z.string(), status: z.number().optional(), response: z.unknown().optional() }),
  z.object({ kind: z.literal("todo"), details: z.string().default(""), assignee: z.string().optional(), due: z.string().optional(), done: z.boolean().default(false) }),
  z.object({ kind: z.literal("question"), question: z.string(), options: z.array(z.string()).default([]), answer: z.string().optional(), assignee: z.string().optional() }),
]);
export type TaskBody = z.infer<typeof taskBodySchema>;

/** How a task can be undone: through the write review, or inside Dash. */
export const taskReversalSchema = z.object({
  available: z.boolean(),
  /** Why not, when not. */
  reason: z.string().optional(),
  /** For an account change: the change that undoes it, prepared fresh when someone presses Reverse. */
  intent: z.record(z.unknown()).optional(),
  /** For something inside Dash: what to remove or put back. */
  internal: z.object({ kind: z.enum(["calendar", "note", "todo", "notice", "case_value"]), id: z.string(), value: z.unknown().optional() }).optional(),
  /** Its effect: "a new record, with a new id". */
  note: z.string().optional(),
  reversedBy: z.string().optional(),
  reversedAt: z.string().optional(),
  reversalTask: z.string().optional(),
});
export type TaskReversal = z.infer<typeof taskReversalSchema>;

/**
 * The record of one action in one case. Every step leaves one, whatever
 * happens; approvals are tasks waiting for approval. The Overview's completed
 * list and "Waiting for you" both read tasks.
 */
export const taskSchema = z.object({
  id: z.string(),
  workflow: z.string().optional(),
  workflowName: z.string().optional(),
  case: z.string().optional(),
  node: z.string().optional(),
  /** Catalog variant id. */
  action: z.string(),
  base: z.string(),
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  body: taskBodySchema,
  /** The person whose permission it used. */
  actedAs: z.string().optional(),
  agent: z.string().optional(),
  approvedBy: z.string().optional(),
  /** For a task waiting for approval: the settings it will run with, frozen when it was proposed. */
  pending: z.record(z.unknown()).optional(),
  links: z
    .object({
      journal: z.string().optional(),
      record: z.object({ connection: z.string(), entity: z.string(), id: z.string().optional() }).optional(),
      conversation: z.string().optional(),
      calendar: z.string().optional(),
      startedCase: z.string().optional(),
    })
    .default({}),
  reversal: taskReversalSchema.optional(),
  /** For Outreach: sending and delivery, apart from whether the step worked. */
  delivery: z
    .object({ status: z.enum(["queued", "sent", "delivered", "failed", "not_sent"]), detail: z.string().optional(), key: z.string().optional() })
    .optional(),
  model: z.object({ task: z.string(), model: z.string().optional() }).optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** A signal that arrived after the task finished: kept, never applied. */
  late: z.array(z.object({ at: z.string(), what: z.string() })).optional(),
  /** The case step it belongs to: an approval applies only to the attempt it was made for. */
  attempt: z.string().optional(),
  /** How it ended and what it handed on, so a case interrupted after the task was written goes on without doing it again. */
  outcome: z.string().optional(),
  outputs: z.record(z.unknown()).optional(),
  /** What the case waits for while this task waits, so an interrupted case can be put back to waiting. */
  wait: caseWaitSchema.optional(),
  /** Dash stopped, or the answer was lost, while this was being sent: it may or may not have happened. A person says which. */
  uncertain: z.boolean().optional(),
  /**
   * The reviews prepared for this task, by what they are for: approving its
   * change, or reversing it. Each names the prepared change, who prepared it
   * and, for an approval, the case step it is for. A review is accepted only
   * for the task, purpose, person and step it was prepared for.
   */
  reviews: z
    .object({
      approve: z.object({ pendingId: z.string(), by: z.string(), attempt: z.string().optional(), at: z.string() }).optional(),
      reverse: z.object({ pendingId: z.string(), by: z.string(), at: z.string() }).optional(),
    })
    .optional(),
  /** Tries so far, and when the next one is due, for a step set to retry. */
  tries: z.number().int().optional(),
  retryAt: z.string().optional(),
});
export type Task = z.infer<typeof taskSchema>;

/* ── templates ─────────────────────────────────────────────────────────── */

export const TEMPLATE_KINDS = ["step", "path", "workflow"] as const;

/**
 * Something saved for reuse: one step, a piece of the graph with one way in,
 * or a whole workflow. Its blanks (`{{ blank.<name> }}` in any setting) are
 * asked for each time it is inserted. Inserting copies it; a newer version is
 * offered, never forced.
 */
export const workflowTemplateSchema = z.object({
  id: idSchema,
  kind: z.enum(TEMPLATE_KINDS),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).default(""),
  version: z.number().int().min(1).default(1),
  blanks: z
    .array(z.object({ name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), label: z.string().max(200), default: z.string().max(2000).optional() }))
    .max(30)
    .default([]),
  nodes: z.array(workflowNodeSchema).max(100).default([]),
  edges: z.array(workflowEdgeSchema).max(300).default([]),
  /** The step a path starts at. */
  entry: z.string().optional(),
  /** For a workflow template: everything but its steps. */
  workflow: z.record(z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;

/**
 * An entry on the calendar. Defined here so a workflow's calendar step works
 * before the calendar view exists; the calendar (step 4) owns its shape.
 */
export const calendarEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** ISO date or date-time. */
  at: z.string(),
  end: z.string().optional(),
  allDay: z.boolean().default(false),
  deadline: z.boolean().default(false),
  owner: ownerRefSchema.optional(),
  workflow: z.string().optional(),
  case: z.string().optional(),
  task: z.string().optional(),
  createdAt: z.string(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/** One line for a step: "Text — Maintenance agent", "Wait for an event — up to 2 days". */
export const describeNode = (node: Pick<WorkflowNode, "action" | "settings" | "name">): string => {
  const variant = actionVariant(node.action);
  const label = variant ? variant.label : node.action;
  const s = node.settings;
  const extra =
    variant?.id === "wait.for" || variant?.base === "ask"
      ? `up to ${describeDuration(s["timeout"] ?? "2d")}`
      : variant?.id === "wait.duration"
        ? describeDuration(s["duration"])
        : variant?.id === "branch.if" && typeof s["condition"] === "string"
          ? String(s["condition"])
          : "";
  return `${node.name?.trim() || label}${extra ? ` — ${extra}` : ""}`;
};

/* ── words ─────────────────────────────────────────────────────────────── */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const EVERY_WORDS: Readonly<Record<WorkflowEvery, string>> = {
  "5m": "Every 5 minutes",
  "15m": "Every 15 minutes",
  "1h": "Every hour",
  "6h": "Every 6 hours",
  "1d": "Every day",
};

/** A schedule in words where it is a common one: "Weekdays at 7:00". Otherwise the five fields. */
export const describeCron = (cron: string): string => {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  if (!minute || !hour || !dom || !month || !dow || !/^\d+$/.test(minute) || !/^\d+$/.test(hour) || dom !== "*" || month !== "*") {
    return `On the schedule ${cron.trim()}`;
  }
  const time = `${Number(hour)}:${minute.padStart(2, "0")}`;
  if (dow === "*") return `Every day at ${time}`;
  if (dow === "1-5") return `Weekdays at ${time}`;
  if (dow === "0,6" || dow === "6,0") return `Weekends at ${time}`;
  if (/^\d$/.test(dow) && DAYS[Number(dow)]) return `Every ${DAYS[Number(dow)]} at ${time}`;
  return `On the schedule ${cron.trim()}`;
};

/**
 * The trigger in words, for a list row: "When a new work order appears on
 * Rentvine", "When Maintenance agent is asked", "Weekdays at 7:00".
 */
export const describeTrigger = (
  trigger: WorkflowTrigger,
  names: {
    readonly connection?: (id: string) => string;
    readonly record?: (connection: string, record: string) => string;
    /** The agents whose tools start it. */
    readonly agents?: readonly string[];
  } = {},
): string => {
  switch (trigger.kind) {
    case "schedule":
      return describeCron(trigger.cron) + (trigger.timezone && trigger.timezone !== "UTC" ? ` (${trigger.timezone})` : " (UTC)");
    case "every":
      return EVERY_WORDS[trigger.every];
    case "record_created":
    case "record_changed": {
      const record = (names.record?.(trigger.connection, trigger.record) ?? trigger.record).toLowerCase();
      const where = names.connection?.(trigger.connection) ?? trigger.connection;
      return trigger.kind === "record_created"
        ? `When a new ${record} appears on ${where}`
        : `When a ${record} changes on ${where}${trigger.fields && trigger.fields.length > 0 ? ` (${trigger.fields.join(", ")})` : ""}`;
    }
    case "agent":
      return names.agents && names.agents.length > 0
        ? `When ${names.agents.join(" or ")} ${names.agents.length === 1 ? "is" : "are"} asked`
        : "When an agent is asked";
    case "manual":
      return "By hand";
  }
};
