import { z } from "zod";
import type { Permission } from "./access.js";

/**
 * The action catalog: what a workflow step can be.
 *
 * Three layers. A **base action** says what kind of thing happens (Create,
 * Outreach, Wait). A **variant** says what it happens to (a record, a
 * calendar entry; a text, an email). Its **settings** say exactly how. The
 * builder, the chat and the validator all read this one catalog: a new
 * capability is a new variant, declared here with its executor on the server,
 * and nothing else changes.
 *
 * Every action leaves one task when it runs (`workflow.ts`), shaped by its
 * variant's `body`.
 */

export const ACTION_BASES = [
  "create",
  "update",
  "delete",
  "outreach",
  "notify",
  "lookup",
  "ask",
  "assign",
  "think",
  "send",
  "wait",
  "branch",
  "run_workflow",
] as const;
export type ActionBase = (typeof ACTION_BASES)[number];

export const BASE_INFO: Readonly<Record<ActionBase, { readonly label: string; readonly premise: string; readonly steers: boolean }>> = {
  create: { label: "Create", premise: "Make something new: a record, a calendar entry, a note, a to-do.", steers: false },
  update: { label: "Update", premise: "Change something that exists.", steers: false },
  delete: { label: "Delete", premise: "Remove something.", steers: false },
  outreach: { label: "Outreach", premise: "Reach a customer or anyone outside the team, by text, call or email, from an agent.", steers: false },
  notify: { label: "Notify", premise: "Tell the team.", steers: false },
  lookup: { label: "Look up", premise: "Get information into the case without changing anything.", steers: false },
  ask: { label: "Ask a person", premise: "Get a decision or an answer from a teammate before going on.", steers: false },
  assign: { label: "Assign", premise: "Give something an owner.", steers: false },
  think: { label: "Think", premise: "Let a model decide or write, inside set limits.", steers: false },
  send: { label: "Send to a system", premise: "Reach a system that is not a connection.", steers: false },
  wait: { label: "Wait", premise: "Pause the case: for a time, until a time, or for an event with a time limit.", steers: true },
  branch: { label: "Branch", premise: "Take a different path depending on the case.", steers: true },
  run_workflow: { label: "Run a workflow", premise: "Start another workflow with inputs from this case.", steers: false },
};

/** How a task looks: the body shape a variant's tasks carry. */
export const TASK_BODY_KINDS = ["notice", "change", "created", "removed", "conversation", "wait", "decision", "request", "todo", "question"] as const;
export type TaskBodyKind = (typeof TASK_BODY_KINDS)[number];

/** Model tasks a variant's calls run on (`models.ts`). Every one follows the chat's model until given its own. */
export const ACTION_MODEL_TASKS = ["outreach", "agent-reply", "agent-tools", "think", "wait-match", "workflow-draft"] as const;
export type ActionModelTask = (typeof ACTION_MODEL_TASKS)[number];

/* ── settings ──────────────────────────────────────────────────────────── */

/**
 * The kinds of setting a variant can have. The builder draws each its own
 * way; the server checks each its own way.
 *
 * - `template`: text with `{{ … }}` read from the case.
 * - `expression`: an `@freebirdai/expr` predicate, bare.
 * - `duration`: "30m", "2h", "3d", "1w".
 * - `values`: field path → template.
 * - `choices`: a list of short words (categories, options, fields).
 * - `connection`, `record_type`, `agent`, `workflow`, `step`: ids of those things.
 */
export const FIELD_KINDS = [
  "text",
  "template",
  "longtext",
  "expression",
  "duration",
  "number",
  "boolean",
  "select",
  "values",
  "choices",
  "connection",
  "record_type",
  "agent",
  "workflow",
  "step",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface ActionField {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required?: boolean;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly default?: unknown;
  readonly placeholder?: string;
  readonly help?: string;
  /** How the chat asks for it when it is missing. */
  readonly ask?: string;
  /** Shown only when another setting has this value. */
  readonly showWhen?: { readonly key: string; readonly equals: unknown };
}

/** A rule the chat and the builder use to suggest something the person may have meant. */
export type SuggestionId = "follow_up_after_outreach" | "outreach_on_auto" | "delete_on_auto" | "think_on_auto";

export interface ActionVariant {
  /** `<base>.<variant>`. */
  readonly id: string;
  readonly base: ActionBase;
  readonly label: string;
  /** One line: what it does. */
  readonly does: string;
  readonly fields: readonly ActionField[];
  /** The named ways out of a step: what its arrows leave from. Variants whose outcomes depend on settings use `outcomesFor`. */
  readonly outcomes: readonly string[];
  /** What later steps can read, as `{{ steps.<id>.<name> }}`. */
  readonly outputs: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly body: TaskBodyKind;
  /** Whether it reaches outside Dash, and so whether Auto or Approve matters. */
  readonly leavesDash: boolean;
  readonly reversible: boolean;
  /** Declared now, built later: shown as "coming". */
  readonly available: boolean;
  /** The account permission an automatic run needs from the person it runs as. */
  readonly permission?: Permission;
  readonly modelTask?: ActionModelTask;
  /** The mode a new step of this kind starts in. */
  readonly defaultMode: "auto" | "approve";
  readonly suggestions?: readonly SuggestionId[];
  /**
   * What to do when Dash stopped while this step was acting. `repeat`: run it
   * again — it cannot do the same thing twice (it checks first, or carries the
   * step's operation id, or only touches Dash). `review`: a person says whether
   * it happened, because doing it twice would do it twice.
   */
  readonly interrupted: "repeat" | "review";
}

const CONNECTION: ActionField = { key: "connection", label: "Connection", kind: "connection", ask: "Which connection is it on?", help: "Default: the one the workflow reads." };
const ENTITY: ActionField = { key: "entity", label: "Record type", kind: "record_type", required: true, ask: "Which kind of record?" };
const RECORD_ID: ActionField = { key: "recordId", label: "Which record", kind: "template", required: true, default: "{{ id }}", placeholder: "{{ id }}" };
const AGENT: ActionField = { key: "agentId", label: "From agent", kind: "agent", required: true, ask: "Which agent should it come from? It writes in that agent's voice." };
const TO: ActionField = { key: "to", label: "To", kind: "template", required: true, placeholder: "{{ phone }}", ask: "Who should it reach? (a field on the record, or an address)" };
const PARENTS: ActionField = { key: "parents", label: "Parent ids", kind: "values", help: "For a record that lives under another: the ids of the records above it." };
const PURPOSE: ActionField = { key: "purpose", label: "What it is for", kind: "longtext", required: true, placeholder: "Let them know the work order was received", ask: "What should the message say or be for?" };
const TIMEOUT: ActionField = { key: "timeout", label: "Give up after", kind: "duration", required: true, default: "2d", ask: "How long should it wait before giving up?" };

const variant = (one: Omit<ActionVariant, "available" | "reversible" | "leavesDash" | "defaultMode" | "outputs" | "interrupted"> & Partial<ActionVariant>): ActionVariant => ({
  available: true,
  interrupted: "repeat",
  reversible: false,
  leavesDash: false,
  defaultMode: "auto",
  outputs: [],
  ...one,
});

export const ACTION_VARIANTS: readonly ActionVariant[] = [
  /* ── create ── */
  variant({
    id: "create.record", base: "create", label: "Create a record", does: "Create a record on a connection.",
    fields: [CONNECTION, ENTITY, { key: "values", label: "Values", kind: "values", required: true, ask: "What should the new record hold?" }, PARENTS],
    outcomes: ["next", "failed"], outputs: [{ name: "id", description: "The new record's id" }, { name: "record", description: "The record as the API returned it" }],
    body: "created", leavesDash: true, reversible: true, permission: "records.create", defaultMode: "approve", interrupted: "review",
  }),
  variant({
    id: "create.calendar", base: "create", label: "Calendar entry", does: "Put an entry or a deadline on the team's calendar.",
    fields: [
      { key: "title", label: "Title", kind: "template", required: true, ask: "What should the calendar entry be called?" },
      { key: "at", label: "When", kind: "template", required: true, placeholder: "{{ due_date }}", ask: "When should it go on the calendar?" },
      { key: "end", label: "Ends", kind: "template" },
      { key: "deadline", label: "It is a deadline", kind: "boolean", default: false },
      { key: "ownerAgent", label: "Owner (agent)", kind: "agent" },
    ],
    outcomes: ["next", "failed"], outputs: [{ name: "id", description: "The entry's id" }, { name: "at", description: "When it is" }],
    body: "created", reversible: true,
  }),
  variant({
    id: "create.note", base: "create", label: "Note", does: "Write a note on the case.",
    fields: [{ key: "text", label: "Note", kind: "template", required: true, ask: "What should the note say?" }],
    outcomes: ["next"], outputs: [{ name: "text", description: "The note" }], body: "notice", reversible: true,
  }),
  variant({
    id: "create.todo", base: "create", label: "To-do for a person", does: "Give a teammate something to do.",
    fields: [
      { key: "title", label: "Title", kind: "template", required: true, ask: "What is the to-do?" },
      { key: "details", label: "Details", kind: "longtext" },
      { key: "assignee", label: "Assignee", kind: "text", placeholder: "A member's id, or leave empty for anyone", help: "Leave empty for whoever picks it up." },
      { key: "due", label: "Due", kind: "template" },
    ],
    outcomes: ["next"], outputs: [{ name: "id", description: "The to-do's id" }], body: "todo", reversible: true,
  }),
  variant({ id: "create.document", base: "create", label: "Document to share", does: "Write a document from the case and share a link.", fields: [], outcomes: ["next"], body: "created", available: false }),
  variant({ id: "create.export", base: "create", label: "Report or export", does: "Export records as a file.", fields: [], outcomes: ["next"], body: "created", available: false }),

  /* ── update ── */
  variant({
    id: "update.record", base: "update", label: "Update record fields", does: "Change fields on a record.",
    fields: [CONNECTION, ENTITY, RECORD_ID, PARENTS, { key: "values", label: "New values", kind: "values", required: true, ask: "Which fields should change, and to what?" }, { key: "onlyIf", label: "Only if still", kind: "expression", placeholder: 'status == "open"', help: "Skip it if the record no longer looks like this." }],
    outcomes: ["next", "failed"], outputs: [{ name: "changed", description: "The fields that changed" }],
    body: "change", leavesDash: true, reversible: true, permission: "records.update", defaultMode: "approve",
  }),
  variant({
    id: "update.action", base: "update", label: "Run a record's action", does: "Run an action the API offers, like assign or close.",
    fields: [CONNECTION, ENTITY, RECORD_ID, PARENTS, { key: "action", label: "Action", kind: "text", required: true, ask: "Which action should it run?" }, { key: "values", label: "Inputs", kind: "values" }],
    outcomes: ["next", "failed"], body: "change", leavesDash: true, reversible: true, permission: "records.act", defaultMode: "approve", interrupted: "review",
  }),
  variant({
    id: "update.case", base: "update", label: "Case value", does: "Keep a named value on the case for later steps.",
    fields: [{ key: "name", label: "Name", kind: "text", required: true, placeholder: "followups" }, { key: "value", label: "Value", kind: "template", required: true, placeholder: "{{ vars.followups + 1 }}" }],
    outcomes: ["next"], outputs: [{ name: "value", description: "The new value" }], body: "change", reversible: true,
  }),

  /* ── delete ── */
  variant({
    id: "delete.record", base: "delete", label: "Delete a record", does: "Delete a record on a connection.",
    fields: [CONNECTION, ENTITY, RECORD_ID, PARENTS],
    outcomes: ["next", "failed"], body: "removed", leavesDash: true, reversible: true, permission: "records.delete", defaultMode: "approve", interrupted: "review",
    suggestions: ["delete_on_auto"],
  }),
  variant({
    id: "delete.calendar", base: "delete", label: "Remove a calendar entry", does: "Remove a calendar entry an earlier step made.",
    fields: [{ key: "entry", label: "Entry id", kind: "template", required: true, placeholder: "{{ steps.book.id }}" }],
    outcomes: ["next"], body: "removed", reversible: true,
  }),

  /* ── outreach ── */
  ...(["text", "call", "email"] as const).map((channel) =>
    variant({
      id: `outreach.${channel}`, base: "outreach", label: channel === "text" ? "Text" : channel === "call" ? "Call" : "Email",
      does: `${channel === "text" ? "Text" : channel === "call" ? "Call" : "Email"} a customer or anyone outside the team, in an agent's voice.`,
      fields: [
        AGENT,
        TO,
        ...(channel === "email" ? [{ key: "subject", label: "Subject", kind: "template" as const }] : []),
        PURPOSE,
        { key: "content", label: "Content", kind: "select", default: "agent", options: [{ value: "agent", label: "The agent writes it" }, { value: "fixed", label: "Fixed wording" }] },
        { key: "wording", label: "Wording", kind: "longtext", showWhen: { key: "content", equals: "fixed" } },
      ],
      outcomes: ["next", "failed"], outputs: [{ name: "conversation", description: "The conversation, for a Wait for a reply" }, { name: "message", description: "What was sent" }],
      body: "conversation", leavesDash: true, modelTask: "outreach", defaultMode: "approve",
      suggestions: ["follow_up_after_outreach", "outreach_on_auto"],
    }),
  ),

  /* ── notify ── */
  variant({
    id: "notify.team", base: "notify", label: "Notify the team", does: "Tell teammates in Dash.",
    fields: [{ key: "title", label: "Title", kind: "template", required: true, ask: "What should the team be told?" }, { key: "text", label: "Details", kind: "longtext" }, { key: "to", label: "Who", kind: "text", placeholder: "everyone", default: "everyone" }],
    outcomes: ["next"], body: "notice", reversible: true,
  }),

  /* ── look up ── */
  variant({
    id: "lookup.records", base: "lookup", label: "Look up records", does: "Read records into the case.",
    fields: [
      { ...CONNECTION, required: true },
      { ...ENTITY, required: false, help: "Or name an endpoint below." },
      { key: "op", label: "Endpoint", kind: "text", placeholder: "listWorkOrders", help: "An endpoint of the connection to read, instead of the record type's list." },
      { key: "params", label: "Parameters", kind: "values", help: "What the endpoint is asked: status, unit, a date." },
      { key: "filter", label: "Only where", kind: "expression" },
      { key: "limit", label: "At most", kind: "number", default: 50 },
    ],
    outcomes: ["next", "incomplete", "failed"],
    outputs: [
      { name: "rows", description: "The records found" },
      { name: "count", description: "How many" },
      { name: "first", description: "The first record" },
      { name: "complete", description: "Whether every record was reached: when not, none found does not mean there are none" },
    ],
    body: "notice",
  }),

  /* ── ask a person ── */
  variant({
    id: "ask.approve", base: "ask", label: "Approve or decline", does: "Ask a teammate to approve or decline before going on.",
    fields: [{ key: "question", label: "Question", kind: "template", required: true, ask: "What should the teammate decide?" }, { key: "details", label: "Details", kind: "longtext" }, { key: "assignee", label: "Who", kind: "text", placeholder: "anyone who manages workflows" }, TIMEOUT],
    outcomes: ["approved", "declined", "timed_out"], outputs: [{ name: "answer", description: "approved or declined" }, { name: "by", description: "Who answered" }],
    body: "question",
  }),
  variant({
    id: "ask.choose", base: "ask", label: "Pick one", does: "Ask a teammate to pick one of several options.",
    fields: [{ key: "question", label: "Question", kind: "template", required: true, ask: "What should the teammate decide?" }, { key: "options", label: "Options", kind: "choices", required: true, ask: "What are the options?" }, TIMEOUT],
    outcomes: ["timed_out"], outputs: [{ name: "answer", description: "The option picked" }], body: "question",
  }),
  variant({
    id: "ask.answer", base: "ask", label: "Answer a question", does: "Ask a teammate for a short answer: a date, an amount.",
    fields: [{ key: "question", label: "Question", kind: "template", required: true, ask: "What should the teammate answer?" }, TIMEOUT],
    outcomes: ["answered", "timed_out"], outputs: [{ name: "answer", description: "Their answer" }], body: "question",
  }),

  /* ── assign ── */
  variant({
    id: "assign.record", base: "assign", label: "Record owner", does: "Set who owns a record.",
    fields: [CONNECTION, ENTITY, RECORD_ID, { key: "field", label: "Owner field", kind: "text", required: true, placeholder: "assigned_to", ask: "Which field holds the owner?" }, { key: "value", label: "New owner", kind: "template", required: true, ask: "Who should own it?" }],
    outcomes: ["next", "failed"], body: "change", leavesDash: true, reversible: true, permission: "records.update", defaultMode: "approve",
  }),

  /* ── think ── */
  variant({
    id: "think.classify", base: "think", label: "Classify", does: "Put the case into one of a few categories, and go down that category's path.",
    fields: [{ key: "prompt", label: "Instructions", kind: "longtext", required: true, ask: "What should it decide?" }, { key: "categories", label: "Categories", kind: "choices", required: true, ask: "What are the categories?" }],
    outcomes: ["failed"], outputs: [{ name: "category", description: "The category" }, { name: "reason", description: "Why" }],
    body: "decision", modelTask: "think",
  }),
  variant({
    id: "think.extract", base: "think", label: "Extract", does: "Pull named values out of text, like a date from an email.",
    fields: [{ key: "prompt", label: "Instructions", kind: "longtext", required: true }, { key: "from", label: "From", kind: "template", required: true, placeholder: "{{ steps.reply.text }}" }, { key: "fields", label: "Values to pull out", kind: "choices", required: true }],
    outcomes: ["next", "failed"], outputs: [{ name: "values", description: "What it found, by name" }], body: "decision", modelTask: "think",
  }),
  variant({
    id: "think.write", base: "think", label: "Write or summarize", does: "Write text for a later step, or summarize what the case holds.",
    fields: [{ key: "prompt", label: "Instructions", kind: "longtext", required: true }],
    outcomes: ["next", "failed"], outputs: [{ name: "text", description: "What it wrote" }], body: "decision", modelTask: "think",
  }),

  /* ── send to a system ── */
  variant({
    id: "send.webhook", base: "send", label: "Webhook", does: "POST the case's data to an address.",
    fields: [
      { key: "url", label: "Address", kind: "text", required: true, placeholder: "https://hooks.example.com/…", ask: "Which address should it send to?" },
      { key: "body", label: "Body", kind: "values" },
      {
        key: "idempotent", label: "The receiver ignores repeats", kind: "boolean", default: false,
        help: "Only if it honours Idempotency-Key. Then a 5xx answer can be retried; otherwise a person is asked whether it went through.",
      },
    ],
    outcomes: ["next", "failed"], outputs: [{ name: "status", description: "The answer's status" }, { name: "response", description: "What came back" }],
    body: "request", leavesDash: true, defaultMode: "approve", interrupted: "review",
  }),

  /* ── wait ── */
  variant({
    id: "wait.duration", base: "wait", label: "Wait a while", does: "Pause for a set time.",
    fields: [{ key: "duration", label: "How long", kind: "duration", required: true, default: "1d", ask: "How long should it wait?" }],
    outcomes: ["next"], body: "wait",
  }),
  variant({
    id: "wait.until", base: "wait", label: "Wait until", does: "Pause until a date or time, from the case or typed.",
    fields: [{ key: "at", label: "Until", kind: "template", required: true, placeholder: "{{ due_date }}", ask: "Until when should it wait?" }, { key: "offset", label: "Offset", kind: "text", placeholder: "-3d", help: "Before (-) or after the date: -3d, 2h." }],
    outcomes: ["next"], body: "wait",
  }),
  variant({
    id: "wait.for", base: "wait", label: "Wait for an event", does: "Wait for something to happen, up to a time limit; then go one way or the other.",
    fields: [
      {
        key: "event", label: "For", kind: "select", required: true, default: "reply",
        options: [
          { value: "reply", label: "A reply to an Outreach step" },
          { value: "record_change", label: "A record to change" },
          { value: "decision", label: "A teammate's answer" },
          { value: "workflow_done", label: "A workflow it started to finish" },
          { value: "webhook", label: "A call to its webhook" },
        ],
        ask: "What should it wait for?",
      },
      { key: "step", label: "From step", kind: "step", help: "The Outreach, Ask or Run a workflow step it waits on." },
      { key: "condition", label: "Until", kind: "expression", showWhen: { key: "event", equals: "record_change" }, placeholder: 'status == "scheduled"' },
      TIMEOUT,
    ],
    outcomes: ["happened", "timed_out"], outputs: [{ name: "event", description: "What happened" }, { name: "hook", description: "This case's webhook address, for webhook waits" }],
    body: "wait",
  }),

  /* ── branch ── */
  variant({
    id: "branch.if", base: "branch", label: "If", does: "Go one way if a condition holds, the other way if not.",
    fields: [{ key: "condition", label: "If", kind: "expression", required: true, placeholder: "cost >= 500", ask: "What should it check?" }],
    outcomes: ["yes", "no"], body: "decision",
  }),
  variant({
    id: "branch.switch", base: "branch", label: "By value", does: "One path per value, and one for anything else.",
    fields: [{ key: "value", label: "Value", kind: "template", required: true, placeholder: "{{ priority }}" }, { key: "cases", label: "Values", kind: "choices", required: true }],
    outcomes: ["otherwise"], body: "decision",
  }),

  /* ── run a workflow ── */
  variant({
    id: "run_workflow.start", base: "run_workflow", label: "Run a workflow", does: "Start another workflow with inputs from this case.",
    fields: [{ key: "workflow", label: "Workflow", kind: "workflow", required: true, ask: "Which workflow should it start?" }, { key: "inputs", label: "Inputs", kind: "values" }, { key: "waitForIt", label: "Wait for it to finish", kind: "boolean", default: false }],
    outcomes: ["next", "failed"], outputs: [{ name: "case", description: "The case it started" }, { name: "status", description: "How it ended, when waited for" }], body: "notice",
  }),
  variant({
    id: "run_workflow.each", base: "run_workflow", label: "For each", does: "Start another workflow once for each item of a list, side by side, and wait for them all if asked.",
    fields: [
      { key: "workflow", label: "Workflow", kind: "workflow", required: true, ask: "Which workflow should run for each item?" },
      { key: "items", label: "Items", kind: "template", required: true, placeholder: "{{ steps.find.rows }}", ask: "Which list should it go through?" },
      { key: "as", label: "Each item is the input", kind: "text", default: "item", help: "The input of that workflow that gets the item." },
      { key: "inputs", label: "Other inputs", kind: "values" },
      { key: "waitForAll", label: "Wait for them all", kind: "boolean", default: true },
      { key: "max", label: "At most", kind: "number", default: 25 },
    ],
    outcomes: ["next", "failed"], outputs: [{ name: "cases", description: "The cases it started" }, { name: "count", description: "How many" }, { name: "statuses", description: "How each ended, when waited for" }], body: "notice",
  }),
];

const BY_ID = new Map(ACTION_VARIANTS.map((one) => [one.id, one]));

export const actionVariant = (id: string): ActionVariant | undefined => BY_ID.get(id);

export const variantsOf = (base: ActionBase): ActionVariant[] => ACTION_VARIANTS.filter((one) => one.base === base);

/** A step's named ways out, with its settings: a classify step has one per category. */
export const outcomesFor = (variant: ActionVariant, settings: Readonly<Record<string, unknown>>): string[] => {
  const words = (key: string): string[] =>
    Array.isArray(settings[key]) ? (settings[key] as unknown[]).map(String).filter((one) => one.trim() !== "") : [];
  if (variant.id === "think.classify") return [...words("categories"), ...variant.outcomes];
  if (variant.id === "branch.switch") return [...words("cases"), ...variant.outcomes];
  if (variant.id === "ask.choose") return [...words("options"), ...variant.outcomes];
  return [...variant.outcomes];
};

/* ── durations ─────────────────────────────────────────────────────────── */

const UNIT: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "30m", "2h", "3d", "1w", optionally signed: milliseconds, or null when it is not one. */
export const durationMs = (text: unknown): number | null => {
  if (typeof text !== "string") return null;
  const match = /^\s*([+-]?)(\d+(?:\.\d+)?)\s*(m|h|d|w)\s*$/.exec(text);
  if (!match) return null;
  return (match[1] === "-" ? -1 : 1) * Math.round(Number(match[2]) * UNIT[match[3]!]!);
};

/** "2 days", "30 minutes": a duration in words. */
export const describeDuration = (text: unknown): string => {
  const ms = durationMs(text);
  if (ms === null) return String(text ?? "");
  const abs = Math.abs(ms);
  for (const [unit, size] of [["week", UNIT["w"]!], ["day", UNIT["d"]!], ["hour", UNIT["h"]!], ["minute", UNIT["m"]!]] as const) {
    if (abs % size === 0) {
      const n = abs / size;
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return String(text);
};

/* ── checking settings ─────────────────────────────────────────────────── */

const empty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);

/** Whether a field applies, given the other settings (defaults filled in). */
export const fieldVisible = (field: ActionField, settings: Readonly<Record<string, unknown>>): boolean =>
  !field.showWhen || settings[field.showWhen.key] === field.showWhen.equals;

/** A variant's settings with every default filled in. */
export const withDefaults = (variant: ActionVariant, settings: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...settings };
  for (const field of variant.fields) if (out[field.key] === undefined && field.default !== undefined) out[field.key] = field.default;
  return out;
};

/** The settings a step still needs before it can run. */
export const missingFields = (variant: ActionVariant, settings: Readonly<Record<string, unknown>>): ActionField[] => {
  const full = withDefaults(variant, settings);
  return variant.fields.filter((field) => field.required && fieldVisible(field, full) && empty(full[field.key]));
};

/** Whether each setting has the right kind of value. Text problems only; templates and expressions are checked by the workflow. */
export const fieldProblems = (variant: ActionVariant, settings: Readonly<Record<string, unknown>>): Array<{ key: string; message: string }> => {
  const out: Array<{ key: string; message: string }> = [];
  const known = new Set(variant.fields.map((field) => field.key));
  for (const key of Object.keys(settings)) if (!known.has(key)) out.push({ key, message: `"${key}" is not a setting of ${variant.label}.` });
  for (const field of variant.fields) {
    const value = settings[field.key];
    if (value === undefined || value === null) continue;
    const bad = (message: string) => out.push({ key: field.key, message: `${field.label}: ${message}` });
    switch (field.kind) {
      case "duration":
        if (durationMs(value) === null) bad("say how long, like 30m, 2h, 3d or 1w.");
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) bad("a number.");
        break;
      case "boolean":
        if (typeof value !== "boolean") bad("yes or no.");
        break;
      case "values":
        if (typeof value !== "object" || Array.isArray(value) || Object.values(value as object).some((one) => typeof one !== "string")) bad("pairs of a field and a value.");
        break;
      case "choices":
        if (!Array.isArray(value) || value.some((one) => typeof one !== "string")) bad("a list of words.");
        break;
      case "select":
        if (!field.options?.some((option) => option.value === value)) bad(`one of ${field.options?.map((option) => option.value).join(", ")}.`);
        break;
      default:
        if (typeof value !== "string") bad("text.");
    }
  }
  return out;
};

export const actionSettingsSchema = z.record(z.unknown());
