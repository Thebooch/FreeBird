import type { FastifyInstance, FastifyReply } from "fastify";
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
export const agentRoutes = (service: AgentService, policy: Policy) =>
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
