import type { Principal } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { RegistrationError, type RegistrationService } from "../phone/registration.js";

/**
 * The text registration wizard's API (`phone/registration.ts`), under a
 * line: `/api/comms/lines/:id/registration…`. Reading it needs `records.read`
 * on the line; everything else is connection work (`connections.manage`,
 * guarded with the lines in `identity/guard.ts`). Submitting is its own
 * POST, which only the wizard's Submit button sends: the chat never does.
 */
export const registrationRoutes = (deps: { readonly registration: RegistrationService; readonly canRead: (principal: Principal, line: string) => Promise<boolean> }) =>
  async (app: FastifyInstance): Promise<void> => {
    const { registration } = deps;
    const handled =
      <P extends { id: string } = { id: string }>(run: (request: { readonly params: P; readonly body: unknown }) => Promise<unknown>) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = request.principal;
        if (!principal) return reply.status(401).send({ error: "Sign in to continue." });
        const params = (request.params ?? {}) as P;
        try {
          if (!(await deps.canRead(principal, params.id))) return reply.status(404).send({ error: `There is no phone line "${params.id}".` });
          return await run({ params, body: request.body });
        } catch (error) {
          if (error instanceof RegistrationError) return reply.status(error.status).send({ error: error.message, ...(error.problems ? { problems: error.problems } : {}) });
          if (error instanceof z.ZodError) return reply.status(400).send({ error: "That request is not one this understands.", detail: error.issues });
          if (error instanceof Error && error.name === "TwilioError") return reply.status(502).send({ error: `Twilio said: ${error.message}` });
          throw error;
        }
      };
    const base = "/api/comms/lines/:id/registration";

    app.get(base, handled(async ({ params }) => registration.view(params.id)));
    app.put(base, handled(async ({ params, body }) => registration.save(params.id, z.record(z.string(), z.unknown()).parse(body))));
    app.post(`${base}/ein`, handled(async ({ params, body }) => registration.setEin(params.id, z.object({ ein: z.string().max(20) }).parse(body).ein)));
    app.post(`${base}/draft`, handled(async ({ params }) => registration.draftUse(params.id)));
    app.post(`${base}/draft/use`, handled(async ({ params, body }) => registration.acceptDraft(params.id, z.object({ accept: z.boolean() }).parse(body).accept)));
    app.get(`${base}/uses`, handled(async ({ params }) => ({ uses: await registration.useCases(params.id) })));
    app.post(`${base}/check`, handled(async ({ params }) => ({ problems: await registration.check(params.id) })));
    app.post(`${base}/submit`, handled(async ({ params }) => registration.submit(params.id)));
    app.post(`${base}/refresh`, handled(async ({ params }) => registration.view((await registration.poll(params.id)).line)));
    app.get<{ Params: { id: string; code: string } }>(`${base}/explain/:code`, handled<{ id: string; code: string }>(async ({ params }) => registration.explain(params.id, params.code)));
  };
