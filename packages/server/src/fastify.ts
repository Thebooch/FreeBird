import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginAsync } from "fastify";
import type { AuthContext } from "@freebirdai/core";
import { ROUTES, type FreeBirdRequest } from "./handlers.js";
import {
  createDepsResolver,
  type CreateFreeBirdRouterOptions,
  type DepsResolver,
} from "./index.js";
import { SSE_HEADERS, serializeSseEvent } from "./sse.js";

/**
 * Fastify plugin factory. Register with `fastify.register(plugin, { prefix: "/freebird" })`.
 *
 * The returned plugin carries a `.freebird` {@link DepsResolver} handle so
 * multi-tenant hosts can invalidate a tenant's cached registry.
 */
export const createFreeBirdPlugin = (
  opts: CreateFreeBirdRouterOptions,
): FastifyPluginAsync & { freebird: DepsResolver } => {
  const deps = createDepsResolver(opts);

  const plugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    for (const spec of ROUTES) {
      const path = spec.path;
      fastify.route({
        method: spec.method,
        url: path,
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const auth: AuthContext | null = opts.getAuthContext
            ? await opts.getAuthContext(req)
            : {};
          if (auth === null) {
            reply.code(401).send({ error: "Unauthorized" });
            return;
          }
          const fbReq: FreeBirdRequest<any> = {
            body: (req.body as any) ?? {},
            params: (req.params as Record<string, string>) ?? {},
            query: (req.query as Record<string, any>) ?? {},
            headers: req.headers as Record<string, any>,
            auth,
            signal: abortSignalFromFastify(req),
          };
          try {
            const handlerDeps = await deps.resolve(auth);
            const result = spec.handler(handlerDeps, fbReq);
            if (spec.kind === "sse") {
              await writeSse(reply, (result as any).events);
            } else {
              const awaited = await result;
              reply.code((awaited as any).status).send((awaited as any).body);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!reply.sent) reply.code(500).send({ error: message });
          }
        },
      });
    }
  };

  return Object.assign(plugin, { freebird: deps });
};

const writeSse = async (reply: FastifyReply, events: AsyncIterable<unknown>): Promise<void> => {
  // Writing straight to reply.raw skips Fastify's normal send lifecycle, so
  // a CORS plugin registered on the host app (whose headers are added in an
  // onSend hook) never gets a chance to run. Without this, a widget embedded
  // on a different origin than the API (the common case — the widget's host
  // page is almost never served from the API's own origin) gets a response
  // with no Access-Control-Allow-Origin header, which the browser silently
  // rejects as a network-level `TypeError: Failed to fetch`.
  const origin = reply.request.headers.origin;
  reply.raw.writeHead(200, {
    ...SSE_HEADERS,
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  });
  try {
    for await (const ev of events) {
      reply.raw.write(serializeSseEvent(ev));
    }
    reply.raw.write("data: [DONE]\n\n");
  } finally {
    reply.raw.end();
  }
};

const abortSignalFromFastify = (req: FastifyRequest): AbortSignal | undefined => {
  if (typeof AbortController === "undefined") return undefined;
  const ac = new AbortController();
  req.raw.on("close", () => ac.abort());
  return ac.signal;
};
