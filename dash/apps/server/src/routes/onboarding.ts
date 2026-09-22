import type { LlmAdapter } from "@freebirdai/dash-agent";
import {
  briefCandidates,
  categoriseApi,
  composeStarters,
  starterBatchKey,
} from "@freebirdai/dash-agent";
import type {
  CatalogEntry,
  CategorySpec,
  ConnectionSpec,
  DashboardSpec,
  EntitySpec,
} from "@freebirdai/dash-spec";
import { CATEGORY_VERSION, onboardingSchema } from "@freebirdai/dash-spec";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CatalogStore } from "../catalog.js";
import { materialise } from "../onboarding/materialise.js";

/**
 * Asking somebody what they want from a connection, and giving it to them.
 *
 * The step the wizard was missing. Everything before it leaves a connection
 * that works and a board that is empty — every endpoint mapped, every record
 * type described, and no answer to "so what should I look at?". Two model
 * calls answer that once per API: what this software is and how it divides up,
 * then what each division opens with.
 *
 * The split across these routes is the split between the two artifacts, and it
 * is the whole architecture:
 *
 * - `/api/catalog/:id/categories` writes the **shared** half. It describes the
 *   API, costs model tokens and **zero requests against anybody's account**,
 *   and is inherited by everybody who connects this API afterwards — the same
 *   standing as the map, the record types and the views.
 * - `/api/connections/:id/onboarding` reads that half against one connection's
 *   endpoints, records what one person picked, and builds their boards. None
 *   of it is shareable and none of it is a model call.
 */

export interface OnboardingRouteDeps {
  readonly catalog: CatalogStore | undefined;
  /** Null when no AI key is configured. */
  readonly llm: (task: "onboarding") => LlmAdapter | null;
  readonly getConnection: (id: string) => ConnectionSpec | null;
  readonly putConnection: (spec: ConnectionSpec) => void;
  readonly getDashboard: (id: string) => DashboardSpec | null;
  readonly putDashboard: (spec: DashboardSpec) => void;
  /** Applies the server's own slug and uniqueness rules. */
  readonly createDashboard: (title: string) => DashboardSpec;
  readonly onChanged?: (() => void) | undefined;
}

/** What is known about an API's divisions, read off the stored entry. */
export const categoryState = (
  entry: CatalogEntry,
): {
  divided: boolean;
  stale: boolean;
  categories: number;
  /** Categories that have a widget set. The second pass may not have finished. */
  composed: number;
  starters: number;
  entities: number;
  categoriesAt: string | null;
} => {
  const categories = entry.categories ?? [];
  return {
    /*
     * Whether there are categories, not whether the version stamp is set —
     * the same reading `entityState` settled on, and for the same reason: a
     * partial run that produced six usable parts has divided this API, and
     * telling somebody it has not offers to spend money redoing it.
     */
    divided: categories.length > 0,
    stale:
      categories.length > 0 &&
      (entry.categoryVersion === undefined || entry.categoryVersion < CATEGORY_VERSION),
    categories: categories.length,
    composed: categories.filter((category) => category.starters.length > 0).length,
    starters: categories.reduce((sum, category) => sum + category.starters.length, 0),
    entities: (entry.entities ?? []).length,
    categoriesAt: entry.categoriesAt ?? null,
  };
};

/** Endpoints behind each record type, so a category can say what it covers. */
const endpointCountsFor = (entry: CatalogEntry): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const resource of entry.resources) {
    const ops = new Set(
      [resource.listOp, resource.detailOp].filter((op): op is string => Boolean(op)),
    );
    counts[resource.id] = ops.size;
  }
  return counts;
};

/**
 * A category as it applies to one connection.
 *
 * The catalog describes the whole API; a connection holds whichever endpoints
 * somebody picked. A category none of whose record types this connection can
 * read is reported unavailable rather than offered — an offer that cannot be
 * executed is the failure this whole area keeps circling back to.
 */
export interface CategoryOffer {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly recordTypes: number;
  readonly endpoints: number;
  readonly widgets: number;
  /** What it opens with, in a reader's words, so the choice is not blind. */
  readonly opensWith: readonly string[];
  readonly available: boolean;
  readonly unavailable?: string | undefined;
}

export const offersFor = (input: {
  readonly connection: ConnectionSpec;
  readonly entry: CatalogEntry;
}): readonly CategoryOffer[] => {
  const entities = input.entry.entities ?? [];
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const resources = new Set(input.connection.resources.map((resource) => resource.id));
  const ops = new Set(input.connection.ops.map((op) => op.id));
  const counts = endpointCountsFor(input.entry);

  /** A record type this connection can actually read rows of. */
  const readable = (entity: EntitySpec | undefined): boolean => {
    if (!entity) return false;
    if (!resources.has(entity.resource)) return false;
    const resource = input.connection.resources.find((one) => one.id === entity.resource);
    const listOp = resource?.listOp;
    return listOp !== undefined && ops.has(listOp);
  };

  return (input.entry.categories ?? []).map((category) => {
    const mine = category.entities.filter((id) => readable(byId.get(id)));
    const endpoints = category.entities.reduce((sum, id) => sum + (counts[id] ?? 0), 0);
    const buildable = category.starters.filter((starter) =>
      mine.includes(starter.brief.entity),
    );
    return {
      id: category.id,
      title: category.title,
      ...(category.description ? { description: category.description } : {}),
      recordTypes: mine.length,
      endpoints,
      widgets: buildable.length,
      opensWith: buildable
        .map(
          (starter) =>
            starter.brief.title ?? byId.get(starter.brief.entity)?.name.many ?? starter.brief.entity,
        )
        .slice(0, 8),
      available: buildable.length > 0,
      ...(buildable.length === 0
        ? {
            unavailable:
              mine.length === 0
                ? "This connection does not carry the endpoints behind these records."
                : "Nothing has been composed for this part yet.",
          }
        : {}),
    };
  });
};

export const onboardingRoutes =
  (deps: OnboardingRouteDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    /**
     * What is known about this API's divisions. Free — it reads the entry.
     */
    app.get<{ Params: { id: string } }>("/api/catalog/:id/categories", async (request, reply) => {
      if (!deps.catalog) return reply.status(501).send({ error: "no catalog configured" });
      const entry = deps.catalog.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "no such catalog entry" });
      return {
        ...categoryState(entry),
        canRun: deps.llm("onboarding") !== null,
        ...(entry.profile ? { profile: entry.profile } : {}),
        categoryList: entry.categories ?? [],
      };
    });

    /**
     * Work out what this API is, how it divides up, and what each part opens
     * with.
     *
     * Two passes in one route, deliberately — the same call the map route
     * makes about mapping and describing. Split into two buttons, only the
     * first would ever be pressed, and categories with no widget sets are a
     * state the wizard has no answer for: it would offer somebody a choice and
     * then build them an empty board.
     *
     * Costs model tokens and **zero requests against anybody's API**.
     */
    app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
      "/api/catalog/:id/categories",
      async (request, reply) => {
        if (!deps.catalog) return reply.status(501).send({ error: "no catalog configured" });
        const entry = deps.catalog.get(request.params.id);
        if (!entry) return reply.status(404).send({ error: "no such catalog entry" });

        const force = request.body?.force === true;
        const state = categoryState(entry);
        if (state.divided && !state.stale && state.composed === state.categories && !force) {
          return {
            ...state,
            ranPass: false,
            note: "this API is already divided up, and every part has a starting dashboard",
          };
        }

        const entities = entry.entities ?? [];
        if (entities.length === 0) {
          return reply.status(409).send({
            error:
              "This API's records have not been described yet, so there is nothing to divide up.",
          });
        }

        const llm = deps.llm("onboarding");
        if (!llm) {
          return reply.status(400).send({
            error:
              "Planning a connection's dashboards needs an AI key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY on the server.",
          });
        }

        const candidates = briefCandidates([
          { connection: entry.id, title: entry.title, entities },
        ]);

        /*
         * Dividing the API again only when it has to be.
         *
         * The division is the cheap call and the one everything else hangs
         * off, but re-running it renames and re-ids every part — which would
         * orphan the boards somebody already has. So an entry that is already
         * divided keeps its parts unless the pass itself has moved on or
         * somebody forced it, and the run goes straight to composing whatever
         * has no widget set.
         *
         * Deliberately not `!state.stale`. Stale means "the pass moved on OR
         * it never finished", and those want opposite things here: a division
         * from an older version of the pass is worth redoing, and one whose
         * *composing* half died half way through is the exact case this branch
         * exists for — the parts are good, the sets are missing, and
         * re-dividing would throw away the good half to redo the bad one.
         */
        const outdated =
          entry.categoryVersion !== undefined && entry.categoryVersion < CATEGORY_VERSION;
        const reuse = state.divided && !outdated && !force;
        const divided = reuse
          ? {
              categories: entry.categories ?? [],
              profile: entry.profile ?? null,
              uncategorised: [] as readonly string[],
              errors: [] as readonly string[],
              skipped: [] as readonly string[],
            }
          : await categoriseApi(llm, {
              apiTitle: entry.title,
              candidates,
              endpointCounts: endpointCountsFor(entry),
            });

        if (divided.categories.length === 0) {
          return reply.status(502).send({
            error:
              divided.errors[0] ?? "This API could not be divided into parts worth a dashboard.",
            skipped: divided.skipped,
          });
        }

        /* Written before the sets are composed, so a run that dies mid-way
         * leaves the division rather than nothing. */
        const withCategories: CatalogEntry = {
          ...entry,
          categories: [...divided.categories],
          ...(divided.profile ? { profile: divided.profile } : {}),
          categoriesAt: new Date().toISOString(),
          categoryVersion: undefined,
          ...(reuse ? {} : { categoryProgress: { version: CATEGORY_VERSION, batches: [] } }),
        };
        deps.catalog.put(withCategories);

        /*
         * What not to compose again.
         *
         * The progress list, plus every part that already *has* a set. The
         * second half matters because the list can be absent while the sets
         * are not — an entry written before this pass existed, or one whose
         * progress was cleared mid-flight — and without it a re-run asked for
         * the one missing part would pay for all the others a second time.
         * A category with a set already is not evidence of anything except
         * that nobody needs to buy it twice.
         */
        const batches =
          force
            ? []
            : [
                ...(withCategories.categoryProgress?.version === CATEGORY_VERSION
                  ? withCategories.categoryProgress.batches
                  : []),
                ...divided.categories
                  .filter((category) => category.starters.length > 0)
                  .map((category) => starterBatchKey(entry.title, category)),
              ];

        const composed = await composeStarters(
          llm,
          {
            apiTitle: entry.title,
            categories: divided.categories,
            candidates,
            check: {
              entities,
              resources: entry.resources,
              ops: entry.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
              connection: entry.id,
              pathOf: (op) => entry.ops.find((one) => one.id === op)?.path,
            },
          },
          {
            completedBatches: batches,
            onCheckpoint: (result) => {
              const current = deps.catalog!.get(entry.id) ?? withCategories;
              deps.catalog!.put({
                ...current,
                categories: [...result.categories],
                /* Cleared while the pass is in flight: a half-composed API
                 * must not read as finished if the next call never lands. */
                categoryVersion: undefined,
                categoryProgress: {
                  version: CATEGORY_VERSION,
                  batches: [...result.completedBatches],
                },
              });
            },
          },
        );

        const errors = [...divided.errors, ...composed.errors];
        const saved = deps.catalog.put({
          ...(deps.catalog.get(entry.id) ?? withCategories),
          categories: [...composed.categories],
          categoriesAt: new Date().toISOString(),
          // Only a clean run marks the pass done; a partial one stays
          // resumable and says what it is missing.
          categoryVersion: errors.length === 0 ? CATEGORY_VERSION : undefined,
          categoryProgress: {
            version: CATEGORY_VERSION,
            batches: [...composed.completedBatches],
          },
          updatedAt: new Date().toISOString(),
        });

        return {
          ...categoryState(saved),
          ranPass: true,
          ...(saved.profile ? { profile: saved.profile } : {}),
          categoryList: saved.categories,
          /* Proposed against kept. The difference is the honest part: a widget
           * the compiler refused is one that would not have worked. */
          proposed: composed.proposed,
          kept: composed.kept,
          /* Record types no part claimed. Not an error — they stay reachable
           * through the assistant, they just do not open a dashboard. */
          uncategorised: divided.uncategorised,
          errors,
          skipped: [...divided.skipped, ...composed.skipped],
        };
      },
    );

    /**
     * The parts of this API, as they apply to this connection.
     *
     * Free, and the read the wizard opens with: what could be set up, what was
     * already set up, and whether the passes still have to run.
     */
    app.get<{ Params: { id: string } }>(
      "/api/connections/:id/onboarding",
      async (request, reply) => {
        const connection = deps.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });

        const entry = connection.catalog ? deps.catalog?.get(connection.catalog) : undefined;

        /*
         * A record this route actually wrote, rather than one that merely
         * parsed.
         *
         * Every field of `onboardingSchema` has a default, so a foreign object
         * stored under the same key — an older experiment's, a future
         * version's — parses cleanly into an empty one, and the screen then
         * says "already set up" over no boards at all. `at` is stamped on
         * every write and defaults to nothing, so it is the one field that
         * distinguishes "somebody set this up" from "something else was here".
         */
        const already = connection.onboarding?.at ? connection.onboarding : undefined;

        /*
         * A board that was deleted since is not a board. Reported as gone
         * rather than linked to, so "already set up" never points at nothing.
         */
        const boards = (already?.boards ?? []).flatMap((board) => {
          const found = deps.getDashboard(board.dashboard);
          return found
            ? [
                {
                  ...(board.category ? { category: board.category } : {}),
                  dashboard: board.dashboard,
                  title: found.title,
                  widgets: found.widgets.length,
                },
              ]
            : [];
        });

        return {
          connection: connection.id,
          title: connection.title,
          catalog: connection.catalog ?? null,
          ...(entry?.profile ? { profile: entry.profile } : {}),
          state: entry
            ? { ...categoryState(entry), canRun: deps.llm("onboarding") !== null }
            : null,
          categories: entry ? offersFor({ connection, entry }) : [],
          ...(already
            ? {
                already: {
                  chose: already.chose,
                  layout: already.layout,
                  at: already.at ?? null,
                  notes: already.notes,
                  boards,
                },
              }
            : {}),
        };
      },
    );

    /**
     * Build the boards somebody asked for.
     *
     * Never mutates a board that already exists: a second run makes new ones.
     * Somebody setting up again has usually changed their mind about what they
     * want, not about the board they have been arranging since — and rewriting
     * that one would throw away work nothing here can reconstruct.
     */
    app.post<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id/onboarding",
      async (request, reply) => {
        const parsed = z
          .object({
            categories: z.array(z.string().min(1).max(64)).min(1).max(20),
            layout: z.enum(["single", "per-category"]).default("per-category"),
          })
          .safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: "choose at least one part to set up" });
        }

        const connection = deps.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });

        const entry = connection.catalog ? deps.catalog?.get(connection.catalog) : undefined;
        if (!entry) {
          return reply
            .status(409)
            .send({ error: "This connection has no integration behind it to set up from." });
        }

        const offers = new Map(
          offersFor({ connection, entry }).map((offer) => [offer.id, offer]),
        );
        const chosen: CategorySpec[] = [];
        const refused: string[] = [];
        for (const id of parsed.data.categories) {
          const category = (entry.categories ?? []).find((one) => one.id === id);
          const offer = offers.get(id);
          if (!category || !offer) {
            refused.push(`"${id}" is not a part of this API.`);
            continue;
          }
          if (!offer.available) {
            refused.push(`${category.title}: ${offer.unavailable ?? "nothing could be built."}`);
            continue;
          }
          chosen.push(category);
        }

        if (chosen.length === 0) {
          return reply.status(409).send({
            error: "None of the parts chosen could be built against this connection.",
            notes: refused,
          });
        }

        const built = materialise({
          source: { connection, entities: entry.entities ?? [] },
          categories: chosen,
          layout: parsed.data.layout,
          createBoard: (title) => deps.createDashboard(title),
        });

        if (built.boards.length === 0) {
          return reply.status(502).send({
            error: built.errors[0] ?? "No board could be built.",
            notes: [...refused, ...built.notes],
          });
        }

        for (const board of built.boards) deps.putDashboard(board.board);

        const notes = [...refused, ...built.notes];
        const onboarding = onboardingSchema.parse({
          chose: chosen.map((category) => category.id),
          layout: parsed.data.layout,
          boards: built.boards.map((board) => ({
            ...(board.category ? { category: board.category } : {}),
            dashboard: board.board.id,
          })),
          at: new Date().toISOString(),
          notes: notes.slice(0, 40),
        });
        deps.putConnection({ ...connection, onboarding });
        deps.onChanged?.();

        return {
          boards: built.boards.map((board) => ({
            ...(board.category ? { category: board.category } : {}),
            dashboard: board.board.id,
            title: board.board.title,
            widgets: board.widgets.length,
          })),
          layout: parsed.data.layout,
          notes,
          errors: built.errors,
        };
      },
    );
  };
