import { createRequire } from "node:module";
import type { Connect } from "@freebirdai/connect";
import type { WriteActor } from "@freebirdai/connect/host";
import type { Request, Router } from "express";
import { CONNECT_ROUTES } from "./handlers.js";

/* `require` is not defined in native ESM; build one from this module so `express` stays an optional peer. */
const nodeRequire = createRequire(import.meta.url);

export interface ConnectExpressOptions {
  /** Who is asking, for a change. Absent means the owner. */
  readonly actor?: (request: Request) => WriteActor | undefined | Promise<WriteActor | undefined>;
}

/**
 * The engine's routes, as an Express router. Needs `express.json()` before it.
 *
 * ```ts
 * app.use("/connect", express.json(), connectRouter(connect));
 * ```
 */
export const connectRouter = (connect: Connect, options: ConnectExpressOptions = {}): Router => {
  const { Router } = nodeRequire("express") as typeof import("express");
  const router = Router();
  for (const route of CONNECT_ROUTES) {
    const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete";
    router[method](route.path, async (request, response) => {
      const actor = options.actor ? await options.actor(request) : undefined;
      const answer = await route.handler(connect, {
        params: request.params as Record<string, string>,
        body: request.body,
        actor,
      });
      response.status(answer.status).json(answer.body);
    });
  }
  return router;
};
