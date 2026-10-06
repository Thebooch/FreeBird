import type { FastifyInstance, FastifyReply } from "fastify";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { AgentSpec, AgentTool } from "@freebirdai/dash-spec";
import { assistRequestSchema, draftAgentText } from "../agents/assist.js";
import { AgentError, type AgentService } from "../agents/service.js";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";

/**
 * Agents: named AI workers (`@freebirdai/dash-spec` `agent.ts`).
 *
 * Reading them needs nothing beyond being in the workspace. Saving, archiving
 * and removing are guarded by `agents.manage` in `identity/guard.ts`, and a
 * reach is checked again by the service against what the person saving holds.
 */
export const agentRoutes = (
  service: AgentService,
  policy: Policy,
  /** The model the Generate button drafts with; null when no AI key is set. */
  llm: () => LlmAdapter | null = () => null,
  /**
   * What an agent's tool does when a conversation uses it. Comms calls this for
   * each tool call; the route below lets a person try one. Absent: no tool is usable yet.
   */
  tools: {
    readonly useTool?: (agent: AgentSpec, tool: AgentTool, inputs: Record<string, unknown>, conversation?: string) => Promise<unknown>;
  } = {},
) =>
  async (app: FastifyInstance): Promise<void> => {
    const fail = (reply: FastifyReply, error: unknown) => {
      if (error instanceof AgentError) {
        return reply.status(error.status).send({ error: error.message, ...(error.problems.length > 0 ? { problems: error.problems } : {}) });
      }
      throw error;
    };

    app.get<{ Querystring: { archived?: string } }>("/api/agents", async (request) =>
      service.list({ includeArchived: request.query.archived === "1" || request.query.archived === "true" }),
    );

    /**
     * The Generate button: what the person typed for one part of an agent, made
     * into a prompt a model follows well. Returns the draft; nothing is saved
     * until the person saves the agent.
     */
    app.post<{ Body: unknown }>("/api/agents/assist", async (request, reply) => {
      const principal = await requirePermission(policy, request, reply, "agents.manage");
      if (!principal) return reply;
      const parsed = assistRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((one) => one.message).join("; ") });
      const model = llm();
      if (!model) return reply.status(503).send({ error: "No AI model is set up. Add an AI key to use Generate." });
      try {
        return { text: await draftAgentText(model, parsed.data) };
      } catch (error) {
        return reply.status(502).send({ error: error instanceof Error ? error.message : "The model could not draft this." });
      }
    });

    /** The knowledge every agent shares, beside its own. */
    app.get("/api/agent-knowledge", async () => service.shared());

    app.put<{ Body: unknown }>("/api/agent-knowledge", async (request, reply) => {
      const principal = await requirePermission(policy, request, reply, "agents.manage");
      if (!principal) return reply;
      try {
        return await service.putShared(request.body);
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.get<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
      const agent = await service.get(request.params.id);
      return agent ?? reply.status(404).send({ error: `There is no agent "${request.params.id}".` });
    });

    /**
     * One verb for make-and-change, as boards have: an id that exists is
     * changed, and one that does not is made. The server picks the id it keeps.
     */
    app.put<{ Params: { id: string }; Body: unknown }>("/api/agents/:id", async (request, reply) => {
      const principal = await requirePermission(policy, request, reply, "agents.manage");
      if (!principal) return reply;
      try {
        const held = await service.get(request.params.id);
        return held
          ? await service.update(principal, request.params.id, request.body as never)
          : await service.create(principal, request.body as never);
      } catch (error) {
        return fail(reply, error);
      }
    });

    /**
     * Use one of an agent's tools, as a conversation would: `{ inputs, conversation }`.
     * The tool's own mode decides what happens — auto does it, approve asks the
     * team, deny declines. Only `run_workflow` tools do anything yet.
     */
    app.post<{ Params: { id: string; toolId: string }; Body: { inputs?: Record<string, unknown>; conversation?: string } | undefined }>(
      "/api/agents/:id/tools/:toolId/use",
      async (request, reply) => {
        const principal = await requirePermission(policy, request, reply, "agents.manage");
        if (!principal) return reply;
        const agent = await service.get(request.params.id);
        const tool = agent?.tools.find((one) => one.id === request.params.toolId);
        if (!agent || !tool) return reply.status(404).send({ error: "There is no such tool on this agent." });
        if (!tools.useTool || tool.kind !== "run_workflow") return reply.status(501).send({ error: "This kind of tool is used in conversations, which are not set up yet." });
        return tools.useTool(agent, tool, request.body?.inputs ?? {}, request.body?.conversation);
      },
    );

    app.post<{ Params: { id: string } }>("/api/agents/:id/restore", async (request, reply) => {
      const principal = await requirePermission(policy, request, reply, "agents.manage");
      if (!principal) return reply;
      try {
        return await service.setArchived(request.params.id, false);
      } catch (error) {
        return fail(reply, error);
      }
    });

    /** Archives. With `?permanent=1`, removes an agent that is already archived and referred to by nothing. */
    app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>("/api/agents/:id", async (request, reply) => {
      const principal = await requirePermission(policy, request, reply, "agents.manage");
      if (!principal) return reply;
      try {
        if (request.query.permanent === "1" || request.query.permanent === "true") {
          await service.remove(request.params.id);
          return { removed: true, id: request.params.id };
        }
        return await service.setArchived(request.params.id, true);
      } catch (error) {
        return fail(reply, error);
      }
    });
  };
