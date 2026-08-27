import type { ConciergeContext, ConciergeDraft } from "@freebirdai/dash-agent";
import {
  EFFECT_STEPS,
  applyStep,
  buildFromDraft,
  newDraft,
  nextStep,
  readiness,
  revise,
  skipStep,
} from "@freebirdai/dash-agent";
import type { DashboardSpec, FilterDecl } from "@freebirdai/dash-spec";
import { settleDetail } from "../concierge/detail.js";
import type { DetailPlanRequest, DetailSetup } from "../concierge/detail.js";
import { parseWidget, widgetShapeSchema } from "@freebirdai/dash-spec";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conciergeState } from "../concierge/state.js";
import type { DraftStore } from "../concierge/store.js";

/**
 * Guided setup over HTTP, with no model involved.
 *
 * This is what "degrade to the deterministic wizard" actually means. The chat
 * actions and these routes drive the *same* draft through the *same* pure
 * machine; the difference is only who chooses. With an AI key the assistant
 * reads someone's intent and picks among the options; without one, the card in
 * the chat column posts the choice itself and everything still works.
 *
 * Nothing here reads an upstream API. Every question comes from a capability
 * report already on disk, which is why a whole widget can be designed without
 * spending a request.
 */

const startSchema = z.object({
  intent: z.string().max(2_000).optional(),
  /**
   * Who drives.
   *
   * The card posts `wizard`, because without a model there is nobody to
   * propose anything. The chat posts `assisted`.
   */
  mode: z.enum(["assisted", "wizard"]).default("wizard"),
});

/**
 * A whole widget in one patch.
 *
 * Nested on purpose — this is a REST body, not a model tool schema, so the
 * flat-subset rule does not apply here. The chat action's own schema is the
 * flat one, and both funnel into the same `revise`.
 */
/**
 * Exported so a test can assert what it declares.
 *
 * Zod strips unknown keys, so a patch field this schema omits arrives as a
 * no-op that reports success — which is how `joinWith` was silently dropped
 * for a release and looked like a revise that simply did nothing.
 */
export const reviseSchema = z.object({
  connection: z.string().max(120).optional(),
  endpoint: z.string().max(120).optional(),
  join: z.string().max(200).optional(),
  component: z.string().max(64).optional(),
  /*
   * What the widget counts, and what it is broken up by.
   *
   * Declared here or silently dropped: zod strips unknown keys, so a patch
   * carrying a field this schema has not heard of arrives as a no-op that
   * reports success. That exact trap swallowed `joinWith` once already.
   */
  measure: z.string().max(200).optional(),
  groupBy: z.string().max(200).optional(),
  /** Whether to take a measurement that costs requests: include or skip. */
  offer: z.enum(["include", "skip"]).optional(),
  /** Which of two readings of the request was meant, as an endpoint id. */
  choice: z.string().max(200).optional(),
  roles: z.record(z.string().max(64), z.array(z.string().max(200)).max(40)).optional(),
  controls: z.array(z.string().max(64)).max(20).optional(),
  drilldown: z.string().max(120).optional(),
  drilldownFields: z.array(z.string().max(200)).max(40).optional(),
  extras: z.array(z.string().max(200)).max(40).optional(),
  highlights: z.array(z.string().max(120)).max(8).optional(),
  title: z.string().max(120).optional(),
  /** Which model proposed this, recorded on the widget it builds. */
  model: z.string().max(120).optional(),
  /**
   * The whole measurement at once, and the sides drawn beside it.
   *
   * All three declared here or silently dropped — the same trap that swallowed
   * `joinWith` and made it look like a no-op that reported success. A schema
   * that has not heard of a field discards it and says nothing.
   */
  shape: widgetShapeSchema.optional(),
  seriesWith: z
    .array(
      z.object({
        endpoint: z.string().max(120),
        label: z.string().max(80),
        shape: widgetShapeSchema,
        fanOut: z
          .object({
            from: z.string().max(120),
            field: z.string().max(200),
            as: z.string().max(120).optional(),
            maxRows: z.number().int().min(1).max(100).optional(),
          })
          .optional(),
      }),
    )
    .max(3)
    .optional(),
  offerSeries: z
    .object({
      endpoint: z.string().max(120),
      label: z.string().max(80),
      shape: widgetShapeSchema,
      fanOut: z.object({
        from: z.string().max(120),
        field: z.string().max(200),
        as: z.string().max(120).optional(),
        maxRows: z.number().int().min(1).max(100).optional(),
      }),
    })
    .optional(),
  /** A join the caller worked out, rather than one the report found. */
  joinWith: z
    .object({
      endpoint: z.string().max(120),
      leftField: z.string().max(200),
      rightField: z.string().max(200),
      kind: z.enum(["inner", "left"]).optional(),
    })
    .optional(),
  skip: z.array(z.string().max(64)).max(20).optional(),
});

const answerSchema = z.object({
  stepId: z.string().min(1).max(64),
  values: z.array(z.string().max(200)).max(40).default([]),
  skip: z.boolean().default(false),
});

const confirmSchema = z.object({ title: z.string().max(120).optional() });

export interface ConciergeRouteDeps {
  readonly drafts: DraftStore;
  /** Rebuilt per request from what is on disk, so a new read is visible at once. */
  readonly context: () => ConciergeContext;
  readonly getDashboard: (id: string) => DashboardSpec | null;
  readonly putDashboard: (spec: DashboardSpec) => void;
  /**
   * Enumerate a connection for real, spending requests against someone's API.
   *
   * The only thing in this file that costs anything, and it runs on exactly one
   * path: an explicit yes to a card that stated the price. Returns a message
   * when it could not be done, so the card can say why rather than looping on
   * the same offer with no explanation.
   */
  readonly readConnection: (id: string) => Promise<{ ok: boolean; note?: string }>;
  /**
   * Plan what opening one record shows, run on confirm.
   *
   * Optional because a server with no AI key has none, and a widget without a
   * planned record view is still a widget. Present so this route and the chat
   * action reach the same code — they used not to, and the card's Add button
   * silently produced records with no related collections as a result.
   */
  readonly planDetail?: ((input: DetailPlanRequest) => Promise<DetailSetup>) | undefined;
}

/** The shared state shape, with this route's own dependencies supplied. */
const stateOf = (draft: ConciergeDraft | null, deps: ConciergeRouteDeps, dashboardId: string) =>
  conciergeState({ draft, context: deps.context(), board: deps.getDashboard(dashboardId) });

export const conciergeRoutes =
  (deps: ConciergeRouteDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    type Params = { dashboardId: string };

    app.get<{ Params: Params }>("/api/concierge/:dashboardId", async (request) =>
      stateOf(await deps.drafts.get(request.params.dashboardId), deps, request.params.dashboardId),
    );

    app.post<{ Params: Params; Body: unknown }>(
      "/api/concierge/:dashboardId/start",
      async (request, reply) => {
        const parsed = startSchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

        const id = request.params.dashboardId;
        const draft = newDraft(
          `draft-${Date.now().toString(36)}`,
          parsed.data.intent,
          parsed.data.mode,
        );
        await deps.drafts.put(id, draft);
        return stateOf(draft, deps, id);
      },
    );

    app.post<{ Params: Params; Body: unknown }>(
      "/api/concierge/:dashboardId/answer",
      async (request, reply) => {
        const parsed = answerSchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

        const id = request.params.dashboardId;
        const draft = await deps.drafts.get(id);
        if (!draft) return reply.status(409).send({ error: "no setup is in progress" });

        /*
         * The answer has to be for the question actually being asked.
         *
         * A card left on screen through a reload would otherwise apply its
         * answer to whatever question is current — silently binding a field to
         * a role nobody chose it for. A 409 with the current step lets the
         * client re-render rather than guess.
         */
        const current = nextStep(draft, deps.context());
        if (!current || current.id !== parsed.data.stepId) {
          return reply.status(409).send({
            error: current
              ? `that answer was for "${parsed.data.stepId}", but the question is "${current.id}"`
              : "the setup has no questions left",
            ...stateOf(draft, deps, id),
          });
        }

        /*
         * The two answers that do something rather than record something.
         *
         * The step machine is pure, so it can only say what should happen next
         * — connecting an API, or reading one. Carrying that out is this
         * layer's job, and it is the one place in the whole flow that spends a
         * request. It happens on an explicit choice from a card that stated the
         * price, and nowhere else.
         */
        if (EFFECT_STEPS.has(parsed.data.stepId)) {
          const choice = parsed.data.values[0];

          // Both hand off to the panel that owns credentials. A key must never
          // travel through a conversation, so the concierge opens the door and
          // stops there.
          if (choice === "open" || choice === "key") {
            return { ...stateOf(draft, deps, id), open: "connections" as const };
          }

          if (choice === "read" && draft.connection) {
            const outcome = await deps.readConnection(draft.connection);
            // The draft is untouched either way: what changed, or failed to,
            // is the world, and the next question is derived from that.
            return {
              ...stateOf(draft, deps, id),
              ...(outcome.ok ? {} : { readFailed: outcome.note ?? "the read did not complete" }),
            };
          }
        }

        const next = parsed.data.skip
          ? skipStep(draft, parsed.data.stepId)
          : applyStep(draft, parsed.data.stepId, parsed.data.values, deps.context());
        await deps.drafts.put(id, next);
        return stateOf(next, deps, id);
      },
    );

    /*
     * Set several things at once.
     *
     * The card uses this for a control that changes more than one decision,
     * and it is the same door the assistant comes through. Everything in the
     * patch is validated against the derived option sets; what does not
     * survive comes back as `rejected` rather than being quietly dropped.
     */
    app.post<{ Params: Params; Body: unknown }>(
      "/api/concierge/:dashboardId/revise",
      async (request, reply) => {
        const parsed = reviseSchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

        const id = request.params.dashboardId;
        const draft = await deps.drafts.get(id);
        if (!draft) return reply.status(409).send({ error: "no setup is in progress" });

        const result = revise(draft, parsed.data, deps.context());
        await deps.drafts.put(id, result.draft);
        return { ...stateOf(result.draft, deps, id), rejected: result.rejected };
      },
    );

    app.post<{ Params: Params; Body: unknown }>(
      "/api/concierge/:dashboardId/confirm",
      async (request, reply) => {
        const parsed = confirmSchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

        const id = request.params.dashboardId;
        const draft = await deps.drafts.get(id);
        if (!draft) return reply.status(409).send({ error: "no setup is in progress" });

        const board = deps.getDashboard(id);
        if (!board) return reply.status(404).send({ error: "that dashboard does not exist" });

        const context = deps.context();
        /*
         * Two different bars, because the two modes mean different things by
         * "finished". The wizard is finished when every question has been put;
         * the assisted flow is finished when a widget can exist, since the
         * rest of the decisions are controls the user is looking at.
         */
        if (draft.mode === "assisted") {
          const state = readiness(draft, context);
          if (!state.ready) {
            return reply
              .status(409)
              .send({ error: `still missing: ${state.missing.map((m) => m.stepId).join(", ")}` });
          }
        } else {
          const pending = nextStep(draft, context);
          if (pending) {
            return reply
              .status(409)
              .send({ error: `"${pending.question}" has not been answered yet` });
          }
        }

        const titled: ConciergeDraft = parsed.data.title?.trim()
          ? { ...draft, title: parsed.data.title.trim() }
          : draft;

        /*
         * What opening one record shows, decided here and nowhere earlier.
         *
         * Run on confirm rather than during the questions so a widget somebody
         * discarded never pays for a detail view they were never going to
         * open — and run on *this* path as well as the chat's, because the two
         * doors have to produce the same widget.
         */
        const { draft: named } = await settleDetail(titled, deps.planDetail);

        const built = buildFromDraft(named, context, {
          taken: new Set(board.widgets.map((widget) => widget.id)),
        });
        if (!built.widget) {
          return reply.status(400).send({ error: built.errors.join("; ") || "it did not validate" });
        }

        /*
         * Re-parsed rather than trusted. It was validated when the summary was
         * rendered, but this is the call that writes — the same rule
         * `add_widget` follows, for the same reason.
         */
        const revalidated = parseWidget(built.widget);
        if (!revalidated.ok || !revalidated.value) {
          return reply
            .status(400)
            .send({ error: revalidated.errors.join("; ") || "it no longer validates" });
        }

        // A `{{param.x}}` the board has not declared is a parse error, so a
        // widget wanting a search box arrives with the filter that feeds it.
        const declared = new Set(board.params.filters.map((filter) => filter.key));
        const added: FilterDecl[] = built.requiresFilters.filter(
          (filter) => !declared.has(filter.key),
        );

        deps.putDashboard({
          ...board,
          params: { ...board.params, filters: [...board.params.filters, ...added] },
          widgets: [...board.widgets, revalidated.value],
        });
        await deps.drafts.clear(id);

        return {
          added: true,
          widgetId: revalidated.value.id,
          title: revalidated.value.title,
          warnings: built.warnings,
          filtersAdded: added.map((filter) => filter.key),
        };
      },
    );

    app.delete<{ Params: Params }>("/api/concierge/:dashboardId", async (request) => {
      await deps.drafts.clear(request.params.dashboardId);
      return { cleared: true };
    });
  };
