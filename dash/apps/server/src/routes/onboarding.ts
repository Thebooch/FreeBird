import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  OnboardingError,
  OnboardingService,
  categoryState,
  type OnboardingDeps,
  type PrepareStep,
} from "../onboarding/service.js";

export { categoryState, offersFor } from "../onboarding/service.js";

/**
 * The routes onboarding talks through. All of the logic lives in
 * `OnboardingService`; these only translate.
 *
 * Connection-scoped, one route per step, so each request is short and a
 * screen can be closed and reopened at any point without losing its place:
 *
 * - `GET  /api/connections/:id/onboarding` — where setup stands. Free.
 * - `POST …/prepare` — one step of preparing the integration behind it.
 *   Repeat until `state.remaining` is zero. Model tokens, no API requests.
 * - `PUT  …/choices` — `{ categories, layout }`.
 * - `POST …/preview` — the boards as they would be, checked against the
 *   account. Bounded reads, through the same cache the boards will use.
 * - `POST …/commit` — `{ previewId }`. Creates exactly what was previewed.
 * - `POST …/skip`, `POST …/restart` — not now, and another set.
 *
 * The catalog routes stay for anything that wants a whole API prepared in
 * one call — a script, an evaluation run.
 */

const send = (reply: FastifyReply, error: unknown): FastifyReply | undefined => {
  if (error instanceof OnboardingError) {
    return reply
      .status(error.status)
      .send({ error: error.message, ...(error.detail ? { notes: error.detail } : {}) });
  }
  return undefined;
};

export const onboardingRoutes =
  (deps: OnboardingDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    const service = new OnboardingService(deps);

    const route = (
      method: "GET" | "POST" | "PUT",
      suffix: string,
      run: (id: string, body: unknown) => unknown,
    ): void => {
      app.route<{ Params: { id: string }; Body: unknown }>({
        method,
        url: `/api/connections/:id/onboarding${suffix}`,
        handler: async (request, reply) => {
          try {
            return await run(request.params.id, request.body);
          } catch (error) {
            const sent = send(reply, error);
            if (sent) return sent;
            request.log.error(error);
            return reply.status(500).send({
              error: "Dashboard setup could not finish. Your progress is saved; try again to continue.",
            });
          }
        },
      });
    };

    route("GET", "", (id) => service.status(id));
    route("POST", "/prepare", (id) => service.prepare(id));
    route("PUT", "/choices", (id, body) => service.choose(id, body));
    route("POST", "/preview", (id) => service.preview(id));
    route("POST", "/commit", (id, body) => {
      const parsed = z.object({ previewId: z.string().min(1) }).safeParse(body);
      if (!parsed.success) throw new OnboardingError("Say which preview to create.", 400);
      return service.commit(id, parsed.data.previewId);
    });
    route("POST", "/skip", (id) => service.skip(id));
    route("POST", "/restart", (id) => service.restart(id));

    /**
     * What is known about this API's divisions. Free — it reads the entry.
     */
    app.get<{ Params: { id: string } }>("/api/catalog/:id/categories", async (request, reply) => {
      if (!deps.catalog) return reply.status(501).send({ error: "no catalog configured" });
      const entry = deps.catalog.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "no such catalog entry" });
      return {
        ...categoryState(entry),
        canRun: deps.llm() !== null,
        ...(entry.profile ? { profile: entry.profile } : {}),
        categoryList: entry.categories ?? [],
      };
    });

    /**
     * Prepare the whole API in one call: every step `…/prepare` would take,
     * back to back, stopping at the first that fails.
     *
     * Costs model tokens and **zero requests against anybody's API**.
     */
    app.post<{ Params: { id: string } }>("/api/catalog/:id/categories", async (request, reply) => {
      if (!deps.catalog) return reply.status(501).send({ error: "no catalog configured" });
      const entry = deps.catalog.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "no such catalog entry" });

      const steps: PrepareStep[] = [];
      try {
        /* Bounded: a step either finishes something or reports why not. */
        const limit = (entry.categories ?? []).length + 25;
        for (let turn = 0; turn < limit; turn++) {
          const step = await service.prepareEntry(entry.id);
          if (step.step === "none") break;
          steps.push(step);
          if (!step.ok) break;
        }
      } catch (error) {
        const sent = send(reply, error);
        if (sent) return sent;
        throw error;
      }

      const saved = deps.catalog.get(entry.id) ?? entry;
      const errors = steps.flatMap((step) => (step.error ? [step.error] : []));
      return {
        ...categoryState(saved),
        ranPass: steps.length > 0,
        ...(steps.length === 0
          ? { note: "this API is already divided up, and every part has a starting dashboard" }
          : {}),
        ...(saved.profile ? { profile: saved.profile } : {}),
        categoryList: saved.categories ?? [],
        /* Proposed against kept. The difference is the honest part: a widget
         * the compiler refused is one that would not have worked. */
        proposed: steps.reduce((sum, step) => sum + step.proposed, 0),
        kept: steps.reduce((sum, step) => sum + step.kept, 0),
        uncategorised: steps.flatMap((step) => step.uncategorised),
        errors,
        skipped: steps.flatMap((step) => step.skipped),
      };
    });
  };
