import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { OnboardingError, OnboardingService } from "../onboarding.js";
import type { OnboardingDeps } from "../onboarding.js";

export const onboardingRoutes = (app: FastifyInstance, deps: OnboardingDeps): void => {
  const service = new OnboardingService(deps);
  const route = (
    method: "GET" | "POST" | "PUT",
    suffix: string,
    run: (id: string, body: unknown) => unknown,
  ) => {
    app.route<{ Params: { id: string }; Body: unknown }>({
      method,
      url: `/api/connections/:id/onboarding${suffix}`,
      handler: async (request, reply) => {
        try {
          return await run(request.params.id, request.body);
        } catch (error) {
          if (error instanceof OnboardingError)
            return reply.status(error.status).send({ error: error.message });
          if (error instanceof z.ZodError)
            return reply
              .status(400)
              .send({ error: "Invalid onboarding choices.", detail: error.issues });
          request.log.error(error);
          return reply
            .status(500)
            .send({
              error: "Dashboard setup could not finish. Your progress is saved; retry to continue.",
            });
        }
      },
    });
  };
  route("GET", "", (id) => service.status(id));
  route("POST", "/prepare", (id) => service.prepare(id));
  route("PUT", "/choices", (id, body) => service.choose(id, body));
  route("POST", "/preview", (id) => service.preview(id));
  route("POST", "/skip", (id) => service.skip(id));
  route("POST", "/restart", (id) => service.restart(id));
  route("POST", "/commit", async (id, body) => ({
    dashboardIds: await service.commit(
      id,
      z.object({ previewId: z.string() }).parse(body).previewId,
    ),
  }));
};
