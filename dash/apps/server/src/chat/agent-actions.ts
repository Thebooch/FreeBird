import type { ActionContext, ActionDefinition } from "@freebirdai/core";
import {
  AGENT_COLORS,
  AGENT_PERMISSIONS,
  principalSchema,
  summarizeReach,
  type AgentInput,
  type AgentSpec,
  type Principal,
} from "@freebirdai/dash-spec";
import { z } from "zod";
import { AgentError } from "../agents/service.js";

/**
 * Setting up agents from the chat: make one, change one, retire one.
 *
 * Every control in the app is also something the chat can do ("a thing you can
 * click and cannot ask for is a thing the chat will be blamed for not doing"),
 * so each of these mirrors a button on the Agents section. Each asks the
 * policy for `agents.manage` before anything else, and the service refuses a
 * reach the person does not hold themselves — the same two checks the routes
 * make.
 */

export interface AgentChatOps {
  /** Every agent that is not archived, for the assistant to name. */
  readonly roster: readonly AgentSpec[];
  /** Whether this principal may manage agents at all. */
  mayManage(principal: Principal): Promise<boolean>;
  create(principal: Principal, input: AgentInput): Promise<AgentSpec>;
  update(principal: Principal, id: string, input: AgentInput): Promise<AgentSpec>;
  archive(id: string): Promise<AgentSpec>;
}

const reachItemSchema = z.object({
  permission: z.enum(AGENT_PERMISSIONS).describe("What it may do: read, create, update, delete or act on records."),
  connection: z.string().min(1).optional().describe("Id of a connection from the CONNECTIONS list. Leave out for every connection."),
  entity: z.string().min(1).optional().describe("A record type on that connection. Leave out for every record type."),
});

const colorSchema = z
  .number()
  .int()
  .min(1)
  .max(AGENT_COLORS)
  .describe(`Its colour, 1 to ${AGENT_COLORS}: which of the eight palette swatches it wears everywhere it appears.`);

const reachSchema = z
  .array(reachItemSchema)
  .max(100)
  .describe("The COMPLETE list of what it may touch; an agent with none reads nothing and changes nothing.");

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(60).describe("What the agent is called."),
  color: colorSchema.optional(),
  instructions: z.string().max(8000).optional().describe("How it should work, in plain words."),
  reach: reachSchema.optional(),
});

export const updateAgentSchema = z.object({
  agentId: z.string().min(1).describe("Id of an agent from the AGENTS list."),
  name: z.string().trim().min(1).max(60).optional(),
  color: colorSchema.optional(),
  instructions: z.string().max(8000).optional().describe("The agent's whole new instructions, replacing the old."),
  reach: reachSchema.optional(),
});

export const archiveAgentSchema = z.object({
  agentId: z.string().min(1).describe("Id of an agent from the AGENTS list."),
});

type Create = z.infer<typeof createAgentSchema>;
type Update = z.infer<typeof updateAgentSchema>;
type Archive = z.infer<typeof archiveAgentSchema>;

const principalOf = (ctx: ActionContext<unknown>): Principal | null => {
  const extra = (ctx.auth as { extra?: Record<string, unknown> } | null)?.extra;
  const parsed = principalSchema.safeParse(extra?.["principal"]);
  return parsed.success ? parsed.data : null;
};

const reachOf = (items: Create["reach"]): AgentInput["reach"] =>
  items?.map((one) => ({
    permission: one.permission,
    scope: { ...(one.connection ? { connection: one.connection } : {}), ...(one.entity ? { entity: one.entity } : {}) },
  }));

/** The words a card or a reply uses for an agent. */
const summaryOf = (agent: AgentSpec) => ({
  agentId: agent.id,
  name: agent.name,
  color: agent.color,
  reach: summarizeReach(agent.reach),
});

/** A turn's failure in the person's words, rather than as a stack. */
const explained = <T>(run: () => Promise<T>): Promise<T> =>
  run().catch((error: unknown) => {
    throw error instanceof AgentError ? new Error(error.message) : error;
  });

export const agentActions = (ops: AgentChatOps): ActionDefinition<any, unknown, unknown>[] => {
  const mayManage = async (ctx: ActionContext<unknown>) => {
    const principal = principalOf(ctx);
    if (!principal) return { ok: false as const, reason: "Nobody is signed in.", status: 401 };
    return (
      (await ops.mayManage(principal)) || {
        ok: false as const,
        reason: "Your role here does not allow managing agents.",
        status: 403,
      }
    );
  };
  const known = (id: string) => ops.roster.find((one) => one.id === id);
  const unknown = (id: string) => ({ ok: false as const, reason: `"${id}" is not one of your agents.`, status: 404 });

  const create: ActionDefinition<Create, unknown, unknown> = {
    id: "create_agent",
    description:
      "Create an agent: a named AI worker with a colour, instructions, and a reach (what it may read or change). " +
      "Shown to the user for confirmation first. An agent given no reach touches nothing.",
    schema: createAgentSchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: (_args, ctx) => mayManage(ctx),
    preview: (args) => ({
      title: `Create agent "${args.name}"`,
      summary: args.instructions?.slice(0, 160) ?? "No instructions yet.",
      rows: [{ label: "May touch", value: summarizeReach(reachOf(args.reach) ?? []) }],
    }),
    handler: async (args, ctx) => {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Nobody is signed in.");
      const made = await explained(() =>
        ops.create(principal, {
          name: args.name,
          // Spread across the palette by how many exist, so a new agent is rarely a twin of an old one.
          color: args.color ?? (ops.roster.length % AGENT_COLORS) + 1,
          ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
          ...(args.reach ? { reach: reachOf(args.reach) } : {}),
        }),
      );
      return { created: true, ...summaryOf(made) };
    },
  };

  const update: ActionDefinition<Update, unknown, unknown> = {
    id: "update_agent",
    description:
      "Change an agent: rename it, recolour it, rewrite its instructions or replace its reach. " +
      "Send only what changes; `reach` and `instructions` replace the old value whole.",
    schema: updateAgentSchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: async (args, ctx) => {
      const allowed = await mayManage(ctx);
      if (allowed !== true) return allowed;
      return known(args.agentId) ? true : unknown(args.agentId);
    },
    readCurrent: (args) => {
      const held = known(args.agentId);
      return held ? { name: held.name, color: held.color, reach: summarizeReach(held.reach) } : null;
    },
    preview: (args) => {
      const held = known(args.agentId);
      return {
        title: `Change agent "${held?.name ?? args.agentId}"`,
        summary: "Only what is listed changes.",
        rows: [
          ...(args.name !== undefined ? [{ label: "Name", value: `${held?.name ?? "—"} → ${args.name}` }] : []),
          ...(args.color !== undefined ? [{ label: "Colour", value: `${held?.color ?? "—"} → ${args.color}` }] : []),
          ...(args.instructions !== undefined ? [{ label: "Instructions", value: "rewritten" }] : []),
          ...(args.reach !== undefined
            ? [{ label: "May touch", value: `${held ? summarizeReach(held.reach) : "—"} → ${summarizeReach(reachOf(args.reach) ?? [])}` }]
            : []),
        ],
      };
    },
    handler: async (args, ctx) => {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Nobody is signed in.");
      const held = known(args.agentId);
      if (!held) throw new Error(`"${args.agentId}" is not one of your agents.`);
      const next = await explained(() =>
        ops.update(principal, args.agentId, {
          name: args.name ?? held.name,
          color: args.color ?? held.color,
          instructions: args.instructions ?? held.instructions,
          reach: args.reach ? reachOf(args.reach) : held.reach,
          ...(held.model ? { model: held.model } : {}),
        }),
      );
      return { updated: true, ...summaryOf(next) };
    },
  };

  const archive: ActionDefinition<Archive, unknown, unknown> = {
    id: "archive_agent",
    description: "Archive an agent so it can no longer be used. It is kept, and can be restored from the Agents section.",
    schema: archiveAgentSchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: async (args, ctx) => {
      const allowed = await mayManage(ctx);
      if (allowed !== true) return allowed;
      return known(args.agentId) ? true : unknown(args.agentId);
    },
    readCurrent: (args) => {
      const held = known(args.agentId);
      return held ? { name: held.name } : null;
    },
    preview: (args) => ({
      title: `Archive agent "${known(args.agentId)?.name ?? args.agentId}"`,
      summary: "It stops being offered, and can be restored later.",
      rows: [],
    }),
    handler: async (args) => {
      const archived = await explained(() => ops.archive(args.agentId));
      return { archived: true, ...summaryOf(archived) };
    },
  };

  return [create, update, archive];
};

/** What the assistant is told about the agents that exist, so it can name one. */
export const agentKnowledge = (ops: AgentChatOps): Array<{ text: string }> => [
  {
    text:
      ops.roster.length === 0
        ? "AGENTS — none yet. `create_agent` makes one: a name, a colour, instructions and a reach."
        : `AGENTS — ${ops.roster.length}: ` +
          ops.roster
            .map((agent) => `"${agent.name}" (id: ${agent.id}, colour ${agent.color}, may touch: ${summarizeReach(agent.reach)})`)
            .join("; ") +
          ". `create_agent`, `update_agent` and `archive_agent` manage them.",
  },
];
