import { createRequire } from "node:module";
import type { Request, RequestHandler, Response, Router } from "express";
import type { AuthContext } from "@freebirdai/core";
import { ROUTES, type FreeBirdRequest } from "./handlers.js";
import {
  createDepsResolver,
  type CreateFreeBirdRouterOptions,
  type DepsResolver,
} from "./index.js";
import { SSE_HEADERS, serializeSseEvent } from "./sse.js";

// `require` is not defined in native ESM. tsup rewrites any bare `require`
// (even inside `typeof require`) to a `__require` shim that throws, so we must
// not reference it at all — build our own from this module's URL instead. This
// is what previously forced hosts to polyfill `globalThis.require`.
const nodeRequire = createRequire(import.meta.url);

/**
 * Build an Express router that mounts every FreeBird endpoint.
 * Requires `express` as a peer dependency — we import it lazily to avoid
 * pulling it in for Fastify-only users.
 *
 * Returns a `DepsResolver` handle alongside the router so multi-tenant hosts
 * can call `invalidateRegistry(tenantKey)` when a site's manifest changes.
 *
 * Usage:
 *   import { createFreeBirdRouter } from "@freebirdai/server/express";
 *   app.use("/freebird", createFreeBirdRouter({ db, llm, email, registry, scheduler: "inProcess" }));
 */
export const createFreeBirdRouter = (opts: CreateFreeBirdRouterOptions): Router & { freebird: DepsResolver } => {
  const { Router } = nodeRequire("express");
  const router = Router();
  const deps = createDepsResolver(opts);

  const resolveAuth = async (req: Request): Promise<AuthContext | null> => {
    if (!opts.getAuthContext) return {};
    const a = await opts.getAuthContext(req);
    return a;
  };

  for (const spec of ROUTES) {
    const expressPath = spec.path.replace(/:([^/]+)/g, ":$1");
    const handler: RequestHandler = async (req, res) => {
      const auth = await resolveAuth(req);
      if (auth === null) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const fbReq: FreeBirdRequest<any> = {
        body: req.body,
        params: req.params as Record<string, string>,
        query: req.query as Record<string, string | string[] | undefined>,
        headers: req.headers as Record<string, string | string[] | undefined>,
        auth,
        signal: abortSignalFromRequest(req),
      };
      try {
        const handlerDeps = await deps.resolve(auth);
        const result = spec.handler(handlerDeps, fbReq);
        if (spec.kind === "sse") {
          await writeSse(res, (result as any).events);
        } else {
          const awaited = await result;
          res.status((awaited as any).status).json((awaited as any).body);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) res.status(500).json({ error: message });
        else res.end();
      }
    };
    const method = spec.method.toLowerCase() as Lowercase<typeof spec.method>;
    (router as any)[method](expressPath, handler);
  }

  // Attach the resolver handle so hosts can invalidate tenant registries.
  (router as Router & { freebird: DepsResolver }).freebird = deps;
  return router as Router & { freebird: DepsResolver };
};

const writeSse = async (res: Response, events: AsyncIterable<unknown>): Promise<void> => {
  res.status(200);
  for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v);
  res.flushHeaders?.();
  try {
    for await (const ev of events) {
      res.write(serializeSseEvent(ev));
    }
    res.write("data: [DONE]\n\n");
  } finally {
    res.end();
  }
};

const abortSignalFromRequest = (req: Request): AbortSignal | undefined => {
  if (typeof AbortController === "undefined") return undefined;
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  return ac.signal;
};
