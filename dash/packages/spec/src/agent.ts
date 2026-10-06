import { idSchema } from "@freebirdai/connect-spec";
import { z } from "zod";
import { permissionSchema, scopeCapability, scopeSchema, type Permission, type Scope } from "./access.js";

/**
 * An agent: a named AI worker the user sets up.
 *
 * An agent is general. It receives messages — texts, calls, email, the chat —
 * and decides which of its tools to use. A workflow is the other thing: a
 * trigger and a path (`workflow.ts`, plan 2). An agent can start a workflow as
 * one of its tools, and a workflow can hand a conversation to an agent.
 *
 * What an agent is made of:
 * - **name and colour.** The colour labels everything it does later, so it is
 *   kept as an index into the eight series hues (`--dash-series-1..8`) rather
 *   than a hex: a theme change recolours every agent consistently.
 * - **role, instructions and personality.** The three parts of its response
 *   prompt, laid over a base prompt every agent shares (`agent-prompt.ts`).
 *   They shape only the messages it writes to a person; workflow steps never
 *   see them.
 * - **knowledge.** Free text, and context rules: "when someone mentions X,
 *   look in these endpoints". A workspace-wide knowledge base applies to every
 *   agent beside its own.
 * - **tools.** What it may do in a conversation, each `auto`, `approve` or
 *   `deny`.
 * - **reach.** The ceiling on what it may touch, in `access.ts`'s own words,
 *   so the same policy that judges a person judges an agent. A record tool
 *   needs reach to cover it.
 */

/** How many series hues there are to choose from. */
export const AGENT_COLORS = 8;

/**
 * One thing an agent may do, somewhere — written in `access.ts`'s own words so
 * the same policy code that judges a person judges an agent.
 */
export const agentReachSchema = z.object({
  permission: permissionSchema,
  scope: scopeSchema.default({}),
});
export type AgentReach = z.infer<typeof agentReachSchema>;

/**
 * The permissions an agent can be given. Changing the product — boards,
 * connections, members, other agents — is a person's work, never an agent's.
 */
export const AGENT_PERMISSIONS = [
  "records.read",
  "records.create",
  "records.update",
  "records.delete",
  "records.act",
] as const satisfies readonly Permission[];

/* ── tools ─────────────────────────────────────────────────────────────── */

/**
 * What an agent does when a conversation calls for a tool.
 *
 * - `auto`: it uses the tool and tells the person what it did.
 * - `approve`: it does not; it tells the person the team will look into it,
 *   and an approval request goes to the team.
 * - `deny`: the request is understood, and refused. The tool's `denyReply`
 *   says how to answer instead.
 */
export const AGENT_TOOL_MODES = ["auto", "approve", "deny"] as const;
export const agentToolModeSchema = z.enum(AGENT_TOOL_MODES);
export type AgentToolMode = z.infer<typeof agentToolModeSchema>;

/** The kinds of tool an agent can be given, and what each needs. */
export const AGENT_TOOL_KINDS = [
  "look_up_record",
  "create_record",
  "update_record",
  "delete_record",
  "record_action",
  "schedule_appointment",
  "schedule_follow_up",
  "run_workflow",
] as const;
export const agentToolKindSchema = z.enum(AGENT_TOOL_KINDS);
export type AgentToolKind = z.infer<typeof agentToolKindSchema>;

export interface AgentToolKindInfo {
  readonly kind: AgentToolKind;
  readonly label: string;
  /** What the tool does, in the words the reply prompt uses. */
  readonly does: string;
  /** The reach a record tool needs; absent for tools that stay inside Dash. */
  readonly permission?: Permission;
  /** Whether it is scoped to a connection and record type. */
  readonly scoped: boolean;
  /** The mode a new one starts in. Anything that changes an account starts at approve. */
  readonly defaultMode: AgentToolMode;
}

export const AGENT_TOOL_INFO: Readonly<Record<AgentToolKind, AgentToolKindInfo>> = {
  look_up_record: { kind: "look_up_record", label: "Look up records", does: "look up records", permission: "records.read", scoped: true, defaultMode: "auto" },
  create_record: { kind: "create_record", label: "Create a record", does: "create a record", permission: "records.create", scoped: true, defaultMode: "approve" },
  update_record: { kind: "update_record", label: "Update a record", does: "change a record", permission: "records.update", scoped: true, defaultMode: "approve" },
  delete_record: { kind: "delete_record", label: "Delete a record", does: "delete a record", permission: "records.delete", scoped: true, defaultMode: "approve" },
  record_action: { kind: "record_action", label: "Run a record's action", does: "run an action on a record", permission: "records.act", scoped: true, defaultMode: "approve" },
  schedule_appointment: { kind: "schedule_appointment", label: "Schedule an appointment", does: "schedule an appointment", scoped: false, defaultMode: "approve" },
  schedule_follow_up: { kind: "schedule_follow_up", label: "Schedule a follow-up", does: "schedule a follow-up with the person", scoped: false, defaultMode: "auto" },
  run_workflow: { kind: "run_workflow", label: "Run a workflow", does: "start a workflow", scoped: false, defaultMode: "approve" },
};

export const agentToolSchema = z.object({
  id: idSchema,
  kind: agentToolKindSchema,
  /** Inactive tools stay configured but are not offered. */
  enabled: z.boolean().default(true),
  mode: agentToolModeSchema.default("approve"),
  /** Where a record tool applies. Empty: wherever the agent's reach allows. */
  scope: scopeSchema.default({}),
  /** For `run_workflow`: which workflow. */
  workflow: idSchema.optional(),
  /** An optional name the person gives it, e.g. "Book a showing". */
  label: z.string().trim().max(80).optional(),
  /** When to use it, in plain words. */
  whenToUse: z.string().max(1000).default(""),
  /** For `deny`: how to answer instead, in plain words. */
  denyReply: z.string().max(1000).default(""),
});
export type AgentTool = z.infer<typeof agentToolSchema>;

/* ── knowledge ─────────────────────────────────────────────────────────── */

/** One endpoint to read for context: a connection's read op. */
export const contextSourceSchema = z.object({
  connection: idSchema,
  op: idSchema,
});
export type ContextSource = z.infer<typeof contextSourceSchema>;

/**
 * "When someone mentions a property, look in these endpoints."
 *
 * The tool the model calls is always the same one; what changes per rule is
 * what sets it off (`trigger`, in plain words) and where it looks (`sources`).
 * What is found is put into the reply prompt as context.
 */
export const contextRuleSchema = z.object({
  id: idSchema,
  trigger: z.string().trim().min(1).max(300),
  sources: z.array(contextSourceSchema).min(1).max(10),
  enabled: z.boolean().default(true),
});
export type ContextRule = z.infer<typeof contextRuleSchema>;

export const agentKnowledgeSchema = z.object({
  /** Free text: policies, facts, answers to common questions. */
  notes: z.string().max(20000).default(""),
  context: z.array(contextRuleSchema).max(50).default([]),
});
export type AgentKnowledge = z.infer<typeof agentKnowledgeSchema>;

/** The knowledge every agent in the workspace shares, beside its own. */
export const sharedAgentKnowledgeSchema = agentKnowledgeSchema.extend({
  updatedAt: z.string().optional(),
});
export type SharedAgentKnowledge = z.infer<typeof sharedAgentKnowledgeSchema>;

/* ── the agent ─────────────────────────────────────────────────────────── */

export const agentSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(60),
  /** 1–8: an index into `--dash-series-N`. */
  color: z.number().int().min(1).max(AGENT_COLORS),
  /** Who it is: "You are a collections agent for Example Property Management." */
  role: z.string().max(4000).default(""),
  /** Rules the team has learned: "Do not accept Friday as a pay date." */
  instructions: z.string().max(8000).default(""),
  /** Tone across every message: "Firm and brief." */
  personality: z.string().max(2000).default(""),
  knowledge: agentKnowledgeSchema.default({}),
  tools: z.array(agentToolSchema).max(60).default([]),
  /** What it may touch. Empty: read nothing, change nothing. */
  reach: z.array(agentReachSchema.refine((one) => (AGENT_PERMISSIONS as readonly string[]).includes(one.permission), {
    message: "An agent may be given access to records only.",
  })).max(200).default([]),
  /** The model to reply with; absent means the default. */
  model: z.string().min(1).max(120).optional(),
  archived: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentSpec = z.infer<typeof agentSchema>;

/** What a person sends to make or change an agent; the server owns the id and the dates. */
export const agentInputSchema = z.object({
  name: agentSchema.shape.name,
  color: agentSchema.shape.color,
  role: agentSchema.shape.role.optional(),
  instructions: agentSchema.shape.instructions.optional(),
  personality: agentSchema.shape.personality.optional(),
  knowledge: agentKnowledgeSchema.optional(),
  tools: agentSchema.shape.tools.optional(),
  reach: agentSchema.shape.reach.optional(),
  model: agentSchema.shape.model,
});
export type AgentInput = z.infer<typeof agentInputSchema>;

/** The same grant twice says nothing new: keep the first, in order. */
export const dedupeReach = (reach: readonly AgentReach[]): AgentReach[] => {
  const seen = new Set<string>();
  const out: AgentReach[] = [];
  for (const one of reach) {
    const key = scopeCapability(one.permission, one.scope);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(one);
  }
  return out;
};

/**
 * Whether a reach grants a permission everywhere a scope covers: a grant on
 * every connection covers any, one on a connection covers its record types.
 */
export const reachCovers = (reach: readonly AgentReach[], permission: Permission, scope: Scope = {}): boolean =>
  reach.some(
    (one) =>
      one.permission === permission &&
      (one.scope.connection === undefined || one.scope.connection === scope.connection) &&
      (one.scope.entity === undefined || one.scope.entity === scope.entity),
  );

/** The scope as words for a list row: "everything", a connection, or a record type on it. */
export const describeScope = (scope: Scope, names: { connection?: (id: string) => string; entity?: (connection: string, id: string) => string } = {}): string => {
  if (scope.connection && scope.entity) {
    return `${names.entity?.(scope.connection, scope.entity) ?? scope.entity} on ${names.connection?.(scope.connection) ?? scope.connection}`;
  }
  if (scope.connection) return names.connection?.(scope.connection) ?? scope.connection;
  return "everything";
};

const VERB: Readonly<Record<string, string>> = {
  "records.read": "read",
  "records.create": "create",
  "records.update": "update",
  "records.delete": "delete",
  "records.act": "act on",
};

/** One line for a list: "read, update · Properties on Rentvine". */
export const summarizeReach = (reach: readonly AgentReach[], names?: Parameters<typeof describeScope>[1]): string => {
  if (reach.length === 0) return "Touches nothing";
  const bySpot = new Map<string, string[]>();
  for (const one of reach) {
    const where = describeScope(one.scope, names);
    bySpot.set(where, [...(bySpot.get(where) ?? []), VERB[one.permission] ?? one.permission]);
  }
  return [...bySpot].map(([where, verbs]) => `${verbs.join(", ")} · ${where}`).join("; ");
};

/** Something wrong with what an agent would be saved with, and why. */
export interface ReachProblem {
  /** The grant at fault, when it is a grant. */
  readonly reach?: AgentReach;
  /** The tool or context rule at fault, by id. */
  readonly item?: string;
  readonly reason:
    | "unknown-connection"
    | "unknown-endpoint"
    | "beyond-you"
    | "tool-beyond-reach"
    | "context-beyond-reach"
    | "invalid";
  readonly message: string;
}
