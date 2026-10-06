import type { ActionContext, ActionDefinition } from "@freebirdai/core";
import {
  ACTION_VARIANTS,
  WORKFLOW_EVERY,
  actionVariant,
  chainEdges,
  describeTrigger,
  principalSchema,
  workflowInputSchema,
  workflowSchema,
  type Principal,
  type WorkflowInput,
  type WorkflowNode,
  type WorkflowSpec,
  type WorkflowTemplate,
  type WorkflowTrigger,
} from "@freebirdai/dash-spec";
import { z } from "zod";
import type { DraftExplanation } from "../workflows/draft.js";
import { WorkflowError } from "../workflows/service.js";
import { TemplateError } from "../workflows/templates.js";

/**
 * Building workflows from the chat, in three moves:
 *
 * 1. **Draft** (`draft_workflow`): nothing is saved. The server checks the
 *    draft against the action catalog and returns the one-sentence summary,
 *    what was picked for each step, and up to three questions — what is
 *    missing, and what the catalog suggests ("Add a follow-up? How long
 *    should it wait?") — each with a default.
 * 2. **Explain and ask**: the assistant tells the person what it picked and
 *    asks those questions.
 * 3. **Confirm** (`create_workflow`): one plain sentence on the card. A
 *    complete workflow is saved **on, in trial** (every outside step asks for
 *    its first five cases); one still missing something is saved off.
 *
 * Templates can be saved and used the same way. The tool schema is flat (no
 * unions, no records): steps and their settings are lists, mapped onto the
 * real shape and checked by it.
 */

export interface WorkflowChatOps {
  readonly roster: readonly WorkflowSpec[];
  readonly templates: readonly WorkflowTemplate[];
  mayManage(principal: Principal): Promise<boolean>;
  explain(principal: Principal, workflow: WorkflowSpec): Promise<DraftExplanation>;
  create(principal: Principal, input: WorkflowInput): Promise<WorkflowSpec>;
  update(principal: Principal, id: string, input: WorkflowInput): Promise<WorkflowSpec>;
  saveTemplate(input: { workflow: string; kind: "step" | "path" | "workflow"; name: string; steps?: string[]; description?: string }): Promise<WorkflowTemplate>;
  fromTemplate(principal: Principal, id: string, values: Record<string, string>, name?: string): Promise<WorkflowSpec>;
}

/** New workflows from the chat start in trial for this many cases. */
export const CHAT_TRIAL_CASES = 5;

const TRIGGER_KINDS = ["record_created", "record_changed", "schedule", "every", "agent", "manual"] as const;
const VARIANT_IDS = ACTION_VARIANTS.filter((one) => one.available).map((one) => one.id) as [string, ...string[]];

const triggerFields = {
  trigger: z.enum(TRIGGER_KINDS).describe("What starts it: record_created / record_changed (an API's records), schedule (cron), every (an interval), agent (an agent's tool), manual (by hand)."),
  cron: z.string().optional().describe("For schedule: five cron fields, e.g. '0 7 * * 1-5'."),
  timezone: z.string().optional().describe("For schedule: an IANA time zone. Default UTC."),
  every: z.enum(WORKFLOW_EVERY).optional().describe("For every and record_*: how often. Default 15m for API triggers."),
  connection: z.string().optional().describe("For record_*: a connection id from CONNECTIONS."),
  record: z.string().optional().describe("For record_*: the record type it watches."),
  fields: z.array(z.string()).optional().describe("For record_changed: the fields whose change counts."),
  inputs: z.array(z.object({ name: z.string(), description: z.string(), required: z.boolean().optional() })).optional().describe("For agent: what the agent asks the person for."),
};

const stepSchema = z.object({
  id: z.string().describe("A short id for the step, letters and dashes: 'text-tenant'. Arrows use it."),
  action: z.enum(VARIANT_IDS).describe("A variant id from the ACTION CATALOG, e.g. outreach.text, wait.for, update.record."),
  name: z.string().optional().describe("What the step is called, if not its variant's label."),
  mode: z.enum(["auto", "approve"]).optional().describe("For steps that leave Dash: auto, or approve (default; waits for a person)."),
  when: z.string().optional().describe("Only when this holds, e.g. cost < 500."),
  settings: z
    .array(
      z.object({
        key: z.string().describe("A setting key from the catalog, e.g. agentId, to, purpose, timeout, condition."),
        value: z.string().optional().describe("Its value as text. Templates read the record: '{{ tenant.phone }}'. Durations: 30m, 2h, 3d."),
        list: z.array(z.string()).optional().describe("For a list setting: categories, options, cases, fields."),
        pairs: z.array(z.object({ field: z.string(), value: z.string() })).optional().describe("For a values setting: fields to set and their values."),
      }),
    )
    .optional(),
});

const arrowSchema = z.object({
  from: z.string().describe("A step id, or 'trigger' for the first arrow."),
  outcome: z.string().optional().describe("Which way out of the step: next (default), happened, timed_out, yes, no, approved, declined, a category…"),
  to: z.string().describe("A step id. May point back to an earlier step for a loop."),
});

const workflowFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).optional().describe("One line on what it does."),
  ...triggerFields,
  sourceConnection: z.string().optional().describe("What it reads, for triggers other than record_*: a connection id."),
  sourceRecord: z.string().optional().describe("The record type it reads."),
  criteria: z.string().optional().describe('Which records matter, e.g. status == "open".'),
  guardrails: z.string().optional().describe("Things no step may do, and when to stop and ask. Read by Think steps and Outreach agents."),
  steps: z.array(stepSchema).max(60).optional(),
  arrows: z.array(arrowSchema).max(200).optional().describe("Arrows between steps. Leave out for a plain list: trigger → first step → second → …"),
};

export const draftWorkflowSchema = z.object({ workflowId: z.string().optional().describe("A workflow from WORKFLOWS, when changing one."), ...workflowFields });
export const createWorkflowSchema = z.object(workflowFields);
export const updateWorkflowSchema = z.object(workflowFields).partial().extend({
  workflowId: z.string().min(1).describe("Id of a workflow from WORKFLOWS."),
  enabled: z.boolean().optional().describe("Turn it on or off."),
});
export const saveTemplateSchema = z.object({
  workflowId: z.string().min(1),
  kind: z.enum(["step", "path", "workflow"]),
  name: z.string().trim().min(1).max(80),
  steps: z.array(z.string()).optional().describe("For a step or a path: which steps, the first one first."),
  description: z.string().optional(),
});
export const useTemplateSchema = z.object({
  templateId: z.string().min(1).describe("A workflow template from TEMPLATES."),
  name: z.string().optional(),
  blanks: z.array(z.object({ name: z.string(), value: z.string() })).optional().describe("A value for each of the template's blanks."),
});

type Fields = Partial<z.infer<typeof createWorkflowSchema>>;

const principalOf = (ctx: ActionContext<unknown>): Principal | null => {
  const extra = (ctx.auth as { extra?: Record<string, unknown> } | null)?.extra;
  const parsed = principalSchema.safeParse(extra?.["principal"]);
  return parsed.success ? parsed.data : null;
};

const triggerOf = (args: Fields, held?: WorkflowTrigger): WorkflowTrigger => {
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
      return { kind, connection: pick(args.connection, "connection") ?? "", record: pick(args.record, "record") ?? "", every: pick(args.every, "every") ?? "15m", ...(kind === "record_changed" && fields?.length ? { fields } : {}) } as WorkflowTrigger;
    }
    case "agent":
      return { kind, inputs: (args.inputs ?? (was["inputs"] as Array<{ name: string; description: string; required?: boolean }> | undefined) ?? []).map((one) => ({ name: one.name, description: one.description, required: one.required ?? true })) };
    case "manual":
      return { kind };
  }
};

/** A flat step from the chat as a node: each setting read the way its field kind says. */
const nodeOf = (step: z.infer<typeof stepSchema>, index: number): WorkflowNode => {
  const variant = actionVariant(step.action);
  const settings: Record<string, unknown> = {};
  for (const one of step.settings ?? []) {
    const field = variant?.fields.find((each) => each.key === one.key);
    const kind = field?.kind;
    if (kind === "values") settings[one.key] = Object.fromEntries((one.pairs ?? []).map((pair) => [pair.field, pair.value]));
    else if (kind === "choices") settings[one.key] = one.list ?? (one.value ?? "").split(",").map((word) => word.trim()).filter(Boolean);
    else if (kind === "number") settings[one.key] = Number(one.value);
    else if (kind === "boolean") settings[one.key] = one.value === "true" || one.value === "yes";
    else settings[one.key] = one.value ?? "";
  }
  const id = step.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 64) || `step-${index + 1}`;
  return {
    id,
    action: step.action,
    ...(step.name ? { name: step.name } : {}),
    settings,
    mode: step.mode ?? (variant?.defaultMode ?? "approve"),
    ...(step.when ? { when: step.when } : {}),
    onFailure: "stop",
    reversible: true,
    position: { x: 0, y: index * 140 },
  };
};

const inputOf = (args: Fields, held?: WorkflowSpec): WorkflowInput => {
  const trigger = triggerOf(args, held?.trigger);
  const nodes = args.steps ? args.steps.map(nodeOf) : (held?.nodes ?? []);
  const edges = args.arrows
    ? args.arrows.map((arrow, index) => ({ id: `a${index + 1}-${arrow.from}-${arrow.to}`.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, "-"), from: arrow.from, outcome: arrow.outcome ?? "next", to: arrow.to }))
    : args.steps
      ? chainEdges(nodes)
      : (held?.edges ?? []);
  const sourceConnection = args.sourceConnection ?? held?.source?.connection;
  const sourceRecord = args.sourceRecord ?? held?.source?.record;
  const input = {
    name: args.name ?? held?.name ?? "",
    description: args.description ?? held?.description ?? "",
    trigger,
    ...(sourceConnection && sourceRecord && trigger.kind !== "record_created" && trigger.kind !== "record_changed" ? { source: { connection: sourceConnection, record: sourceRecord } } : {}),
    ...((args.criteria ?? held?.criteria) ? { criteria: args.criteria ?? held?.criteria } : {}),
    guardrails: args.guardrails ?? held?.guardrails ?? "",
    nodes,
    edges,
  };
  const parsed = workflowInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((one) => `${one.path.join(".")}: ${one.message}`).join("; "));
  return parsed.data;
};

const asSpec = (input: WorkflowInput, held?: WorkflowSpec): WorkflowSpec =>
  workflowSchema.parse({ ...held, ...input, id: held?.id ?? "draft", createdAt: held?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });

const explained = <T>(run: () => Promise<T>): Promise<T> =>
  run().catch((error: unknown) => {
    throw error instanceof WorkflowError || error instanceof TemplateError ? new Error(error.message) : error;
  });

export const workflowActions = (ops: WorkflowChatOps): ActionDefinition<any, unknown, unknown>[] => {
  const mayManage = async (ctx: ActionContext<unknown>) => {
    const principal = principalOf(ctx);
    if (!principal) return { ok: false as const, reason: "Nobody is signed in.", status: 401 };
    return (await ops.mayManage(principal)) || { ok: false as const, reason: "Your role here does not allow managing workflows.", status: 403 };
  };
  const known = (id: string) => ops.roster.find((one) => one.id === id);
  const sentenceCache = new Map<string, string>();

  const draft: ActionDefinition<z.infer<typeof draftWorkflowSchema>, unknown, unknown> = {
    id: "draft_workflow",
    description:
      "Check a workflow before making or changing it. Nothing is saved. Returns the workflow in one sentence, what was picked for each step, " +
      "and up to three questions (what is missing, and what the catalog suggests) each with a default. Always call this first, then tell the person " +
      "what you picked for each step and ask the questions in plain words, one short line each with its default, before calling create_workflow or update_workflow.",
    schema: draftWorkflowSchema,
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: (_args, ctx) => mayManage(ctx),
    handler: async (args, ctx) => {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Nobody is signed in.");
      const held = args.workflowId ? known(args.workflowId) : undefined;
      const input = inputOf(args, held);
      const explanation = await explained(() => ops.explain(principal, asSpec(input, held)));
      sentenceCache.set(JSON.stringify(input), explanation.sentence);
      return explanation;
    },
  };

  const rowsFor = (input: WorkflowInput) => [
    { label: "Starts", value: describeTrigger(input.trigger) },
    ...(input.nodes ?? []).map((node, index) => {
      const variant = actionVariant(node.action);
      return { label: `Step ${index + 1}`, value: `${node.name ?? variant?.label ?? node.action}${variant?.leavesDash ? ` (${node.mode === "auto" ? "auto" : "approve"})` : ""}${node.when ? `, when ${node.when}` : ""}` };
    }),
    { label: "Turned on", value: `In trial: every outside step asks for approval for its first ${CHAT_TRIAL_CASES} cases` },
  ];

  const create: ActionDefinition<z.infer<typeof createWorkflowSchema>, unknown, unknown> = {
    id: "create_workflow",
    description:
      "Save a workflow the person has confirmed, after draft_workflow and their answers. It is turned on in trial (every outside step asks " +
      `for approval for its first ${CHAT_TRIAL_CASES} cases) when nothing is missing, and saved off when something still is. Shown for confirmation as one plain sentence.`,
    schema: createWorkflowSchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: (_args, ctx) => mayManage(ctx),
    preview: (args) => {
      try {
        const input = inputOf(args);
        return { title: `Create "${args.name}"`, summary: sentenceCache.get(JSON.stringify(input)) ?? args.description ?? "", rows: rowsFor(input) };
      } catch (error) {
        return { title: `Create "${args.name}"`, summary: error instanceof Error ? error.message : String(error), rows: [] };
      }
    },
    handler: async (args, ctx) => {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Nobody is signed in.");
      const input = inputOf(args);
      const check = await explained(() => ops.explain(principal, asSpec(input)));
      const complete = check.questions.every((one) => one.kind !== "missing") && check.problems.length === 0;
      const made = await explained(() => ops.create(principal, { ...input, enabled: complete, trial: CHAT_TRIAL_CASES }));
      return {
        created: true,
        workflowId: made.id,
        name: made.name,
        sentence: check.sentence,
        enabled: made.enabled,
        trial: made.trial,
        ...(complete ? {} : { stillMissing: check.questions.filter((one) => one.kind === "missing").map((one) => one.question) }),
      };
    },
  };

  const update: ActionDefinition<z.infer<typeof updateWorkflowSchema>, unknown, unknown> = {
    id: "update_workflow",
    description:
      "Change a workflow: its trigger, what it reads, its criteria, its guardrails, its steps and arrows (each replaces the old list whole), or turn it on or off. " +
      "Call draft_workflow with the workflowId first and ask its questions.",
    schema: updateWorkflowSchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: async (args, ctx) => {
      const allowed = await mayManage(ctx);
      if (allowed !== true) return allowed;
      return known(args.workflowId) ? true : { ok: false as const, reason: `"${args.workflowId}" is not one of your workflows.`, status: 404 };
    },
    preview: (args) => {
      const held = known(args.workflowId);
      try {
        return { title: `Change "${held?.name ?? args.workflowId}"`, summary: "Only what is listed changes.", rows: rowsFor(inputOf(args, held)).slice(0, -1) };
      } catch (error) {
        return { title: `Change "${held?.name ?? args.workflowId}"`, summary: error instanceof Error ? error.message : String(error), rows: [] };
      }
    },
    handler: async (args, ctx) => {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Nobody is signed in.");
      const held = known(args.workflowId);
      if (!held) throw new Error(`"${args.workflowId}" is not one of your workflows.`);
      const next = await explained(() => ops.update(principal, held.id, { ...inputOf(args, held), ...(args.enabled !== undefined ? { enabled: args.enabled } : {}) }));
      return { updated: true, workflowId: next.id, enabled: next.enabled, starts: describeTrigger(next.trigger) };
    },
  };

  const saveTemplate: ActionDefinition<z.infer<typeof saveTemplateSchema>, unknown, unknown> = {
    id: "save_workflow_template",
    description: "Save one step, several steps (a path, the first one first), or a whole workflow as a template for reuse. Settings with {{ blank.<name> }} are asked for each time it is used.",
    schema: saveTemplateSchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: (_args, ctx) => mayManage(ctx),
    preview: (args) => ({ title: `Save template "${args.name}"`, summary: `${args.kind === "workflow" ? "The whole workflow" : `${args.steps?.length ?? 0} step(s)`} from ${known(args.workflowId)?.name ?? args.workflowId}.`, rows: [] }),
    handler: async (args) => {
      const saved = await explained(() =>
        ops.saveTemplate({ workflow: args.workflowId, kind: args.kind, name: args.name, ...(args.steps ? { steps: args.steps } : {}), ...(args.description ? { description: args.description } : {}) }),
      );
      return { saved: true, templateId: saved.id, version: saved.version, blanks: saved.blanks.map((one) => one.name) };
    },
  };

  const useTemplate: ActionDefinition<z.infer<typeof useTemplateSchema>, unknown, unknown> = {
    id: "use_workflow_template",
    description: "Make a new workflow from a workflow template in TEMPLATES, filling its blanks. Saved off, for the person to look over and turn on.",
    schema: useTemplateSchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: (_args, ctx) => mayManage(ctx),
    preview: (args) => ({ title: `New workflow from "${ops.templates.find((one) => one.id === args.templateId)?.name ?? args.templateId}"`, summary: args.name ?? "", rows: (args.blanks ?? []).map((one) => ({ label: one.name, value: one.value })) }),
    handler: async (args, ctx) => {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Nobody is signed in.");
      const made = await explained(() => ops.fromTemplate(principal, args.templateId, Object.fromEntries((args.blanks ?? []).map((one) => [one.name, one.value])), args.name));
      return { created: true, workflowId: made.id, name: made.name, enabled: made.enabled };
    },
  };

  return [draft, create, update, saveTemplate, useTemplate];
};

/** What the assistant is told: the workflows, the templates, and the action catalog it picks from. */
export const workflowKnowledge = (ops: WorkflowChatOps): Array<{ text: string }> => [
  {
    text:
      (ops.roster.length === 0
        ? "WORKFLOWS: none yet."
        : `WORKFLOWS: ${ops.roster
            .map((one) => `"${one.name}" (id: ${one.id}, ${one.enabled ? (one.parked ? "paused" : one.trial > 0 ? "on, in trial" : "on") : "off"}, ${describeTrigger(one.trigger)}, ${one.nodes.length} steps)`)
            .join("; ")}.`) +
      (ops.templates.length > 0 ? ` TEMPLATES: ${ops.templates.map((one) => `"${one.name}" (id: ${one.id}, ${one.kind}, v${one.version}${one.blanks.length ? `, blanks: ${one.blanks.map((blank) => blank.name).join(", ")}` : ""})`).join("; ")}.` : "") +
      " To make or change a workflow: draft_workflow first, tell the person what you picked for each step, ask its questions, then create_workflow or update_workflow. Workflows never use an agent's reply prompt; Outreach steps write in the chosen agent's voice.",
  },
  {
    text:
      "ACTION CATALOG (step action ids, what each does, and its settings; * = required): " +
      ACTION_VARIANTS.filter((one) => one.available)
        .map((one) => `${one.id}: ${one.does} [${one.fields.map((field) => `${field.key}${field.required ? "*" : ""}`).join(", ")}] outcomes: ${one.outcomes.join("/")}${["think.classify", "branch.switch", "ask.choose"].includes(one.id) ? " + one per category/value/option" : ""}`)
        .join(" | "),
  },
];
