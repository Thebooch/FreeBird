import type { ActionContext, ActionDefinition } from "@freebirdai/core";
import {
  MESSAGE_CHANNELS,
  PROPOSE_CHANGES,
  WORKFLOW_EVERY,
  WORKFLOW_STEP_INFO,
  WORKFLOW_STEP_KINDS,
  describeTrigger,
  principalSchema,
  stepMode,
  workflowInputSchema,
  type Principal,
  type WorkflowInput,
  type WorkflowSpec,
  type WorkflowStep,
  type WorkflowTrigger,
} from "@freebirdai/dash-spec";
import { z } from "zod";
import { WorkflowError } from "../workflows/service.js";

/**
 * Setting up workflows from the chat: draft one from a description, or change
 * one. Each mirrors the Workflows section, is confirmed on its card, and goes
 * through the same service as the routes — so a step the person may not set
 * to auto is refused here exactly as it is there.
 *
 * The tool schema is flat (no unions, no records): the trigger and each step
 * are a kind plus the fields that kind uses, mapped onto the real shape and
 * validated by it afterwards.
 */

export interface WorkflowChatOps {
  readonly roster: readonly WorkflowSpec[];
  mayManage(principal: Principal): Promise<boolean>;
  create(principal: Principal, input: WorkflowInput): Promise<WorkflowSpec>;
  update(principal: Principal, id: string, input: WorkflowInput): Promise<WorkflowSpec>;
}

const TRIGGER_KINDS = ["record_created", "record_changed", "schedule", "every", "agent", "manual"] as const;

const triggerFields = {
  trigger: z
    .enum(TRIGGER_KINDS)
    .describe(
      "What starts it: record_created / record_changed (a record appears or changes in an API), schedule (cron), every (an interval), agent (an agent's tool starts it), manual (by hand).",
    ),
  cron: z.string().optional().describe("For schedule: five cron fields, e.g. '0 7 * * 1-5' for weekdays at 7."),
  timezone: z.string().optional().describe("For schedule: an IANA time zone, e.g. America/Chicago. Default UTC."),
  every: z.enum(WORKFLOW_EVERY).optional().describe("For every, record_created and record_changed: how often. Default 15m for API triggers."),
  connection: z.string().optional().describe("For record_created / record_changed: id of a connection from the CONNECTIONS list."),
  record: z.string().optional().describe("For record_created / record_changed: the record type it watches."),
  fields: z.array(z.string()).optional().describe("For record_changed: the fields whose change counts. Leave out for any change."),
  inputs: z
    .array(z.object({ name: z.string(), description: z.string(), required: z.boolean().optional() }))
    .optional()
    .describe("For agent: what the agent must ask the person for. Steps read each as {{ input.<name> }}."),
};

const sourceFields = {
  sourceConnection: z.string().optional().describe("What it reads, for triggers other than record_*: a connection id."),
  sourceRecord: z.string().optional().describe("The record type it reads on that connection."),
  criteria: z.string().optional().describe('Which rows matter, as an expression over one row, e.g. status == "open" && cost >= 500.'),
  once: z.enum(["per-row", "per-run"]).optional().describe("per-row: act on each record once (default). per-run: every match, every run."),
};

const stepSchema = z.object({
  kind: z.enum(WORKFLOW_STEP_KINDS).describe("calendar, propose_change, message (an agent texts/calls/emails), think (a model decides), note."),
  mode: z.enum(["auto", "approve"]).optional().describe("For steps that leave Dash: auto does it in the run; approve (default) waits for a person."),
  when: z.string().optional().describe("Only for rows where this holds, e.g. cost < 500. Leave out for every row."),
  title: z.string().optional().describe("calendar: the entry's title. Templates read the row: 'Inspect {{ unit }}'."),
  at: z.string().optional().describe("calendar: a date, or {{ a date field }}."),
  deadline: z.boolean().optional().describe("calendar: it is a deadline."),
  connection: z.string().optional().describe("propose_change: the connection, when not the one it reads."),
  entity: z.string().optional().describe("propose_change: the record type to change."),
  change: z.enum(PROPOSE_CHANGES).optional().describe("propose_change: update, action or create."),
  action: z.string().optional().describe("propose_change with change=action: which action."),
  recordId: z.string().optional().describe("propose_change: which record, usually {{ id }}."),
  values: z.array(z.object({ field: z.string(), value: z.string() })).optional().describe("propose_change: fields to set; values may be templates."),
  agentId: z.string().optional().describe("message: id of an agent from the AGENTS list."),
  channel: z.enum(MESSAGE_CHANNELS).optional().describe("message: text, call or email."),
  to: z.string().optional().describe("message: the phone or address, usually {{ a field }}."),
  purpose: z.string().optional().describe("message: what the conversation is for; the agent writes the words."),
  prompt: z.string().optional().describe("think: what to decide about the matched rows."),
  text: z.string().optional().describe("note: the note."),
});
type FlatStep = z.infer<typeof stepSchema>;

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).optional().describe("One line on what it does. Agents that can start it see this."),
  enabled: z.boolean().optional().describe("Turn it on now. Default off, so the person can preview it first."),
  ...triggerFields,
  ...sourceFields,
  steps: z.array(stepSchema).max(30).optional(),
});

export const updateWorkflowSchema = createWorkflowSchema.partial().extend({
  workflowId: z.string().min(1).describe("Id of a workflow from the WORKFLOWS list."),
});

type Create = z.infer<typeof createWorkflowSchema>;
type Update = z.infer<typeof updateWorkflowSchema>;

const principalOf = (ctx: ActionContext<unknown>): Principal | null => {
  const extra = (ctx.auth as { extra?: Record<string, unknown> } | null)?.extra;
  const parsed = principalSchema.safeParse(extra?.["principal"]);
  return parsed.success ? parsed.data : null;
};

const triggerOf = (args: Partial<Create>, held?: WorkflowTrigger): WorkflowTrigger => {
  const kind = args.trigger ?? held?.kind ?? "manual";
  const was = held?.kind === kind ? (held as Record<string, unknown>) : {};
  const pick = <T>(given: T | undefined, key: string): T | undefined => given ?? (was[key] as T | undefined);
  switch (kind) {
    case "schedule":
      return { kind, cron: pick(args.cron, "cron") ?? "", timezone: pick(args.timezone, "timezone") ?? "UTC" };
    case "every":
      return { kind, every: pick(args.every, "every") ?? "1h" };
    case "record_created":
    case "record_changed": {
      const fields = pick(args.fields, "fields");
      return {
        kind,
        connection: pick(args.connection, "connection") ?? "",
        record: pick(args.record, "record") ?? "",
        every: pick(args.every, "every") ?? "15m",
        ...(kind === "record_changed" && fields && fields.length > 0 ? { fields } : {}),
      } as WorkflowTrigger;
    }
    case "agent":
      return {
        kind,
        inputs: (args.inputs ?? (was["inputs"] as Array<{ name: string; description: string; required?: boolean }> | undefined) ?? []).map((one) => ({
          name: one.name,
          description: one.description,
          required: one.required ?? true,
        })),
      };
    case "manual":
      return { kind };
  }
};

const stepOf = (flat: FlatStep, index: number): WorkflowStep => {
  /* Steps that stay inside Dash are always done; the rest wait for a person unless told otherwise. */
  const mode = flat.mode ?? (WORKFLOW_STEP_INFO[flat.kind].leavesDash ? "approve" : "auto");
  const base = { id: `${flat.kind.replace(/_/g, "-")}-${index + 1}`, mode, ...(flat.when ? { when: flat.when } : {}) };
  switch (flat.kind) {
    case "calendar":
      return { ...base, kind: "calendar", title: flat.title ?? "", at: flat.at ?? "", allDay: false, deadline: flat.deadline ?? false };
    case "propose_change":
      return {
        ...base,
        kind: "propose_change",
        entity: flat.entity ?? "",
        change: flat.change ?? "update",
        ...(flat.connection ? { connection: flat.connection } : {}),
        ...(flat.action ? { action: flat.action } : {}),
        ...(flat.change !== "create" ? { recordId: flat.recordId ?? "{{ id }}" } : {}),
        values: Object.fromEntries((flat.values ?? []).map((pair) => [pair.field, pair.value])),
      };
    case "message":
      return { ...base, kind: "message", agentId: flat.agentId ?? "", channel: flat.channel ?? "text", to: flat.to ?? "", purpose: flat.purpose ?? "" };
    case "think":
      return { ...base, kind: "think", prompt: flat.prompt ?? "" };
    case "note":
      return { ...base, kind: "note", text: flat.text ?? "" };
  }
};

const inputOf = (args: Partial<Create>, held?: WorkflowSpec): WorkflowInput => {
  const trigger = triggerOf(args, held?.trigger);
  const sourceConnection = args.sourceConnection ?? held?.source?.connection;
  const sourceRecord = args.sourceRecord ?? held?.source?.record;
  const input = {
    name: args.name ?? held?.name ?? "",
    description: args.description ?? held?.description ?? "",
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    trigger,
    ...(sourceConnection && trigger.kind !== "record_created" && trigger.kind !== "record_changed"
      ? { source: sourceRecord ? { connection: sourceConnection, record: sourceRecord } : (held?.source ?? { connection: sourceConnection, record: "" }) }
      : {}),
    ...((args.criteria ?? held?.criteria) ? { criteria: args.criteria ?? held?.criteria } : {}),
    once: args.once ?? held?.once ?? "per-row",
    steps: args.steps ? args.steps.map(stepOf) : (held?.steps ?? []),
  };
  const parsed = workflowInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((one) => `${one.path.join(".")}: ${one.message}`).join("; "));
  return parsed.data;
};

const stepLine = (step: WorkflowStep): string =>
  `${WORKFLOW_STEP_INFO[step.kind].label}${WORKFLOW_STEP_INFO[step.kind].leavesDash ? ` (${stepMode(step) === "auto" ? "auto" : "approve"})` : ""}${step.when ? `, when ${step.when}` : ""}`;

const rowsFor = (input: WorkflowInput) => [
  { label: "Starts", value: describeTrigger(input.trigger) },
  ...(input.source ? [{ label: "Reads", value: `${input.source.record ?? input.source.op ?? ""} on ${input.source.connection}` }] : []),
  ...(input.criteria ? [{ label: "Only rows where", value: input.criteria }] : []),
  ...(input.steps ?? []).map((step, index) => ({ label: `Step ${index + 1}`, value: stepLine(step) })),
  { label: "Turned on", value: input.enabled ? "Yes" : "No — preview it, then turn it on" },
];

const explained = <T>(run: () => Promise<T>): Promise<T> =>
  run().catch((error: unknown) => {
    throw error instanceof WorkflowError ? new Error(error.message) : error;
  });

export const workflowActions = (ops: WorkflowChatOps): ActionDefinition<any, unknown, unknown>[] => {
  const mayManage = async (ctx: ActionContext<unknown>) => {
    const principal = principalOf(ctx);
    if (!principal) return { ok: false as const, reason: "Nobody is signed in.", status: 401 };
    return (await ops.mayManage(principal)) || { ok: false as const, reason: "Your role here does not allow managing workflows.", status: 403 };
  };
  const known = (id: string) => ops.roster.find((one) => one.id === id);

  const create: ActionDefinition<Create, unknown, unknown> = {
    id: "create_workflow",
    description:
      "Create a workflow from what the person describes: a trigger (a record appearing or changing in an API, a schedule, an interval, an agent being asked, or by hand), " +
      "optionally what it reads and which rows matter, and its steps. Each step that leaves Dash is auto or approve; use `when` for paths " +
      "(e.g. auto when cost < 500, approve when cost >= 500). Default steps to approve and leave it off so the person can preview it. " +
      "Shown to the person for confirmation first.",
    schema: createWorkflowSchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: (_args, ctx) => mayManage(ctx),
    preview: (args) => {
      try {
        const input = inputOf(args);
        return { title: `Create workflow "${args.name}"`, summary: args.description ?? "", rows: rowsFor(input) };
      } catch (error) {
        return { title: `Create workflow "${args.name}"`, summary: error instanceof Error ? error.message : String(error), rows: [] };
      }
    },
    handler: async (args, ctx) => {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Nobody is signed in.");
      const made = await explained(() => ops.create(principal, inputOf(args)));
      return { created: true, workflowId: made.id, name: made.name, enabled: made.enabled, starts: describeTrigger(made.trigger) };
    },
  };

  const update: ActionDefinition<Update, unknown, unknown> = {
    id: "update_workflow",
    description:
      "Change a workflow: rename it, change its trigger, what it reads or its criteria, replace its steps, or turn it on or off. " +
      "Send only what changes; `steps` replaces the whole list.",
    schema: updateWorkflowSchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: async (args, ctx) => {
      const allowed = await mayManage(ctx);
      if (allowed !== true) return allowed;
      return known(args.workflowId) ? true : { ok: false as const, reason: `"${args.workflowId}" is not one of your workflows.`, status: 404 };
    },
    readCurrent: (args) => {
      const held = known(args.workflowId);
      return held ? { name: held.name, enabled: held.enabled, starts: describeTrigger(held.trigger), steps: held.steps.map(stepLine) } : null;
    },
    preview: (args) => {
      const held = known(args.workflowId);
      try {
        return { title: `Change workflow "${held?.name ?? args.workflowId}"`, summary: "Only what is listed changes.", rows: rowsFor(inputOf(args, held)) };
      } catch (error) {
        return { title: `Change workflow "${held?.name ?? args.workflowId}"`, summary: error instanceof Error ? error.message : String(error), rows: [] };
      }
    },
    handler: async (args, ctx) => {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Nobody is signed in.");
      const held = known(args.workflowId);
      if (!held) throw new Error(`"${args.workflowId}" is not one of your workflows.`);
      const next = await explained(() => ops.update(principal, held.id, inputOf(args, held)));
      return { updated: true, workflowId: next.id, name: next.name, enabled: next.enabled, starts: describeTrigger(next.trigger) };
    },
  };

  return [create, update];
};

/** What the assistant is told about the workflows that exist, so it can name one. */
export const workflowKnowledge = (ops: WorkflowChatOps): Array<{ text: string }> => [
  {
    text:
      ops.roster.length === 0
        ? "WORKFLOWS — none yet. `create_workflow` drafts one from a description: a trigger, what it reads, which rows matter, and steps each set to auto or approve."
        : `WORKFLOWS — ${ops.roster.length}: ` +
          ops.roster
            .map((one) => `"${one.name}" (id: ${one.id}, ${one.enabled ? (one.parked ? "paused" : "on") : "off"}, ${describeTrigger(one.trigger)}, ${one.steps.length} steps)`)
            .join("; ") +
          ". `create_workflow` and `update_workflow` manage them. Workflows never use an agent's reply prompt.",
  },
];
