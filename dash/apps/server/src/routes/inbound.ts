import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";
import { InboundError, type InboundService } from "../inbound/service.js";

/**
 * The inbound screen (`inbound/`): held emails, and who is trusted or blocked.
 *
 * Reading needs `workflows.manage`, as deciding does: a held email is
 * waiting for the people who decide what workflows do. Nothing here shows a
 * message's words; Communications does, as it always has.
 *
 * - `GET /api/inbound/screens?status=held` the screened emails, newest first.
 * - `POST /api/inbound/screens/:id/release` lets one go on, as if it had just arrived.
 * - `POST /api/inbound/screens/:id/block` `{ scope? }` blocks its sender (address or domain) and drops it.
 * - `POST /api/inbound/screens/:id/trust` `{ scope? }` trusts its sender and releases it.
 * - `GET|PUT /api/inbound/settings` observe-only and the per-sender limits.
 * - `GET /api/inbound/rules`, `PUT /api/inbound/rules` `{ key, trust }`, `DELETE /api/inbound/rules/:key`.
 * - `GET /api/inbound/summary?days=` what observe-only has seen.
 */
export const inboundRoutes = (deps: { readonly inbound: InboundService; readonly policy: Policy }) => async (app: FastifyInstance): Promise<void> => {
  const { inbound, policy } = deps;
  const guarded =
    <T = unknown>(run: (principal: NonNullable<FastifyRequest["principal"]>, request: { readonly params: Record<string, string>; readonly body: T; readonly query: Record<string, string> }) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = await requirePermission(policy, request, reply, "workflows.manage");
      if (!principal) return reply;
      try {
        return await run(principal, { params: (request.params ?? {}) as Record<string, string>, body: (request.body ?? {}) as T, query: (request.query ?? {}) as Record<string, string> });
      } catch (error) {
        if (error instanceof InboundError) return reply.status(error.status).send({ error: error.message });
        throw error;
      }
    };
  const scopeOf = (body: { scope?: unknown }): "address" | "domain" => (body.scope === "domain" ? "domain" : "address");

  app.get(
    "/api/inbound/screens",
    guarded(async (_principal, request) =>
      inbound.list({
        ...(request.query["status"] === "held" || request.query["status"] === "passed" || request.query["status"] === "released" || request.query["status"] === "dropped" ? { status: request.query["status"] } : {}),
        ...(request.query["limit"] ? { limit: Number(request.query["limit"]) || 100 } : {}),
      }),
    ),
  );
  app.post("/api/inbound/screens/:id/release", guarded(async (principal, request) => inbound.release(principal, request.params["id"]!)));
  app.post("/api/inbound/screens/:id/block", guarded<{ scope?: unknown }>(async (principal, request) => inbound.block(principal, request.params["id"]!, scopeOf(request.body))));
  app.post("/api/inbound/screens/:id/trust", guarded<{ scope?: unknown }>(async (principal, request) => inbound.trust(principal, request.params["id"]!, scopeOf(request.body))));

  app.get("/api/inbound/settings", guarded(async () => inbound.settings()));
  app.put("/api/inbound/settings", guarded(async (_principal, request) => inbound.putSettings(request.body)));

  app.get("/api/inbound/rules", guarded(async () => inbound.rules()));
  app.put(
    "/api/inbound/rules",
    guarded<{ key?: unknown; trust?: unknown; note?: unknown }>(async (principal, request) => {
      const { key, trust, note } = request.body;
      if (typeof key !== "string" || (trust !== "blocked" && trust !== "trusted")) throw new InboundError("Say whose rule (address:<email> or domain:<domain>) and whether they are blocked or trusted.", 400);
      return inbound.setRule(principal, key.trim().toLowerCase(), trust, typeof note === "string" ? note : undefined);
    }),
  );
  app.delete(
    "/api/inbound/rules/:key",
    guarded(async (_principal, request) => {
      await inbound.removeRule(request.params["key"]!);
      return { removed: true };
    }),
  );

  app.get("/api/inbound/summary", guarded(async (_principal, request) => inbound.summary(Math.min(Math.max(Number(request.query["days"] ?? 7) || 7, 1), 90))));
};
