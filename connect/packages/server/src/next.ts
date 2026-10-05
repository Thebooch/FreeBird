import type { Connect } from "@freebirdai/connect";
import type { WriteActor } from "@freebirdai/connect/host";
import { matchRoute } from "./handlers.js";

export interface ConnectNextOptions {
  /** The path segment the catch-all route sits under. Default `/connect`. */
  readonly base?: string;
  /** Who is asking, for a change. Absent means the owner. */
  readonly actor?: (request: Request) => WriteActor | undefined | Promise<WriteActor | undefined>;
}

/**
 * The engine's routes for the Next.js App Router. In
 * `app/connect/[...route]/route.ts`:
 *
 * ```ts
 * const handlers = connectRouteHandlers(connect);
 * export const { GET, POST, PUT, DELETE } = handlers;
 * ```
 */
export const connectRouteHandlers = (connect: Connect, options: ConnectNextOptions = {}) => {
  const base = options.base ?? "/connect";
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const at = url.pathname.lastIndexOf(base);
    const path = at >= 0 ? url.pathname.slice(at + base.length) || "/" : url.pathname;
    const matched = matchRoute(request.method, path);
    if (!matched) return Response.json({ error: "Not found." }, { status: 404 });
    const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json().catch(() => undefined);
    const actor = options.actor ? await options.actor(request) : undefined;
    const answer = await matched.route.handler(connect, { params: matched.params, body, actor });
    return Response.json(answer.body, { status: answer.status });
  };
  return { GET: handle, POST: handle, PUT: handle, DELETE: handle };
};
