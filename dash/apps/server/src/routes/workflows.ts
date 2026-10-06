import type { FastifyInstance, FastifyReply } from "fastify";
import { PROPOSAL_STATUSES, workflowInputSchema, workflowSchema, type ProposalStatus } from "@freebirdai/dash-spec";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";
import { ProposalError, type ProposalService } from "../workflows/proposals.js";
import { previewWorkflow } from "../workflows/run.js";
import { WorkflowError, type WorkflowService } from "../workflows/service.js";
import { StartError, startWorkflow, type Starter } from "../workflows/start.js";

/**
 * Workflows, their runs, and what waits for a person (`workflows/`).
 *
 * Reading needs nothing beyond being in the workspace. Saving, running,
 * previewing and deciding on proposals need `workflows.manage` (owner, admin,
 * editor), guarded in `identity/guard.ts` and asked again here. Applying a
 * change also needs the person's own permission for it, which the write
 * service asks when it prepares and commits.
 */
export const workflowRoutes = (deps: {
  readonly workflows: WorkflowService;
  readonly proposals: ProposalService;
  readonly starter: Starter;
  readonly policy: Policy;
}) =>
  async (app: FastifyInstance): Promise<void> => {
    const { workflows, proposals, starter, policy } = deps;
    const fail = (reply: FastifyReply, error: unknown) => {
      if (error instanceof WorkflowError) {
        return reply.status(error.status).send({ error: error.message, ...(error.problems.length > 0 ? { problems: error.problems } : {}) });
      }
      if (error instanceof ProposalError) return reply.status(error.status).send({ error: error.message, ...error.extra });
      if (error instanceof StartError) return reply.status(error.status).send({ error: error.message });
      throw error;
    };
    const manage = (request: Parameters<typeof requirePermission>[1], reply: FastifyReply) =>
      requirePermission(policy, request, reply, "workflows.manage");

    /** `?startableBy=agent`: the workflows an agent's tool can start. */
    app.get<{ Querystring: { startableBy?: string } }>("/api/workflows", async (request) =>
      request.query.startableBy === "agent" ? workflows.startableByAgent() : workflows.list(),
    );

    app.get<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
      const workflow = await workflows.get(request.params.id);
      if (!workflow) return reply.status(404).send({ error: `There is no workflow "${request.params.id}".` });
      return { ...workflow, startedBy: (await workflows.startedBy(workflow.id)).map((agent) => agent.id) };
    });

    /** Make (an id not in use) or change (its own id). The server picks the id it keeps. */
    app.put<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id", async (request, reply) => {
      const principal = await manage(request, reply);
      if (!principal) return reply;
      try {
        const held = await workflows.get(request.params.id);
        return held
          ? await workflows.update(principal, request.params.id, request.body as never)
          : await workflows.create(principal, request.body as never);
      } catch (error) {
        return fail(reply, error);
      }
    });

    /** `{ enabled }`: turn on or off. Turning on makes you the person it runs as. */
    app.post<{ Params: { id: string }; Body: { enabled?: unknown } }>("/api/workflows/:id/enabled", async (request, reply) => {
      const principal = await manage(request, reply);
      if (!principal) return reply;
      if (typeof request.body?.enabled !== "boolean") return reply.status(400).send({ error: "Say { enabled: true } or { enabled: false }." });
      try {
        return await workflows.setEnabled(principal, request.params.id, request.body.enabled);
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.delete<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
      const principal = await manage(request, reply);
      if (!principal) return reply;
      try {
        await workflows.remove(request.params.id);
        return { removed: true, id: request.params.id };
      } catch (error) {
        return fail(reply, error);
      }
    });

    /** Run now, by hand, as you. `{ inputs }` for a workflow that takes them. */
    app.post<{ Params: { id: string }; Body: { inputs?: Record<string, unknown> } | undefined }>("/api/workflows/:id/run", async (request, reply) => {
      const principal = await manage(request, reply);
      if (!principal) return reply;
      const workflow = await workflows.get(request.params.id);
      if (!workflow) return reply.status(404).send({ error: `There is no workflow "${request.params.id}".` });
      try {
        const { run } = await startWorkflow(starter, workflow, { kind: "manual", userId: principal.userId }, {
          inputs: request.body?.inputs ?? {},
          actor: principal,
        });
        return run;
      } catch (error) {
        return fail(reply, error);
      }
    });

    /**
     * A dry run, as you: what it would read, which rows match, and each row's
     * path. `{ workflow }` previews an unsaved draft in place of the saved one.
     */
    app.post<{ Params: { id: string }; Body: { workflow?: unknown; inputs?: Record<string, unknown> } | undefined }>(
      "/api/workflows/:id/preview",
      async (request, reply) => {
        const principal = await manage(request, reply);
        if (!principal) return reply;
        const held = await workflows.get(request.params.id);
        let workflow = held;
        if (request.body?.workflow !== undefined) {
          const draft = workflowInputSchema.safeParse(request.body.workflow);
          if (!draft.success) return reply.status(400).send({ error: draft.error.issues.map((one) => `${one.path.join(".")}: ${one.message}`).join("; ") });
          const at = new Date().toISOString();
          workflow = workflowSchema.parse({ ...held, ...draft.data, id: held?.id ?? "draft", createdAt: held?.createdAt ?? at, updatedAt: at });
        }
        if (!workflow) return reply.status(404).send({ error: `There is no workflow "${request.params.id}".` });
        return previewWorkflow(starter.env, workflow, principal, request.body?.inputs ?? {});
      },
    );

    app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/workflows/:id/runs", async (request) =>
      starter.env.store.runs({ workflow: request.params.id, limit: Number(request.query.limit) || 50 }),
    );

    /** Every workflow's runs, newest first: the completed-work feed. */
    app.get<{ Querystring: { limit?: string } }>("/api/workflow-runs", async (request) =>
      starter.env.store.runs({ limit: Number(request.query.limit) || 50 }),
    );

    /** Calendar entries steps made, in time order. The calendar view (step 4) reads these. */
    app.get<{ Querystring: { from?: string; to?: string } }>("/api/calendar/events", async (request) =>
      starter.env.calendar.list({ ...(request.query.from ? { from: request.query.from } : {}), ...(request.query.to ? { to: request.query.to } : {}) }),
    );

    /* ── waiting for you ──────────────────────────────────────────────── */

    app.get<{ Querystring: { status?: string; workflow?: string } }>("/api/proposals", async (request, reply) => {
      const status = request.query.status;
      if (status !== undefined && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
        return reply.status(400).send({ error: `status is one of ${PROPOSAL_STATUSES.join(", ")}.` });
      }
      return proposals.list({ ...(status ? { status: status as ProposalStatus } : {}), ...(request.query.workflow ? { workflow: request.query.workflow } : {}) });
    });

    /** Open one: a change is prepared now, as you, and its review returned. */
    app.post<{ Params: { id: string } }>("/api/proposals/:id/review", async (request, reply) => {
      const principal = await manage(request, reply);
      if (!principal) return reply;
      try {
        return await proposals.review(principal, request.params.id);
      } catch (error) {
        return fail(reply, error);
      }
    });

    /** `{ pendingId, digest }` from the review, for a change. Nothing for a request to start a workflow. */
    app.post<{ Params: { id: string }; Body: { pendingId?: string; digest?: string } | undefined }>("/api/proposals/:id/apply", async (request, reply) => {
      const principal = await manage(request, reply);
      if (!principal) return reply;
      try {
        return await proposals.apply(principal, request.params.id, {
          ...(typeof request.body?.pendingId === "string" ? { pendingId: request.body.pendingId } : {}),
          ...(typeof request.body?.digest === "string" ? { digest: request.body.digest } : {}),
        });
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.post<{ Params: { id: string } }>("/api/proposals/:id/dismiss", async (request, reply) => {
      const principal = await manage(request, reply);
      if (!principal) return reply;
      try {
        return await proposals.dismiss(principal, request.params.id);
      } catch (error) {
        return fail(reply, error);
      }
    });
  };
