import type { Connect } from "@freebirdai/connect";
import type { WriteActor } from "@freebirdai/connect/host";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { CONNECT_ROUTES } from "./handlers.js";

export interface ConnectFastifyOptions {
  /** Where the routes are mounted. Default `/connect`. */
  readonly prefix?: string;
  /** Who is asking, for a change. Absent means the owner. */
  readonly actor?: (request: FastifyRequest) => WriteActor | undefined | Promise<WriteActor | undefined>;
}

/**
 * The engine's routes, as a Fastify plugin.
 *
 * ```ts
 * app.register(connectFastify(connect, { prefix: "/connect" }));
 * ```
 */
export const connectFastify =
  (connect: Connect, options: ConnectFastifyOptions = {}) =>
  async (app: FastifyInstance): Promise<void> => {
    const prefix = options.prefix ?? "/connect";
    for (const route of CONNECT_ROUTES) {
      app.route({
        method: route.method,
        url: `${prefix}${route.path}`,
        handler: async (request, reply) => {
          const actor = options.actor ? await options.actor(request) : undefined;
          const answer = await route.handler(connect, {
            params: (request.params ?? {}) as Record<string, string>,
            body: request.body,
            actor,
          });
          return reply.status(answer.status).send(answer.body);
        },
      });
    }
  };

export { connectionRoutes, type ConnectionRouteHooks } from "./connections.js";
export { integrateRoutes } from "./integrate.js";
export { mapRoutes } from "./map.js";
export { oauthRoutes, type OAuthRouteDeps } from "./oauth.js";
