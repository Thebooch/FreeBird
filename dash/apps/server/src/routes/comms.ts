import { WriteError } from "@freebirdai/connect/host";
import { commsSettingsSchema, mailboxOwnerSchema, parseAreaKey, type Principal } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CommsError, type CommsService } from "../comms/service.js";

/**
 * Communications (`comms/`).
 *
 * Reading mail needs `records.read` on each mailbox, asked per mailbox by the
 * service. Adding a mailbox, its app and who owns it is connection work
 * (`connections.manage`, guarded in `identity/guard.ts`). Sending a draft is
 * `records.act` on its mailbox, asked by the service and again by the write
 * service when it commits.
 */

const providerSchema = z.enum(["gmail", "outlook"]);

export const commsRoutes = (deps: { readonly comms: CommsService }) =>
  async (app: FastifyInstance): Promise<void> => {
    const { comms } = deps;
    const handled =
      <P = Record<string, string>, B = unknown, Q = Record<string, string | undefined>>(
        run: (principal: Principal, request: { readonly params: P; readonly body: B; readonly query: Q }) => Promise<unknown>,
      ) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = request.principal;
        if (!principal) return reply.status(401).send({ error: "Sign in to continue." });
        try {
          return await run(principal, { params: (request.params ?? {}) as P, body: request.body as B, query: (request.query ?? {}) as Q });
        } catch (error) {
          if (error instanceof CommsError) return reply.status(error.status).send({ error: error.message, ...error.extra });
          if (error instanceof WriteError)
            return reply.status(error.status).send({ error: error.message, code: error.code, ...(error.extra.review ? { review: error.extra.review } : {}), ...(error.extra.fields ? { fields: error.extra.fields } : {}) });
          if (error instanceof z.ZodError) return reply.status(400).send({ error: "That request is not one this understands.", detail: error.issues });
          throw error;
        }
      };

    app.get(
      "/api/comms/mailboxes",
      handled(async (principal) => ({ mailboxes: await comms.mailboxes(principal), apps: comms.apps() })),
    );

    app.post(
      "/api/comms/apps/:provider",
      handled<{ provider: string }, { clientId?: string; clientSecret?: string }>(async (_principal, request) => {
        comms.setApp(providerSchema.parse(request.params.provider), String(request.body?.clientId ?? ""), String(request.body?.clientSecret ?? ""));
        return comms.apps();
      }),
    );

    app.post(
      "/api/comms/mailboxes",
      handled<Record<string, string>, unknown>(async (_principal, request) => {
        const body = z.object({ provider: providerSchema, owner: mailboxOwnerSchema, title: z.string().max(120).optional() }).parse(request.body);
        return comms.addMailbox(body);
      }),
    );

    app.put(
      "/api/comms/mailboxes/:id/owner",
      handled<{ id: string }, { owner?: unknown }>(async (_principal, request) => comms.setOwner(request.params.id, mailboxOwnerSchema.parse(request.body?.owner))),
    );

    app.delete(
      "/api/comms/mailboxes/:id",
      handled<{ id: string }>(async (_principal, request) => {
        await comms.removeMailbox(request.params.id);
        return { removed: request.params.id };
      }),
    );

    app.post(
      "/api/comms/mailboxes/:id/refresh",
      handled<{ id: string }>(async (principal, request) => {
        await comms.refresh(request.params.id);
        return (await comms.mailboxes(principal)).find((one) => one.id === request.params.id) ?? null;
      }),
    );

    app.get(
      "/api/comms",
      handled<Record<string, string>, unknown, { area?: string; mailboxes?: string; cursor?: string; q?: string; size?: string }>(async (principal, request) => {
        const area = parseAreaKey(request.query.area);
        if (!area) throw new CommsError("That is not an area of Communications.");
        const mailboxes = request.query.mailboxes ? request.query.mailboxes.split(",").map((one) => one.trim()).filter(Boolean) : undefined;
        return comms.list(principal, {
          area,
          ...(mailboxes ? { mailboxes } : {}),
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
          ...(request.query.q ? { q: request.query.q } : {}),
          ...(request.query.size ? { size: Number(request.query.size) } : {}),
        });
      }),
    );

    app.get(
      "/api/comms/threads/:mailbox/:id",
      handled<{ mailbox: string; id: string }>(async (principal, request) => comms.thread(principal, request.params.mailbox, request.params.id)),
    );

    app.get(
      "/api/comms/drafts",
      handled<Record<string, string>, unknown, { mailbox?: string }>(async (principal, request) => comms.drafts(principal, request.query.mailbox)),
    );

    app.post(
      "/api/comms/drafts",
      handled<Record<string, string>, unknown>(async (principal, request) => {
        const body = z.object({ mailbox: z.string().min(1), replyTo: z.string().min(1), threadId: z.string().optional() }).parse(request.body);
        return comms.startReply(principal, body.mailbox, body.replyTo, body.threadId);
      }),
    );

    app.put(
      "/api/comms/drafts/:id",
      handled<{ id: string }>(async (principal, request) => comms.editDraft(principal, request.params.id, request.body)),
    );

    app.post(
      "/api/comms/drafts/:id/review",
      handled<{ id: string }, { save?: boolean }>(async (principal, request) => comms.review(principal, request.params.id, { save: request.body?.save === true })),
    );

    app.post(
      "/api/comms/drafts/:id/send",
      handled<{ id: string }>(async (principal, request) => {
        const body = z.object({ pendingId: z.string().min(1), digest: z.string().min(1), save: z.boolean().optional() }).parse(request.body);
        return comms.commit(principal, request.params.id, { pendingId: body.pendingId, digest: body.digest, ...(body.save ? { save: true } : {}) });
      }),
    );

    app.post(
      "/api/comms/drafts/:id/discard",
      handled<{ id: string }>(async (principal, request) => comms.discard(principal, request.params.id)),
    );

    app.get("/api/comms/settings", handled(async () => comms.settings()));
    app.put(
      "/api/comms/settings",
      handled(async (_principal, request) => comms.putSettings(commsSettingsSchema.parse(request.body))),
    );
  };
