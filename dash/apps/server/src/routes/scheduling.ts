import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";
import { SchedulingError, type SchedulingService } from "../scheduling/service.js";

/**
 * Scheduling's setup (`scheduling/`): `/api/scheduling/*`.
 *
 * Reading needs nothing beyond being in the workspace. Every change needs
 * `calendar.manage` (owner, admin, editor), guarded in `identity/guard.ts`
 * and asked again here. Things are made and changed by `PUT` to their id,
 * as workflows are.
 */
export const schedulingRoutes = (deps: { readonly scheduling: SchedulingService; readonly policy: Policy }) =>
  async (app: FastifyInstance): Promise<void> => {
    const { scheduling, policy } = deps;
    const answer = (reply: FastifyReply, error: unknown) => {
      if (error instanceof SchedulingError) return reply.status(error.status).send({ error: error.message });
      throw error;
    };
    const guarded =
      (run: (principal: NonNullable<FastifyRequest["principal"]>, params: Record<string, string>, body: unknown) => Promise<unknown>) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = await requirePermission(policy, request, reply, "calendar.manage");
        if (!principal) return reply;
        try {
          return await run(principal, (request.params ?? {}) as Record<string, string>, request.body);
        } catch (error) {
          return answer(reply, error);
        }
      };
    const field = (value: unknown, key: string): unknown => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);

    app.get("/api/scheduling", async () => scheduling.overview());

    app.get<{ Querystring: { from?: string; to?: string } }>("/api/scheduling/occurrences", async (request, reply) => {
      const from = Date.parse(request.query.from ?? "");
      const to = Date.parse(request.query.to ?? "");
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return reply.status(400).send({ error: "Say from and to, as instants." });
      if (to - from > 92 * 86_400_000) return reply.status(400).send({ error: "Ask for at most 92 days at a time." });
      return scheduling.occurrences(from, to);
    });

    app.put("/api/scheduling/defaults", guarded(async (_principal, _params, body) => scheduling.setDefaults(body)));

    app.put("/api/scheduling/profiles/:member", guarded(async (_principal, params, body) => scheduling.putProfile(params["member"]!, body)));
    app.delete("/api/scheduling/profiles/:member", guarded(async (_principal, params) => scheduling.removeProfile(params["member"]!)));

    app.put("/api/scheduling/pools/:id", guarded(async (_principal, params, body) => scheduling.putPool(params["id"]!, body)));
    app.delete("/api/scheduling/pools/:id", guarded(async (_principal, params) => scheduling.removePool(params["id"]!)));

    app.put("/api/scheduling/types/:id", guarded(async (_principal, params, body) => scheduling.putType(params["id"]!, body)));
    app.delete("/api/scheduling/types/:id", guarded(async (_principal, params) => scheduling.removeType(params["id"]!)));
    /** What a person would be offered, from facts typed in. Reads only, but runs the engine: guarded like the setup it tries out. */
    app.post("/api/scheduling/types/:id/preview", guarded(async (_principal, params, body) => scheduling.preview(params["id"]!, body)));

    app.put("/api/scheduling/blocks/:id", guarded(async (_principal, params, body) => scheduling.putBlock(params["id"]!, body)));
    app.delete("/api/scheduling/blocks/:id", guarded(async (_principal, params) => scheduling.removeBlock(params["id"]!)));

    app.put("/api/scheduling/placements/:id", guarded(async (principal, params, body) => scheduling.putPlacement(principal, params["id"]!, body)));
    app.delete("/api/scheduling/placements/:id", guarded(async (_principal, params) => scheduling.removePlacement(params["id"]!)));
    app.post("/api/scheduling/placements/:id/skip", guarded(async (_principal, params, body) => scheduling.skipOccurrence(params["id"]!, field(body, "date"))));
    app.post("/api/scheduling/placements/:id/split", guarded(async (_principal, params, body) => scheduling.splitAt(params["id"]!, field(body, "date"), field(body, "newId"))));
  };
