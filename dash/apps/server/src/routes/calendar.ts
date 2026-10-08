import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";
import { CalendarError, listOptionsOf, type CalendarService } from "../calendar/service.js";

/**
 * The calendar (`calendar/`).
 *
 * Reading needs nothing beyond being in the workspace. Adding, changing,
 * finishing and removing entries need `calendar.manage` (owner, admin,
 * editor), guarded in `identity/guard.ts` and asked again here. Appointments
 * are changed through their bookings, never here.
 */
export const calendarRoutes = (deps: { readonly calendar: CalendarService; readonly policy: Policy }) =>
  async (app: FastifyInstance): Promise<void> => {
    const { calendar, policy } = deps;
    const guarded =
      <T = unknown>(run: (principal: NonNullable<FastifyRequest["principal"]>, request: { readonly params: Record<string, string>; readonly body: T }) => Promise<unknown>) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = await requirePermission(policy, request, reply, "calendar.manage");
        if (!principal) return reply;
        try {
          return await run(principal, { params: (request.params ?? {}) as Record<string, string>, body: request.body as T });
        } catch (error) {
          if (error instanceof CalendarError) return reply.status(error.status).send({ error: error.message });
          throw error;
        }
      };

    app.get<{ Querystring: Record<string, string | undefined> }>("/api/calendar", async (request) => calendar.list(listOptionsOf(request.query ?? {})));
    /* The address step 2 served the list at, kept so nothing that called it breaks. */
    app.get<{ Querystring: Record<string, string | undefined> }>("/api/calendar/events", async (request) => calendar.list(listOptionsOf(request.query ?? {})));

    app.get<{ Params: { id: string } }>("/api/calendar/:id", async (request, reply) => {
      try {
        return await calendar.get(request.params.id);
      } catch (error) {
        if (error instanceof CalendarError) return reply.status(error.status).send({ error: error.message });
        throw error;
      }
    });

    app.post<{ Body: unknown }>("/api/calendar", guarded(async (principal, request) => calendar.create(principal, request.body)));

    app.put<{ Params: { id: string }; Body: unknown }>(
      "/api/calendar/:id",
      guarded(async (principal, request) => calendar.update(principal, request.params["id"]!, request.body)),
    );

    app.post<{ Params: { id: string }; Body: { status?: unknown } }>(
      "/api/calendar/:id/status",
      guarded<{ status?: unknown } | undefined>(async (principal, request) => calendar.setStatus(principal, request.params["id"]!, request.body?.status)),
    );

    app.delete<{ Params: { id: string } }>(
      "/api/calendar/:id",
      guarded(async (principal, request) => calendar.remove(principal, request.params["id"]!)),
    );
  };
