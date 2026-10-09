import type { Permission, Principal, Scope } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Policy } from "./policy.js";
import { installPublicRoutes, isPublicUrl } from "./public.js";
import type { IdentityResolver } from "./resolver.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Who sent this request. Set by the identity hook before any route runs. */
    principal: Principal | null;
  }
}

/**
 * Give every request a principal before any route sees it.
 *
 * On the root instance, so it reaches every plugin registered after it — the
 * chat plugin included. A request nobody can be identified as is refused
 * here with a 401, which the open-source build never produces.
 */
export const installIdentity = (app: FastifyInstance, identity: IdentityResolver): void => {
  app.decorateRequest("principal", null);
  installPublicRoutes(app);
  app.addHook("onRequest", async (request, reply) => {
    /* A public page's API answers with no principal: what it may do comes from its token. Only routes marked public. */
    if (isPublicUrl(request.url)) {
      if (request.routeOptions.config?.public === true) return undefined;
      return reply.status(404).send({ error: "Not found." });
    }
    const principal = await identity.resolve({ headers: request.headers, url: request.url });
    if (!principal) {
      return reply.status(401).send({ error: "Sign in to continue." });
    }
    request.principal = principal;
    return undefined;
  });
};

/**
 * Ask the policy, and answer the request with its reason when the answer is no.
 *
 * Returns the principal to carry on with, or `null` once the reply has been
 * sent — so a route reads `const who = await requirePermission(...); if (!who) return reply;`.
 */
export const requirePermission = async (
  policy: Policy,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
  scope: Scope = {},
): Promise<Principal | null> => {
  const principal = request.principal;
  if (!principal) {
    await reply.status(401).send({ error: "Sign in to continue." });
    return null;
  }
  const decision = await policy.can(principal, permission, scope);
  if (!decision.ok) {
    await reply.status(403).send({ error: decision.reason, permission });
    return null;
  }
  return principal;
};
