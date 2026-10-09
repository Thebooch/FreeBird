import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ReportError, type ReportService } from "../reports/service.js";
import type { RateLimiter } from "../public/limits.js";

/**
 * Timed reports and tracked values (`reports/`).
 *
 * Reading needs nothing beyond being in the workspace. Making, changing,
 * previewing and sending need `boards.edit`, guarded in `identity/guard.ts`.
 *
 * - `GET /api/reports?dashboard=`: the reports (those drawing from one tab), and whether email is set up.
 * - `POST /api/reports`, `GET|PUT|DELETE /api/reports/:id`
 * - `POST /api/reports/preview`: the email a draft would send, sent nowhere.
 * - `POST /api/reports/:id/send`: send it now. `GET /api/reports/:id/sends`: its log.
 * - `GET|POST /api/tracked`, `GET|PUT|DELETE /api/tracked/:id`, `GET /api/tracked/:id/history`
 *
 * And one public page, reached from the email with nobody signed in: a
 * recipient's unsubscribe link. Opening it asks; only the button changes
 * anything, so a mail scanner that follows links unsubscribes nobody.
 */
export const reportRoutes = (deps: { readonly reports: ReportService; readonly workspace: string; readonly limiter: RateLimiter }) =>
  async (app: FastifyInstance): Promise<void> => {
    const { reports } = deps;
    const answer =
      <P extends Record<string, string> = Record<string, string>>(run: (request: FastifyRequest<{ Params: P; Body: unknown; Querystring: Record<string, string | undefined> }>) => Promise<unknown>) =>
      async (request: FastifyRequest<{ Params: P; Body: unknown; Querystring: Record<string, string | undefined> }>, reply: FastifyReply) => {
        try {
          return await run(request);
        } catch (error) {
          if (error instanceof ReportError) return reply.status(error.status).send({ error: error.message });
          throw error;
        }
      };

    app.get(
      "/api/reports",
      answer(async (request) => {
        const dashboard = request.query?.dashboard?.trim();
        const list = await reports.list(dashboard || undefined);
        return { reports: list.map((one) => ({ ...one, nextAt: nextAt(reports, one) })), email: reports.emailStatus() };
      }),
    );
    app.post("/api/reports", answer(async (request) => reports.create(request.principal ?? null, request.body)));
    app.post("/api/reports/preview", answer(async (request) => reports.preview(request.body)));
    app.get("/api/reports/:id", answer<{ id: string }>(async (request) => {
      const report = await reports.get(request.params.id);
      return { ...report, nextAt: nextAt(reports, report), sends: await reports.sends(report.id, 20) };
    }));
    app.put("/api/reports/:id", answer<{ id: string }>(async (request) => reports.update(request.params.id, request.body)));
    app.delete("/api/reports/:id", answer<{ id: string }>(async (request) => reports.remove(request.params.id)));
    app.post("/api/reports/:id/send", answer<{ id: string }>(async (request) => reports.send(request.params.id, "manual")));
    app.get("/api/reports/:id/sends", answer<{ id: string }>(async (request) => reports.sends(request.params.id, 100)));

    app.get("/api/tracked", answer(async () => reports.listTracked()));
    app.post("/api/tracked", answer(async (request) => reports.createTracked(request.body)));
    app.get("/api/tracked/:id", answer<{ id: string }>(async (request) => reports.getTracked(request.params.id)));
    app.put("/api/tracked/:id", answer<{ id: string }>(async (request) => reports.updateTracked(request.params.id, request.body)));
    app.delete("/api/tracked/:id", answer<{ id: string }>(async (request) => reports.removeTracked(request.params.id)));
    app.get("/api/tracked/:id/history", answer<{ id: string }>(async (request) => reports.trackedHistory(request.params.id)));

    /* ── the unsubscribe page ─────────────────────────────────────────── */

    const open = { config: { public: true } } as const;
    type Params = { workspace: string; token: string };
    const page = (reply: FastifyReply, status: number, title: string, body: string) =>
      reply
        .status(status)
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head>` +
            `<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;color:#111827;">` +
            `<main style="max-width:440px;margin:64px auto;padding:28px;background:#fff;border-radius:10px;"><h1 style="font-size:20px;margin:0 0 12px;">${escape(title)}</h1>${body}</main></body></html>`,
        );
    const guard = (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply): boolean => {
      if (request.params.workspace !== deps.workspace) {
        void page(reply, 404, "Not found", "<p>This link isn't valid.</p>");
        return false;
      }
      if (!deps.limiter.take(`report-unsubscribe:${request.ip}`, request.method === "POST" ? 30 : 120)) {
        void reply.header("Retry-After", "60");
        void page(reply, 429, "Too many requests", "<p>Wait a minute, then try again.</p>");
        return false;
      }
      return true;
    };

    app.get<{ Params: Params }>("/api/public/:workspace/reports/unsubscribe/:token", open, async (request, reply) => {
      if (!guard(request, reply)) return reply;
      try {
        const target = await reports.unsubscribeTarget(request.params.token);
        if (target.done) return page(reply, 200, "You're unsubscribed", `<p>${escape(target.email)} no longer gets <strong>${escape(target.report)}</strong>.</p>`);
        return page(
          reply,
          200,
          "Unsubscribe?",
          `<p>Stop sending <strong>${escape(target.report)}</strong> to ${escape(target.email)}?</p>` +
            `<form method="post"><button type="submit" style="font:inherit;padding:10px 16px;border:0;border-radius:6px;background:#111827;color:#fff;cursor:pointer;">Unsubscribe</button></form>`,
        );
      } catch (error) {
        if (error instanceof ReportError) return page(reply, error.status, "This link doesn't work", `<p>${escape(error.message)}</p>`);
        throw error;
      }
    });

    app.post<{ Params: Params }>("/api/public/:workspace/reports/unsubscribe/:token", open, async (request, reply) => {
      if (!guard(request, reply)) return reply;
      try {
        const done = await reports.unsubscribe(request.params.token);
        return page(reply, 200, "You're unsubscribed", `<p>${escape(done.email)} no longer gets <strong>${escape(done.report)}</strong>.</p>`);
      } catch (error) {
        if (error instanceof ReportError) return page(reply, error.status, "This link doesn't work", `<p>${escape(error.message)}</p>`);
        throw error;
      }
    });
  };

const nextAt = (reports: ReportService, report: Parameters<ReportService["nextDue"]>[0]): string | null => {
  const due = reports.nextDue(report);
  return due === null ? null : new Date(due).toISOString();
};

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
