import { idSchema } from "@freebirdai/connect-spec";
import { z } from "zod";
import { principalSchema, type Permission } from "./access.js";

/**
 * A workflow: a trigger and a path.
 *
 * Agents and workflows are two different things, and either can use the
 * other (`agent.ts`). A workflow starts from a trigger, follows its steps, and
 * ends. It is started one of four ways:
 *
 * - **by time**: a schedule ("weekdays at 7") or an interval;
 * - **by something in an API**: a record appears, or one changes. Polled for
 *   now; a webhook replaces the polling later without changing this shape;
 * - **by an agent**, as a tool it calls in a conversation. Its `inputs` become
 *   the tool's parameters;
 * - **by hand**.
 *
 * It can read records (`source`), keep only the ones that matter (`criteria`,
 * an `@freebirdai/expr` predicate over one row), and run its `steps` for each.
 *
 * **Each step is auto or approve.** An approve step becomes a proposal that
 * waits for a person; an auto step is done during the run, with the
 * permission of the person who turned the workflow on (`enabledBy`). A step's
 * optional `when` is a condition over the row, which is what gives simple
 * paths: if this, do X automatically; if that, propose Y. Calendar entries and
 * notes never leave Dash, so they are always done.
 *
 * **No agent's reply prompt is ever used here.** A workflow's own steps —
 * reading, criteria, changes, calendar entries, its `think` step — are set up
 * in the workflow and run on their own model task. An agent's role,
 * instructions and personality shape only messages it writes to a person,
 * which is what a `message` step hands it.
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

/* ── steps ─────────────────────────────────────────────────────────────── */

/**
 * Text in a step is a template: `{{ … }}` holds an `@freebirdai/expr`
 * expression over the row (`{{ unit.name }}`, `{{ input.date }}`). A value
 * that is one expression and nothing else keeps its type — a number stays a
 * number. `when` is a predicate, written without braces.
 */
const templateSchema = (max: number) => z.string().max(max);

const stepBase = {
  id: idSchema,
  /** Matters for steps that leave Dash; calendar entries and notes are always done. */
  mode: workflowStepModeSchema.default("approve"),
  /** Only for rows where this holds (`@freebirdai/expr`). Absent: every matched row. */
  when: z.string().trim().max(2000).optional(),
};

export const ownerRefSchema = z.object({ kind: z.enum(["agent", "member"]), id: z.string().min(1).max(120) });
export type OwnerRef = z.infer<typeof ownerRefSchema>;

export const calendarStepSchema = z.object({
  ...stepBase,
  kind: z.literal("calendar"),
  title: templateSchema(300).pipe(z.string().trim().min(1, "Give the calendar entry a title.")),
  /** When: a date or a date and time, usually from the row (`{{ due_date }}`). */
  at: templateSchema(300).pipe(z.string().trim().min(1, "Say when it goes on the calendar.")),
  end: templateSchema(300).optional(),
  allDay: z.boolean().default(false),
  /** A deadline, rather than an appointment. */
  deadline: z.boolean().default(false),
  owner: ownerRefSchema.optional(),
});

export const PROPOSE_CHANGES = ["update", "action", "create"] as const;

export const proposeChangeStepSchema = z.object({
  ...stepBase,
  kind: z.literal("propose_change"),
  /** Default: the connection the workflow reads. */
  connection: idSchema.optional(),
  /** A record type, by id or name. */
  entity: z.string().trim().min(1, "Say which record type the change is on.").max(120),
  change: z.enum(PROPOSE_CHANGES),
  /** For `action`: which one. */
  action: z.string().trim().min(1).max(120).optional(),
  /** Which record: usually `{{ id }}`. Not for a create. */
  recordId: templateSchema(300).optional(),
  /** Ids of what the record lives under, by parameter. */
  parents: z.record(templateSchema(300)).optional(),
  /** Request-body fields to set, by path. */
  values: z.record(templateSchema(2000)).optional(),
});

export const MESSAGE_CHANNELS = ["text", "call", "email"] as const;

/**
 * Hand a conversation to an agent: it texts, calls or emails someone, and
 * from then on answers with its own reply prompt and tools. Delivery arrives
 * with Comms (steps 7 and 9); until then a run says the step is waiting for it.
 */
export const messageStepSchema = z.object({
  ...stepBase,
  kind: z.literal("message"),
  agentId: z.string().min(1, "Pick the agent that reaches out.").pipe(idSchema),
  channel: z.enum(MESSAGE_CHANNELS),
  /** A phone number or address, usually from the row: `{{ tenant.phone }}`. */
  to: templateSchema(300).pipe(z.string().trim().min(1, "Say who to reach.")),
  /** What the conversation is for. The agent writes the words. */
  purpose: templateSchema(2000).pipe(z.string().trim().min(1, "Say what the conversation is for.")),
});

/**
 * One bounded model turn over the matched rows, on the `workflow` model task,
 * with the workflow's own prompt. Its mode applies to the changes it proposes.
 */
export const thinkStepSchema = z.object({
  ...stepBase,
  kind: z.literal("think"),
  prompt: z.string().trim().min(1, "Say what to think through.").max(8000),
});

export const noteStepSchema = z.object({
  ...stepBase,
  kind: z.literal("note"),
  text: templateSchema(2000).pipe(z.string().trim().min(1, "Write the note.")),
});

export const workflowStepSchema = z.discriminatedUnion("kind", [
  calendarStepSchema,
  proposeChangeStepSchema,
  messageStepSchema,
  thinkStepSchema,
  noteStepSchema,
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowStepKind = WorkflowStep["kind"];
export const WORKFLOW_STEP_KINDS = ["calendar", "propose_change", "message", "think", "note"] as const satisfies readonly WorkflowStepKind[];

export interface WorkflowStepInfo {
  readonly kind: WorkflowStepKind;
  readonly label: string;
  /** Whether it reaches outside Dash, and so whether its mode matters. */
  readonly leavesDash: boolean;
  /** Done once a run rather than once a row. */
  readonly perRun: boolean;
}

export const WORKFLOW_STEP_INFO: Readonly<Record<WorkflowStepKind, WorkflowStepInfo>> = {
  calendar: { kind: "calendar", label: "Put it on the calendar", leavesDash: false, perRun: false },
  propose_change: { kind: "propose_change", label: "Change a record", leavesDash: true, perRun: false },
  message: { kind: "message", label: "Have an agent reach out", leavesDash: true, perRun: false },
  think: { kind: "think", label: "Think it through", leavesDash: true, perRun: true },
  note: { kind: "note", label: "Write a note", leavesDash: false, perRun: true },
};

/** The mode a step actually runs in: what it says, for a step that leaves Dash; auto otherwise. */
export const stepMode = (step: Pick<WorkflowStep, "kind" | "mode">): WorkflowStepMode =>
  WORKFLOW_STEP_INFO[step.kind].leavesDash ? step.mode : "auto";

/** The permission a step's change needs. Absent for steps that change no account. */
export const changePermission = (change: (typeof PROPOSE_CHANGES)[number]): Permission =>
  change === "create" ? "records.create" : change === "update" ? "records.update" : "records.act";

/* ── the workflow ──────────────────────────────────────────────────────── */

export const WORKFLOW_ONCE = ["per-row", "per-run"] as const;

export const workflowSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(false),
  /** Shown in an agent's tool list when an agent can start it. */
  description: z.string().max(1000).default(""),
  trigger: workflowTriggerSchema,
  source: workflowSourceSchema.optional(),
  /** Which rows matter: an `@freebirdai/expr` predicate over one row. Absent: all of them. */
  criteria: z.string().trim().max(2000).optional(),
  /** The field that tells rows apart. Default the record type's id field, else `id`. */
  rowKey: z.string().trim().min(1).max(200).optional(),
  /**
   * `per-row`: a row is acted on once, ever (until it stops matching and
   * matches again). `per-run`: every matching row, every run.
   */
  once: z.enum(WORKFLOW_ONCE).default("per-row"),
  steps: z.array(workflowStepSchema).max(30).default([]),
  /** The person who last turned it on or set a step to auto. Auto steps run with their permission. */
  enabledBy: principalSchema.optional(),
  /** Why it stopped by itself — access lost, or failing again and again — until someone turns it back on. */
  parked: z.object({ reason: z.string(), at: z.string() }).optional(),
  /** Runs that failed in a row; three turns it off. */
  failures: z.number().int().min(0).default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowSpec = z.infer<typeof workflowSchema>;

/** What a person sends to make or change a workflow; the server owns the id, the dates and who enabled it. */
export const workflowInputSchema = z.object({
  name: workflowSchema.shape.name,
  enabled: z.boolean().optional(),
  description: z.string().max(1000).optional(),
  trigger: workflowTriggerSchema,
  source: workflowSourceSchema.optional(),
  criteria: workflowSchema.shape.criteria,
  rowKey: workflowSchema.shape.rowKey,
  once: z.enum(WORKFLOW_ONCE).optional(),
  steps: z.array(workflowStepSchema).max(30).optional(),
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

/**
 * Where a workflow's rows come from: its source, or for an API trigger the
 * records it watches. Absent: it reads nothing and runs once, over its inputs.
 */
export const workflowReads = (workflow: Pick<WorkflowSpec, "trigger" | "source">): WorkflowSource | undefined => {
  if (isApiTrigger(workflow.trigger)) return { connection: workflow.trigger.connection, record: workflow.trigger.record };
  return workflow.source;
};

/* ── runs, proposals, calendar entries ─────────────────────────────────── */

/** How a run started. */
export const workflowStartSchema = z.object({
  kind: z.enum(["schedule", "every", "record_created", "record_changed", "agent", "manual", "proposal"]),
  /** The person who started it by hand, or applied the request that did. */
  userId: z.string().optional(),
  /** The agent that started it, or asked to. */
  agentId: z.string().optional(),
  /** The conversation the agent was in. */
  conversation: z.string().optional(),
});
export type WorkflowStart = z.infer<typeof workflowStartSchema>;

export const RUN_OUTCOMES = ["done", "proposed", "skipped", "failed"] as const;

export const workflowRunOutputSchema = z.object({
  step: z.string(),
  kind: z.string(),
  /** The row it was for, by its key. Absent for a step done once a run. */
  row: z.string().optional(),
  outcome: z.enum(RUN_OUTCOMES),
  detail: z.string(),
  proposal: z.string().optional(),
  calendar: z.string().optional(),
  /** The journal event of a change made during the run. */
  journal: z.string().optional(),
});
export type WorkflowRunOutput = z.infer<typeof workflowRunOutputSchema>;

export const RUN_STATUSES = ["running", "succeeded", "failed", "parked", "seeded"] as const;

export const workflowRunSchema = z.object({
  id: z.string(),
  workflow: z.string(),
  workflowName: z.string(),
  /** Set when an agent started the run, or a step acted in its name. */
  agent: z.string().optional(),
  start: workflowStartSchema,
  inputs: z.record(z.unknown()).optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** `seeded`: an API trigger's first run, which only takes note of what exists. */
  status: z.enum(RUN_STATUSES),
  /** Rows read, and rows that matched the criteria and were acted on. */
  read: z.number().int().default(0),
  matched: z.number().int().default(0),
  /** Whether the read is known to have reached every record. */
  complete: z.boolean().default(true),
  summary: z.string().default(""),
  outputs: z.array(workflowRunOutputSchema).default([]),
  /**
   * Where a running run has got to: the step it is on (1-based, of how many)
   * and the record it is on. Written as it goes, so the Overview can say so.
   */
  stage: z
    .object({
      step: z.string(),
      kind: z.string(),
      index: z.number().int(),
      of: z.number().int(),
      row: z.string().optional(),
      rowIndex: z.number().int().optional(),
      rows: z.number().int().optional(),
    })
    .optional(),
  error: z.string().optional(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const PROPOSAL_STATUSES = ["waiting", "applied", "dismissed", "failed", "stale"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * Something waiting for a person.
 *
 * `kind` is `change` (an approve step's change to a record) or
 * `workflow_start` (an agent asked to start a workflow through a tool set to
 * approve). Comms adds `email` and `sms`; an agent tool set to approve, from a
 * conversation, is named by its tool kind.
 *
 * What is stored is the intent, never a review: a review is prepared fresh,
 * as the person looking at it, when they open it.
 */
export const proposalSchema = z.object({
  id: z.string(),
  kind: z.string().min(1).max(60),
  agent: z.string().optional(),
  workflow: z.string().optional(),
  run: z.string().optional(),
  conversation: z.string().optional(),
  /** For `change`: the write intent. For `workflow_start`: `{ workflow, inputs }`. */
  intent: z.record(z.unknown()),
  /** One line: what would happen. */
  title: z.string(),
  /** Why it was proposed. */
  reason: z.string().default(""),
  status: z.enum(PROPOSAL_STATUSES),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  /** The journal event of the change, once applied. */
  journalId: z.string().optional(),
  /** For `workflow_start`: the run that applying it started. */
  startedRun: z.string().optional(),
  /** Why it failed or went stale. */
  error: z.string().optional(),
});
export type Proposal = z.infer<typeof proposalSchema>;

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
  run: z.string().optional(),
  row: z.string().optional(),
  createdAt: z.string(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

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
