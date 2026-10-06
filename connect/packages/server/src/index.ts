/**
 * HTTP routes for `@freebirdai/connect`.
 *
 * - `@freebirdai/connect-server/fastify`: `connectFastify(connect)`, plus the
 *   integrate, map and OAuth route plugins a host serving `createEngine` mounts.
 * - `@freebirdai/connect-server/express`: `connectRouter(connect)`.
 * - `@freebirdai/connect-server/next`: `connectRouteHandlers(connect)`.
 *
 * All three serve the same routes, listed here as `CONNECT_ROUTES`.
 */
export { CONNECT_ROUTES, matchRoute, type ConnectRequest, type ConnectResponse, type ConnectRoute } from "./handlers.js";
