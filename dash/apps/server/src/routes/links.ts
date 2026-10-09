import type { FastifyInstance, FastifyReply } from "fastify";
import type { BookingLinks } from "../bookings/links.js";
import { BookingError, type BookingService } from "../bookings/service.js";
import { ContactError } from "../contacts/service.js";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";
import type { PublicToken } from "../public/tokens.js";
import type { TaskStore } from "../workflows/store.js";

/**
 * The links a member hands out, signed in:
 *
 * - `POST /api/scheduling/bookings/:id/approval-link`: their own link to
 *   answer the booking's waiting approval from the approval page ("Copy
 *   approval link", for when email isn't connected).
 * - `POST /api/scheduling/bookings/:id/link`: the person's own page for it.
 * - `GET|POST /api/contacts/:id/links`, `POST …/links/:link/revoke`: a
 *   contact's booking links, made and withdrawn from the contact sheet.
 *
 * A link is shown once, when it is made: only its hash is kept.
 */
export const linkRoutes = (deps: { readonly links: BookingLinks; readonly bookings: BookingService; readonly tasks: TaskStore; readonly policy: Policy }) =>
  async (app: FastifyInstance): Promise<void> => {
    const { links, bookings, tasks, policy } = deps;
    const fail = (reply: FastifyReply, error: unknown) => {
      if (error instanceof BookingError || error instanceof ContactError) return reply.status(error.status).send({ error: error.message });
      throw error;
    };
    /* What the contact sheet shows of a link: never anything that opens it. */
    const shown = (one: PublicToken) => ({
      id: one.id,
      ...(one.type ? { type: one.type } : {}),
      ...(one.booking ? { booking: one.booking } : {}),
      fromPublic: one.fromPublic === true,
      createdAt: one.createdAt,
      expiresAt: one.expiresAt,
      ...(one.revokedAt ? { revokedAt: one.revokedAt } : {}),
    });

    app.post<{ Params: { id: string } }>("/api/scheduling/bookings/:id/approval-link", async (request, reply) => {
      const principal = await requirePermission(policy, request, reply, "calendar.manage");
      if (!principal) return reply;
      try {
        const booking = await bookings.get(request.params.id);
        const waiting = (await tasks.list({ status: "waiting", limit: 500 })).find((one) => one.body.kind === "booking" && one.body.booking === booking.id);
        if (!waiting) return reply.status(409).send({ error: "Nothing is waiting for an answer on this booking." });
        const deadline = waiting.wait?.deadline ?? booking.holdUntil ?? new Date(Date.now() + 86_400_000).toISOString();
        const url = await links.approvalLink({ id: waiting.id, attempt: waiting.attempt }, booking, principal.userId, deadline);
        return { url, expiresAt: deadline };
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.post<{ Params: { id: string } }>("/api/scheduling/bookings/:id/link", async (request, reply) => {
      const principal = await requirePermission(policy, request, reply, "calendar.manage");
      if (!principal) return reply;
      try {
        return { url: await links.bookingLink(await bookings.get(request.params.id)) };
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.get<{ Params: { id: string } }>("/api/contacts/:id/links", async (request, reply) => {
      if (!(await requirePermission(policy, request, reply, "contacts.manage"))) return reply;
      return (await links.linksOf(request.params.id)).map(shown);
    });

    app.post<{ Params: { id: string }; Body: { type?: unknown } }>("/api/contacts/:id/links", async (request, reply) => {
      if (!(await requirePermission(policy, request, reply, "contacts.manage"))) return reply;
      const type = typeof request.body?.type === "string" && request.body.type.trim() ? request.body.type.trim() : undefined;
      try {
        const made = await links.contactLink(request.params.id, type ? { type } : {});
        return { url: made.url, link: shown(made.token) };
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.post<{ Params: { id: string; link: string } }>("/api/contacts/:id/links/:link/revoke", async (request, reply) => {
      if (!(await requirePermission(policy, request, reply, "contacts.manage"))) return reply;
      const revoked = await links.revoke(request.params.link, request.params.id);
      return revoked ? shown(revoked) : reply.status(404).send({ error: "There is no such link." });
    });
  };
