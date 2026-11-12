import { mailboxOwnerSchema, type Principal } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { PhoneLineError, type PhoneLines } from "../phone/lines.js";

/**
 * Phone lines in Communications (`phone/lines.ts`). Reading them needs
 * `records.read` on each line, asked by the service; adding and removing one
 * is connection work (`connections.manage`, guarded in `identity/guard.ts`
 * with the mailboxes).
 */

const addSchema = z.object({
  provider: z.string().min(1).max(40),
  number: z.string().min(1).max(20),
  keys: z.record(z.string(), z.string().max(500)).default({}),
  owner: mailboxOwnerSchema.optional(),
  title: z.string().max(120).optional(),
});

export const phoneLineRoutes = (deps: { readonly lines: PhoneLines }) =>
  async (app: FastifyInstance): Promise<void> => {
    const handled =
      <P = Record<string, string>>(run: (principal: Principal, request: { readonly params: P; readonly body: unknown }) => Promise<unknown>) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = request.principal;
        if (!principal) return reply.status(401).send({ error: "Sign in to continue." });
        try {
          return await run(principal, { params: (request.params ?? {}) as P, body: request.body });
        } catch (error) {
          if (error instanceof PhoneLineError) return reply.status(error.status).send({ error: error.message });
          if (error instanceof z.ZodError) return reply.status(400).send({ error: "That request is not one this understands.", detail: error.issues });
          throw error;
        }
      };

    app.get(
      "/api/comms/lines",
      handled(async (principal) => ({ lines: await deps.lines.lines(principal), providers: deps.lines.providers() })),
    );

    app.post(
      "/api/comms/lines",
      handled(async (_principal, request) => {
        const body = addSchema.parse(request.body);
        return deps.lines.add({ provider: body.provider, number: body.number, keys: body.keys, ...(body.owner ? { owner: body.owner } : {}), ...(body.title ? { title: body.title } : {}) });
      }),
    );

    app.delete(
      "/api/comms/lines/:id",
      handled<{ id: string }>(async (_principal, request) => {
        await deps.lines.remove(request.params.id);
        return { removed: request.params.id };
      }),
    );
  };
