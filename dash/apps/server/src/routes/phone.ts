import { mailboxOwnerSchema, type Principal } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { PhoneProviderError } from "@freebirdai/phone";
import { PhoneLineError, type PhoneLines } from "../phone/lines.js";
import type { PhoneSetup } from "../phone/setup.js";
import type { CallSetup } from "../phone/call-setup.js";
import type { PhoneTextStore } from "../phone/texts.js";

/**
 * Phone lines in Communications (`phone/`). Reading them and their
 * conversations needs `records.read` on each line, asked here. Everything
 * that changes a line or an account (connecting a provider, checking the
 * public address, buying and wiring a number, the owner) is connection work:
 * `connections.manage`, guarded in `identity/guard.ts` with the mailboxes.
 */

const addSchema = z.object({
  provider: z.string().min(1).max(40),
  number: z.string().min(1).max(20),
  keys: z.record(z.string(), z.string().max(500)).default({}),
  owner: mailboxOwnerSchema.optional(),
  title: z.string().max(120).optional(),
});

const setupSchema = z.object({
  provider: z.string().min(1).max(40),
  choice: z.enum(["new", "existing", "forward"]),
  number: z.string().min(1).max(20),
  owner: mailboxOwnerSchema.optional(),
  title: z.string().max(120).optional(),
});

const callsSchema = z.object({
  answer: z.enum(["agent", "forward", "voicemail"]),
  forwardTo: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  recording: z.boolean(),
  disclosure: z.string().max(300).default(""),
});

export const phoneLineRoutes = (deps: { readonly lines: PhoneLines; readonly setup?: PhoneSetup; /** Where a carrier without an API sends calls: the media layer's SIP address. */ readonly callsAddress?: string; readonly calls?: CallSetup; readonly texts?: PhoneTextStore; readonly canRead?: (principal: Principal, line: string) => Promise<boolean> }) =>
  async (app: FastifyInstance): Promise<void> => {
    const handled =
      <P = Record<string, string>, Q = Record<string, string | undefined>>(run: (principal: Principal, request: { readonly params: P; readonly body: unknown; readonly query: Q }) => Promise<unknown>) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = request.principal;
        if (!principal) return reply.status(401).send({ error: "Sign in to continue." });
        try {
          return await run(principal, { params: (request.params ?? {}) as P, body: request.body, query: (request.query ?? {}) as Q });
        } catch (error) {
          if (error instanceof PhoneLineError) return reply.status(error.status).send({ error: error.message });
          if (error instanceof z.ZodError) return reply.status(400).send({ error: "That request is not one this understands.", detail: error.issues });
          if (error instanceof Error && error.name === "PhoneKeysError") return reply.status(400).send({ error: error.message });
          if (error instanceof PhoneProviderError) return reply.status(502).send({ error: `${error.provider} said: ${error.message}` });
          throw error;
        }
      };
    const setupNeeded = (): PhoneSetup => {
      if (!deps.setup) throw new PhoneLineError("Phone setup isn't available on this server.", 501);
      return deps.setup;
    };
    const readable = async (principal: Principal, id: string) => {
      if (!deps.lines.get(id) || (deps.canRead && !(await deps.canRead(principal, id)))) throw new PhoneLineError(`There is no phone line "${id}".`, 404);
    };

    app.get(
      "/api/comms/lines",
      handled(async (principal) => ({ lines: await deps.lines.lines(principal), providers: deps.lines.providers(), accounts: deps.setup?.accounts() ?? [], ...(deps.callsAddress ? { callsAddress: deps.callsAddress } : {}) })),
    );

    app.post(
      "/api/comms/lines",
      handled(async (_principal, request) => {
        const body = addSchema.parse(request.body);
        return deps.lines.add({ provider: body.provider, number: body.number, keys: body.keys, ...(body.owner ? { owner: body.owner } : {}), ...(body.title ? { title: body.title } : {}) });
      }),
    );

    /* ── Settings → Phone ─────────────────────────────────────────────── */

    app.post(
      "/api/comms/lines/accounts/:provider",
      handled<{ provider: string }>(async (_principal, request) => {
        const body = z.object({ keys: z.record(z.string(), z.string().max(500)) }).parse(request.body);
        return setupNeeded().connect(request.params.provider, body.keys);
      }),
    );

    app.delete(
      "/api/comms/lines/accounts/:provider",
      handled<{ provider: string }>(async (_principal, request) => {
        setupNeeded().disconnect(request.params.provider);
        return { disconnected: request.params.provider };
      }),
    );

    app.get(
      "/api/comms/lines/accounts/:provider/numbers",
      handled<{ provider: string }, { areaCode?: string }>(async (_principal, request) => ({ numbers: await setupNeeded().search(request.params.provider, request.query.areaCode) })),
    );

    app.get(
      "/api/comms/lines/accounts/:provider/owned",
      handled<{ provider: string }>(async (_principal, request) => ({ numbers: await setupNeeded().owned(request.params.provider) })),
    );

    /* A POST: it reaches out through the public address, so it is guarded like the rest of setup. */
    app.post(
      "/api/comms/lines/address-check",
      handled(async () => setupNeeded().checkAddress()),
    );

    app.post(
      "/api/comms/lines/setup",
      handled(async (_principal, request) => {
        const body = setupSchema.parse(request.body);
        return setupNeeded().addLine({ provider: body.provider, choice: body.choice, number: body.number, ...(body.owner ? { owner: body.owner } : {}), ...(body.title ? { title: body.title } : {}) });
      }),
    );

    /* ── one line ─────────────────────────────────────────────────────── */

    app.put(
      "/api/comms/lines/:id/owner",
      handled<{ id: string }>(async (_principal, request) => deps.lines.setOwner(request.params.id, mailboxOwnerSchema.parse((request.body as { owner?: unknown } | undefined)?.owner))),
    );

    /* Calls: who answers, the forward number, recording and the opening words; connecting the line's calls to the media layer. */
    app.put(
      "/api/comms/lines/:id/calls",
      handled<{ id: string }>(async (_principal, request) => deps.lines.setCalls(request.params.id, callsSchema.parse(request.body))),
    );
    app.post(
      "/api/comms/lines/:id/calls/connect",
      handled<{ id: string }>(async (_principal, request) => {
        if (!deps.calls) throw new PhoneLineError("Calls aren't set up on this server.", 501);
        return deps.calls.connect(request.params.id);
      }),
    );
    app.post(
      "/api/comms/lines/:id/calls/disconnect",
      handled<{ id: string }>(async (_principal, request) => {
        if (!deps.calls) throw new PhoneLineError("Calls aren't set up on this server.", 501);
        return deps.calls.disconnect(request.params.id);
      }),
    );

    app.delete(
      "/api/comms/lines/:id",
      handled<{ id: string }>(async (_principal, request) => {
        await deps.lines.remove(request.params.id);
        return { removed: request.params.id };
      }),
    );

    /* Its conversations, newest first. Keywords are shown to people, marked; agents never read them as conversation. */
    app.get(
      "/api/comms/lines/:id/threads",
      handled<{ id: string }>(async (principal, request) => {
        await readable(principal, request.params.id);
        if (!deps.texts) return { threads: [] };
        const threads = await deps.texts.threads(request.params.id, 100);
        return { threads: await Promise.all(threads.map(async (one) => ({ ...one, last: (await deps.texts!.thread(one.line, one.number, 1))[0] ?? null }))) };
      }),
    );

    app.get(
      "/api/comms/lines/:id/threads/:number",
      handled<{ id: string; number: string }>(async (principal, request) => {
        await readable(principal, request.params.id);
        const texts = deps.texts ? await deps.texts.thread(request.params.id, decodeURIComponent(request.params.number), 200) : [];
        return { texts: [...texts].reverse() };
      }),
    );
  };
