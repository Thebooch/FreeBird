import { BOOKING_STATUSES, type BookingStatus } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BookingError, type BookingService } from "../bookings/service.js";
import { ContactError } from "../contacts/service.js";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";
import { SchedulingError } from "../scheduling/service.js";

/**
 * Bookings, signed in: `/api/scheduling/bookings*` and `/api/scheduling/slots`.
 *
 * Anyone in the workspace can read them, as they can the calendar. Booking
 * for a contact and every decision on a booking need `calendar.manage`,
 * guarded in `identity/guard.ts` and asked again here. Each change answers
 * with the booking as it now is; a time that was taken answers 409 with open
 * times nearby (`detail.slots`).
 */
export const bookingRoutes = (deps: { readonly bookings: BookingService; readonly policy: Policy }) =>
  async (app: FastifyInstance): Promise<void> => {
    const { bookings, policy } = deps;
    const answer = (reply: FastifyReply, error: unknown) => {
      if (error instanceof BookingError) return reply.status(error.status).send({ error: error.message, ...(error.slots ? { detail: { slots: error.slots } } : {}) });
      if (error instanceof ContactError || error instanceof SchedulingError) return reply.status(error.status).send({ error: error.message });
      throw error;
    };
    const decide =
      (run: (principal: NonNullable<FastifyRequest["principal"]>, id: string, body: Record<string, unknown>) => Promise<unknown>) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = await requirePermission(policy, request, reply, "calendar.manage");
        if (!principal) return reply;
        try {
          const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
          return await run(principal, ((request.params ?? {}) as Record<string, string>)["id"] ?? "", body);
        } catch (error) {
          return answer(reply, error);
        }
      };
    const text = (body: Record<string, unknown>, key: string): string | undefined => (typeof body[key] === "string" && (body[key] as string).trim() ? (body[key] as string).trim() : undefined);
    const instant = (body: Record<string, unknown>, key: string): number => {
      const value = body[key];
      const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(at)) throw new BookingError(`Say when, as an instant: ${key}.`);
      return at;
    };
    const as = (principal: { userId: string }) => ({ kind: "member" as const, id: principal.userId });

    app.get<{ Querystring: Record<string, string | undefined> }>("/api/scheduling/bookings", async (request, reply) => {
      const query = request.query;
      const from = query.from ? Date.parse(query.from) : undefined;
      const to = query.to ? Date.parse(query.to) : undefined;
      if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) return reply.status(400).send({ error: "from and to are instants." });
      const statuses = query.status ? query.status.split(",").filter((one): one is BookingStatus => (BOOKING_STATUSES as readonly string[]).includes(one)) : undefined;
      return bookings.list({
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(query.host ? { host: query.host } : {}),
        ...(query.contact ? { contact: query.contact } : {}),
        ...(statuses && statuses.length > 0 ? { statuses } : {}),
        limit: Math.min(Number(query.limit) || 200, 1000),
      });
    });
    app.get<{ Params: { id: string } }>("/api/scheduling/bookings/:id", async (request, reply) => {
      try {
        return await bookings.get(request.params.id);
      } catch (error) {
        return answer(reply, error);
      }
    });

    /* A member books for a contact: confirmed unless they ask for approval. */
    app.post(
      "/api/scheduling/bookings",
      decide(async (principal, _id, body) => {
        const type = text(body, "type");
        const contact = text(body, "contact");
        if (!type || !contact) throw new BookingError("Say the appointment type and the contact.");
        return bookings.request({
          type,
          contact,
          start: instant(body, "start"),
          ...(text(body, "host") ? { host: text(body, "host")! } : {}),
          ...(body["answers"] && typeof body["answers"] === "object" ? { answers: body["answers"] as Record<string, unknown> } : {}),
          approval: body["approval"] === "always" ? "always" : "skip",
          origin: "member",
          by: as(principal),
        });
      }),
    );
    app.post("/api/scheduling/bookings/:id/confirm", decide(async (principal, id, body) => bookings.confirm(id, as(principal), { ...(text(body, "message") ? { message: text(body, "message")! } : {}) })));
    app.post(
      "/api/scheduling/bookings/:id/suggest",
      decide(async (principal, id, body) => {
        const times = Array.isArray(body["times"]) ? (body["times"] as Array<Record<string, unknown>>) : [];
        return bookings.suggest(
          id,
          as(principal),
          times.map((one) => ({ start: instant(one, "start"), ...(text(one, "host") ? { host: text(one, "host")! } : {}) })),
          {
            ...(text(body, "message") ? { message: text(body, "message")! } : {}),
            ...(text(body, "reason") ? { reason: text(body, "reason")! } : {}),
            allowOutside: body["allowOutside"] === true,
          },
        );
      }),
    );
    app.post(
      "/api/scheduling/bookings/:id/deny",
      decide(async (principal, id, body) => bookings.deny(id, as(principal), { ...(text(body, "reason") ? { reason: text(body, "reason")! } : {}), ...(text(body, "message") ? { message: text(body, "message")! } : {}) })),
    );
    app.post("/api/scheduling/bookings/:id/cancel", decide(async (principal, id, body) => bookings.cancel(id, as(principal), { ...(text(body, "reason") ? { reason: text(body, "reason")! } : {}) })));
    app.post("/api/scheduling/bookings/:id/move", decide(async (principal, id, body) => bookings.move(id, as(principal), { start: instant(body, "start"), ...(text(body, "host") ? { host: text(body, "host")! } : {}) })));
    app.post("/api/scheduling/bookings/:id/assign", decide(async (principal, id, body) => bookings.assign(id, as(principal), text(body, "host"))));
    app.post(
      "/api/scheduling/bookings/:id/mark",
      decide(async (principal, id, body) => {
        const mark = body["as"];
        if (mark !== "completed" && mark !== "no_show") throw new BookingError('Mark it "completed" or "no_show".');
        return bookings.mark(id, as(principal), mark);
      }),
    );

    /* Open times for a type and a contact, as they would be offered. */
    app.get<{ Querystring: Record<string, string | undefined> }>("/api/scheduling/slots", async (request, reply) => {
      const query = request.query;
      if (!query.type || !query.contact) return reply.status(400).send({ error: "Say the type and the contact." });
      const from = query.from ? Date.parse(query.from) : Date.now();
      const to = query.to ? Date.parse(query.to) : from + 14 * 86_400_000;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 62 * 86_400_000) return reply.status(400).send({ error: "from and to are instants, at most 62 days apart." });
      try {
        return await bookings.slotsFor(query.type, query.contact, { from, to, all: query.all === "1" });
      } catch (error) {
        return answer(reply, error);
      }
    });
  };
