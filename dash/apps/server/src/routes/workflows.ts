import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { TASK_STATUSES, workflowInputSchema, workflowSchema, type AgentSpec, type TaskStatus } from "@freebirdai/dash-spec";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";
import { explainDraft } from "../workflows/draft.js";
import { CaseBusy } from "../workflows/engine.js";
import { buildOverview } from "../workflows/overview.js";
import { previewWorkflow } from "../workflows/run.js";
import { WorkflowError, type WorkflowService } from "../workflows/service.js";
import { StartError, startWorkflow, type Starter } from "../workflows/start.js";
import { TaskError, type TaskService } from "../workflows/tasks.js";
import { TemplateError, type TemplateService } from "../workflows/templates.js";

/**
 * Workflows, their cases and tasks, and templates (`workflows/`).
 *
 * Reading needs nothing beyond being in the workspace. Saving, running,
 * previewing, deciding on tasks and saving templates need `workflows.manage`
 * (owner, admin, editor), guarded in `identity/guard.ts` and asked again here.
 * A change to an account also needs the person's own permission for it, which
 * the write service asks when it prepares and commits.
 *
 * `POST /api/workflow-hooks/:workspace/:token` is the one route without a
 * person: the token, minted for one waiting case, is the authority. Its
 * address names its workspace, so a host holding several hands it to that
 * workspace's server with nobody signed in (`platform/workspaces.ts`), and
 * the identity hook lets it, and nothing else, through without a principal
 * (`identity/context.ts`).
 */
export const WORKFLOW_HOOK_ROUTE = "/api/workflow-hooks/:workspace/:token";

export const workflowRoutes = (deps: {
  readonly workflows: WorkflowService;
  readonly tasks: TaskService;
  readonly templates: TemplateService;
  readonly starter: Starter;
  readonly policy: Policy;
  readonly agents: () => Promise<AgentSpec[]>;
  readonly connectionTitle?: (id: string) => string;
}) =>
  async (app: FastifyInstance): Promise<void> => {
    const { workflows, tasks, templates, starter, policy } = deps;
    const { env, engine } = starter;
    const fail = (reply: FastifyReply, error: unknown) => {
      if (error instanceof WorkflowError) return reply.status(error.status).send({ error: error.message, ...(error.problems.length > 0 ? { problems: error.problems } : {}) });
      if (error instanceof TaskError) return reply.status(error.status).send({ error: error.message, ...error.extra });
      if (error instanceof TemplateError || error instanceof StartError) return reply.status(error.status).send({ error: error.message });
      if (error instanceof CaseBusy) return reply.status(409).send({ error: error.message });
      throw error;
    };
    const manage = (request: FastifyRequest, reply: FastifyReply) => requirePermission(policy, request, reply, "workflows.manage");
    /* A route that needs `workflows.manage`, with its failures answered in words. */
    const guarded =
      <T = unknown>(run: (principal: NonNullable<FastifyRequest["principal"]>, request: { readonly params: Record<string, string>; readonly body: T }) => Promise<unknown>) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (request: FastifyRequest<any>, reply: FastifyReply) => {
        const principal = await manage(request, reply);
        if (!principal) return reply;
        try {
          return await run(principal, { params: (request.params ?? {}) as Record<string, string>, body: request.body as T });
        } catch (error) {
          return fail(reply, error);
        }
      };

    /* ── workflows ────────────────────────────────────────────────── */

    app.get<{ Querystring: { startableBy?: string } }>("/api/workflows", async (request) =>
      request.query.startableBy === "agent" ? workflows.startableByAgent() : workflows.list(),
    );

    app.get<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
      const workflow = await workflows.get(request.params.id);
      if (!workflow) return reply.status(404).send({ error: `There is no workflow "${request.params.id}".` });
      const newer = await templates.newerFor(workflow);
      return { ...workflow, startedBy: (await workflows.startedBy(workflow.id)).map((agent) => agent.id), ...(newer ? { newerTemplate: { id: newer.id, version: newer.version } } : {}) };
    });

    /** Make (an id not in use) or change (its own id). */
    app.put<{ Params: { id: string }; Body: unknown }>(
      "/api/workflows/:id",
      guarded(async (principal, request) => {
        const held = await workflows.get(request.params["id"]!);
        return held ? workflows.update(principal, held.id, request.body as never) : workflows.create(principal, request.body as never);
      }),
    );

    app.post<{ Params: { id: string }; Body: { enabled?: unknown } }>(
      "/api/workflows/:id/enabled",
      guarded<{ enabled?: unknown }>(async (principal, request) => {
        if (typeof request.body?.enabled !== "boolean") throw new WorkflowError("Say { enabled: true } or { enabled: false }.", 400);
        return workflows.setEnabled(principal, request.params["id"]!, request.body.enabled);
      }),
    );

    app.delete<{ Params: { id: string } }>(
      "/api/workflows/:id",
      guarded(async (_principal, request) => {
        await workflows.remove(request.params["id"]!);
        return { removed: true, id: request.params["id"] };
      }),
    );

    /** Run now, by hand, as you. */
    app.post<{ Params: { id: string }; Body: { inputs?: Record<string, unknown> } }>(
      "/api/workflows/:id/run",
      guarded<{ inputs?: Record<string, unknown> } | undefined>(async (principal, request) => {
        const workflow = await workflows.get(request.params["id"]!);
        if (!workflow) throw new WorkflowError(`There is no workflow "${request.params["id"]}".`, 404);
        const { run } = await startWorkflow(starter, workflow, { kind: "manual", userId: principal.userId }, { inputs: request.body?.inputs ?? {}, actor: principal });
        return run;
      }),
    );

    /** The workflow as saved, or a draft (`{ workflow }`), as one id-less spec. */
    const draftOf = async (id: string, body: { workflow?: unknown } | undefined) => {
      const held = await workflows.get(id);
      if (body?.workflow === undefined) {
        if (!held) throw new WorkflowError(`There is no workflow "${id}".`, 404);
        return held;
      }
      const draft = workflowInputSchema.safeParse(body.workflow);
      if (!draft.success) throw new WorkflowError(draft.error.issues.map((one) => `${one.path.join(".")}: ${one.message}`).join("; "), 400);
      const at = new Date(env.now()).toISOString();
      return workflowSchema.parse({ ...held, ...draft.data, id: held?.id ?? "draft", createdAt: held?.createdAt ?? at, updatedAt: at });
    };

    /** A dry run, as you: what it would read, which records match, and each one's path. */
    app.post<{ Params: { id: string }; Body: { workflow?: unknown; inputs?: Record<string, unknown> } }>(
      "/api/workflows/:id/preview",
      guarded<{ workflow?: unknown; inputs?: Record<string, unknown> } | undefined>(async (principal, request) =>
        previewWorkflow(env, await draftOf(request.params["id"]!, request.body), principal, request.body?.inputs ?? {}),
      ),
    );

    /** What a draft is missing, what to suggest, and the one-sentence confirmation. Nothing is saved. */
    app.post<{ Params: { id: string }; Body: { workflow?: unknown } }>(
      "/api/workflows/:id/check",
      guarded<{ workflow?: unknown } | undefined>(async (principal, request) =>
        explainDraft(workflows, principal, await draftOf(request.params["id"]!, request.body), await deps.agents(), deps.connectionTitle ? { connection: deps.connectionTitle } : {}),
      ),
    );

    app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/workflows/:id/runs", async (request) =>
      env.store.runs({ workflow: request.params.id, limit: Number(request.query.limit) || 50 }),
    );

    app.get<{ Params: { id: string } }>("/api/workflows/:id/cases", async (request) => env.cases.list({ workflow: request.params.id }));

    app.get<{ Querystring: { limit?: string } }>("/api/workflow-runs", async (request) => env.store.runs({ limit: Number(request.query.limit) || 50 }));

    app.get<{ Querystring: { from?: string; to?: string } }>("/api/calendar/events", async (request) =>
      env.calendar.list({ ...(request.query.from ? { from: request.query.from } : {}), ...(request.query.to ? { to: request.query.to } : {}) }),
    );

    app.get("/api/overview", async () => buildOverview(env, { agents: await deps.agents() }));

    /* ── cases ────────────────────────────────────────────────────── */

    app.get<{ Params: { id: string } }>("/api/cases/:id", async (request, reply) => {
      const one = await env.cases.get(request.params.id);
      if (!one) return reply.status(404).send({ error: `There is no case "${request.params.id}".` });
      return { ...one, tasks: await env.tasks.list({ case: one.id }) };
    });

    app.post<{ Params: { id: string } }>(
      "/api/cases/:id/cancel",
      guarded(async (_principal, request) => engine.cancel(request.params["id"]!)),
    );

    /* ── tasks ────────────────────────────────────────────────────── */

    app.get<{ Querystring: { status?: string; workflow?: string; case?: string; limit?: string } }>("/api/tasks", async (request, reply) => {
      const { status } = request.query;
      if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status)) return reply.status(400).send({ error: `status is one of ${TASK_STATUSES.join(", ")}.` });
      return tasks.list({
        ...(status ? { status: status as TaskStatus } : {}),
        ...(request.query.workflow ? { workflow: request.query.workflow } : {}),
        ...(request.query.case ? { case: request.query.case } : {}),
        limit: Number(request.query.limit) || 200,
      });
    });

    app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => (await env.tasks.get(request.params.id)) ?? reply.status(404).send({ error: "There is no such task." }));

    /** Open a task waiting for approval: a change is prepared now, as you. */
    app.post<{ Params: { id: string } }>("/api/tasks/:id/review", guarded(async (principal, request) => tasks.review(principal, request.params["id"]!)));

    /** `{ pendingId, digest }` from the review, for a change; `{ always: true }` also makes the step automatic. */
    app.post<{ Params: { id: string }; Body: { pendingId?: string; digest?: string; always?: boolean } }>(
      "/api/tasks/:id/approve",
      guarded<{ pendingId?: string; digest?: string; always?: boolean } | undefined>(async (principal, request) =>
        tasks.approve(principal, request.params["id"]!, {
          ...(typeof request.body?.pendingId === "string" ? { pendingId: request.body.pendingId } : {}),
          ...(typeof request.body?.digest === "string" ? { digest: request.body.digest } : {}),
          ...(request.body?.always === true ? { always: true } : {}),
        }),
      ),
    );

    app.post<{ Params: { id: string } }>("/api/tasks/:id/decline", guarded(async (principal, request) => tasks.decline(principal, request.params["id"]!)));

    /** It happened: a send Dash was not sure of is marked done, and not sent again. */
    app.post<{ Params: { id: string } }>("/api/tasks/:id/settle", guarded(async (principal, request) => tasks.settle(principal, request.params["id"]!)));

    app.post<{ Params: { id: string }; Body: { answer?: unknown } }>(
      "/api/tasks/:id/answer",
      guarded<{ answer?: unknown }>(async (principal, request) => {
        if (typeof request.body?.answer !== "string" || request.body.answer.trim() === "") throw new TaskError("Say { answer }.", 400);
        return tasks.answer(principal, request.params["id"]!, request.body.answer.trim());
      }),
    );

    app.post<{ Params: { id: string } }>("/api/tasks/:id/complete", guarded(async (principal, request) => tasks.complete(principal, request.params["id"]!)));

    /** What Reverse would do: for an account change, its review, prepared now. */
    app.post<{ Params: { id: string } }>("/api/tasks/:id/reverse-review", guarded(async (principal, request) => tasks.reverseReview(principal, request.params["id"]!)));

    app.post<{ Params: { id: string }; Body: { pendingId?: string; digest?: string } }>(
      "/api/tasks/:id/reverse",
      guarded<{ pendingId?: string; digest?: string } | undefined>(async (principal, request) =>
        tasks.reverse(principal, request.params["id"]!, {
          ...(typeof request.body?.pendingId === "string" ? { pendingId: request.body.pendingId } : {}),
          ...(typeof request.body?.digest === "string" ? { digest: request.body.digest } : {}),
        }),
      ),
    );

    /* ── templates ────────────────────────────────────────────────── */

    app.get("/api/workflow-templates", async () => templates.list());

    /** `{ workflow, kind, name, steps?, blanks?, description? }`: save steps of a workflow as a template. */
    app.post<{ Body: { workflow?: string; kind?: "step" | "path" | "workflow"; name?: string; steps?: string[]; description?: string; blanks?: never } }>(
      "/api/workflow-templates",
      guarded<{ workflow?: string; kind?: "step" | "path" | "workflow"; name?: string; steps?: string[]; description?: string; blanks?: never }>(async (_principal, request) => {
        const body = request.body ?? {};
        if (!body.workflow || !body.kind || !body.name?.trim()) throw new TemplateError("Say which workflow, what kind of template, and its name.", 400);
        return templates.saveFrom({ workflow: body.workflow, kind: body.kind, name: body.name.trim(), ...(body.steps ? { steps: body.steps } : {}), ...(body.description ? { description: body.description } : {}), ...(body.blanks ? { blanks: body.blanks } : {}) });
      }),
    );

    app.delete<{ Params: { id: string } }>(
      "/api/workflow-templates/:id",
      guarded(async (_principal, request) => {
        await templates.remove(request.params["id"]!);
        return { removed: true };
      }),
    );

    /** The template's steps with blanks filled, ready to put in a workflow. Nothing is saved. */
    app.post<{ Params: { id: string }; Body: { values?: Record<string, string>; at?: { x: number; y: number } } }>(
      "/api/workflow-templates/:id/insert",
      guarded<{ values?: Record<string, string>; at?: { x: number; y: number } } | undefined>(async (_principal, request) =>
        templates.insert(request.params["id"]!, request.body?.values ?? {}, request.body?.at ?? { x: 0, y: 0 }),
      ),
    );

    /** A new workflow from a workflow template. Saved off. */
    app.post<{ Params: { id: string }; Body: { values?: Record<string, string>; name?: string } }>(
      "/api/workflow-templates/:id/workflow",
      guarded<{ values?: Record<string, string>; name?: string } | undefined>(async (principal, request) => {
        const { input, template } = await templates.workflowFrom(request.params["id"]!, request.body?.values ?? {}, request.body?.name);
        const made = await workflows.create(principal, input);
        const marked = { ...made, fromTemplate: { id: template.id, version: template.version } };
        await env.store.put(marked);
        return marked;
      }),
    );

    /* ── events ───────────────────────────────────────────────────── */

    /*
     * A webhook a waiting case was given: wakes it with the body sent. Anyone
     * may call it, so a call nothing waits on is not kept.
     */
    const wake = async (token: string, sent: unknown, reply: FastifyReply) => {
      if (!/^[a-zA-Z0-9]{16,64}$/.test(token)) return reply.status(404).send({ error: "Unknown hook." });
      const key = `hook:${token}`;
      if ((await env.cases.waitingOn(key)).length === 0) return reply.status(404).send({ error: "Nothing is waiting on this hook." });
      const body = sent && typeof sent === "object" ? (sent as Record<string, unknown>) : {};
      const woken = await engine.emit(key, body);
      return woken > 0 ? { woken } : reply.status(404).send({ error: "Nothing is waiting on this hook." });
    };

    /** The address a Wait step hands out. Another workspace's hook is not this one's, whoever sent it here. */
    app.post<{ Params: { workspace: string; token: string }; Body: unknown }>(WORKFLOW_HOOK_ROUTE, async (request, reply) =>
      request.params.workspace === env.workspaceId ? wake(request.params.token, request.body, reply) : reply.status(404).send({ error: "Unknown hook." }),
    );

    /** The address before it named its workspace: still answered by a server of one workspace, which needs no name. */
    app.post<{ Params: { token: string }; Body: unknown }>("/api/workflow-hooks/:token", async (request, reply) => wake(request.params.token, request.body, reply));

    /** Something happened that cases may wait on: `{ key, payload }`. Comms posts replies here as `reply:<conversation>`. */
    app.post<{ Body: { key?: unknown; payload?: Record<string, unknown> } }>(
      "/api/workflow-events",
      guarded<{ key?: unknown; payload?: Record<string, unknown> }>(async (_principal, request) => {
        if (typeof request.body?.key !== "string" || !request.body.key.trim()) throw new WorkflowError("Say which event: { key }.", 400);
        return { woken: await engine.emit(request.body.key, request.body.payload ?? {}) };
      }),
    );
  };
