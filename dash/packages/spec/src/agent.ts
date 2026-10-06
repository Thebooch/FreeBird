import { idSchema } from "@freebirdai/connect-spec";
import { z } from "zod";
import { permissionSchema, scopeCapability, scopeSchema, type Permission, type Scope } from "./access.js";

/**
 * An agent: a named AI worker the user sets up.
 *
 * A name, a colour, its instructions, and what it may touch. Its colour labels
 * everything it does later — calendar entries, finished tasks, drafted
 * replies — so it is kept as an index into the eight series hues
 * (`--dash-series-1..8`) rather than a hex: a theme change or a palette
 * re-validation recolours every agent consistently, and each one already reads
 * on both surfaces.
 *
 * Whether a change waits for approval is not a setting here. Each workflow
 * action is set to approval or automatic on its own; an agent's `reach` is the
 * ceiling on what any of its actions may touch.
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

export const agentSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(60),
  /** 1–8: an index into `--dash-series-N`. */
  color: z.number().int().min(1).max(AGENT_COLORS),
  instructions: z.string().max(8000).default(""),
  /** What it may touch. Empty: read nothing, change nothing. */
  reach: z.array(agentReachSchema.refine((one) => (AGENT_PERMISSIONS as readonly string[]).includes(one.permission), {
    message: "An agent may be given access to records only.",
  })).max(200).default([]),
  /** The model task to run under; absent means the workflow task. */
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
  instructions: agentSchema.shape.instructions.optional(),
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

/** Tell apart an unknown connection from a grant beyond the saver's own. */
export interface ReachProblem {
  readonly reach: AgentReach;
  readonly reason: "unknown-connection" | "beyond-you";
  readonly message: string;
}
