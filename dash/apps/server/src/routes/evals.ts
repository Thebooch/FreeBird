import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";
import { EvalError, type EvalService } from "../evals/service.js";

/**
 * Dash Evals (`evals/`): the Test button's sessions, kept runs, and leaving
 * trial on evidence.
 *
 * Reading runs needs nothing beyond being in the workspace. Testing and
 * graduating need `workflows.manage`. A test plays in a sandbox: nothing it
 * does is sent, written or charged.
 *
 * - `POST /api/evals/sessions` `{ workflow, scenario? }` starts one; nothing has played.
 * - `POST /api/evals/sessions/:id/step` plays the next turn; after the last, the run is scored and kept.
 * - `POST /api/evals/sessions/:id/finish` plays the rest.
 * - `GET /api/evals/sessions/:id/events?since=` streams the run's events as they happen (server-sent events).
 * - `DELETE /api/evals/sessions/:id` stops it.
 * - `POST /api/evals/test` `{ workflow }` plays the whole pack at once.
 */
export const evalRoutes = (deps: { readonly evals: EvalService; readonly policy: Policy }) => async (app: FastifyInstance): Promise<void> => {
  const { evals, policy } = deps;
  const guarded =
    <T = unknown>(run: (principal: NonNullable<FastifyRequest["principal"]>, request: { readonly params: Record<string, string>; readonly body: T }) => Promise<unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (request: FastifyRequest<any>, reply: FastifyReply) => {
      const principal = await requirePermission(policy, request, reply, "workflows.manage");
      if (!principal) return reply;
      try {
        return await run(principal, { params: (request.params ?? {}) as Record<string, string>, body: (request.body ?? {}) as T });
      } catch (error) {
        if (error instanceof EvalError) return reply.status(error.status).send({ error: error.message });
        throw error;
      }
    };
  const answered = async (reply: FastifyReply, run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof EvalError) return reply.status(error.status).send({ error: error.message });
      throw error;
    }
  };

  app.get<{ Params: { id: string } }>("/api/evals/workflows/:id/pack", (request, reply) => answered(reply, () => evals.pack(request.params.id)));

  app.post<{ Body: { workflow?: string; scenario?: string } }>(
    "/api/evals/sessions",
    guarded<{ workflow?: string; scenario?: string }>(async (principal, request) => {
      if (typeof request.body.workflow !== "string") throw new EvalError("Say which workflow to test.", 400);
      return evals.start(principal, request.body.workflow, typeof request.body.scenario === "string" ? request.body.scenario : undefined);
    }),
  );

  app.post<{ Params: { id: string } }>("/api/evals/sessions/:id/step", guarded(async (_principal, request) => evals.step(request.params["id"]!)));
  app.post<{ Params: { id: string } }>("/api/evals/sessions/:id/finish", guarded(async (_principal, request) => evals.finish(request.params["id"]!)));
  app.delete<{ Params: { id: string } }>(
    "/api/evals/sessions/:id",
    guarded(async (_principal, request) => {
      evals.stop(request.params["id"]!);
      return { stopped: true };
    }),
  );

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>("/api/evals/sessions/:id/events", async (request, reply) => {
    const principal = await requirePermission(policy, request, reply, "workflows.manage");
    if (!principal) return reply;
    const since = Math.max(Number(request.query.since ?? 0) || 0, 0);
    let unsubscribe: (() => void) | null = null;
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      unsubscribe = evals.watch(request.params.id, since, (event) => {
        send(event);
        if (event.kind === "ended") reply.raw.end();
      });
    } catch (error) {
      if (!(error instanceof EvalError)) throw error;
      reply.raw.writeHead(error.status, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: error.message }));
      return reply;
    }
    request.raw.on("close", () => unsubscribe?.());
    return reply;
  });

  app.post<{ Body: { workflow?: string } }>(
    "/api/evals/test",
    guarded<{ workflow?: string }>(async (_principal, request) => {
      if (typeof request.body.workflow !== "string") throw new EvalError("Say which workflow to test.", 400);
      return evals.test(request.body.workflow);
    }),
  );

  app.get<{ Querystring: { workflow?: string; agent?: string; limit?: string } }>("/api/evals/runs", async (request) => {
    const runs = await evals.runs({
      ...(request.query.workflow ? { workflow: request.query.workflow } : {}),
      ...(request.query.agent ? { agent: request.query.agent } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) || 50 } : {}),
    });
    /* The list leaves out each run's event log; one run is read whole. */
    return runs.map(({ events: _events, ...rest }) => rest);
  });

  app.get<{ Params: { id: string } }>("/api/evals/runs/:id", async (request, reply) => (await evals.run(request.params.id)) ?? reply.status(404).send({ error: "There is no such run." }));

  app.get<{ Querystring: { workflow?: string; agent?: string } }>("/api/evals/trend", async (request) =>
    evals.trend({ ...(request.query.workflow ? { workflow: request.query.workflow } : {}), ...(request.query.agent ? { agent: request.query.agent } : {}) }),
  );

  app.get<{ Params: { id: string } }>("/api/workflows/:id/graduation", (request, reply) => answered(reply, () => evals.graduation(request.params.id)));

  /** A person accepts Auto for a step that is ready. */
  app.post<{ Params: { id: string; node: string } }>("/api/workflows/:id/steps/:node/graduate", guarded(async (principal, request) => evals.graduate(principal, request.params["id"]!, request.params["node"]!)));
};
