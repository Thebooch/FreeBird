import type { LlmAdapter } from "@freebirdai/dash-agent";
import { labelFields, mapApi, pruneAmbiguousRelations } from "@freebirdai/dash-agent";
import type { CatalogEntry, ResourceSpec } from "@freebirdai/dash-spec";
import { LABEL_VERSION, MAP_VERSION, pathParamNames } from "@freebirdai/dash-spec";
import type { FastifyInstance } from "fastify";
import type { CatalogStore } from "../catalog.js";
import { looksLikeOpenApi, parseOpenApi, parseSpecDocument } from "../discovery/openapi.js";
import { extractInlineSpec } from "../discovery/inline-spec.js";

/**
 * Mapping an API once, for everyone who ever connects to it.
 *
 * This is what "this integration does not exist yet — create it?" runs. It is
 * the expensive step and it happens **once per API, ever**: the result goes in
 * the catalog overlay, which is the shareable artifact, so a second person
 * arrives with only their keys.
 *
 * "Expensive" is worth being precise about, because it is not what it sounds
 * like. The field schemas come out of the spec for **zero requests** — the
 * importer already resolves every response and had been discarding all but the
 * rows path. What costs anything is the model pass that writes the missing
 * descriptions and finds the relationships a URL never stated. So the consent
 * this route asks for is about time and model spend, not about hammering
 * somebody's API.
 *
 * It needs no key at all. An API can be mapped before anyone has connected to
 * it, which is precisely what makes the map worth sharing.
 */

export interface MapRouteDeps {
  readonly catalog: CatalogStore | undefined;
  /**
   * The model for one action. Null means no AI key is configured.
   *
   * Takes the action's name because the two passes here are not alike: finding
   * how an API's resources relate is reasoning over hundreds of endpoints, and
   * naming its fields is a vocabulary exercise a cheap model does well. They
   * were one call resolving to one model; the argument is what separates them.
   */
  readonly llm: (task: "map" | "label") => LlmAdapter | null;
  /**
   * SSRF-guarded fetch for re-reading a spec. Absent disables the refresh.
   *
   * The same entry point discovery uses, injected for the same reason: this
   * module has no business deciding what a server may fetch.
   */
  readonly fetchDocument?: ((url: string) => Promise<{ status: number; text: string; url: string }>) | undefined;
}

/**
 * Take the freshly imported endpoints, keep everything a pass has learned.
 *
 * The two halves of an entry come from different places and improve on
 * different schedules. Field schemas, parameters and paths come from the
 * import, and improve whenever the importer does — the reason this exists is
 * that Buildium's map recorded every nested object as a string, so
 * `Category.Name` did not exist anywhere and nothing that reasons about nested
 * values could work. Descriptions and relations come from the model pass, cost
 * real money, and are the artifact the whole catalog idea is built on.
 *
 * Replacing the entry refreshes the first and destroys the second. This merges
 * instead, and the precedence is the point:
 *
 * - fields, params, paths, archetypes → always the fresh import. That is what
 *   is being refreshed.
 * - description → whatever is already there wins, because it is either the API
 *   author's own words or a description somebody paid a model to write, and
 *   the import would supply neither.
 * - facet → kept. It names a field on this API and re-reading a schema does
 *   not un-name it.
 * - resources and their relations → kept entirely. Nothing in a spec re-read
 *   is evidence against them.
 * - the label lexicon → kept, for the same reason as descriptions. It is keyed
 *   by field name rather than by endpoint, so a re-read that renames nothing
 *   invalidates none of it; a genuinely new field simply has no entry yet and
 *   falls back to its mechanical label.
 *
 * An endpoint the fresh spec no longer has is dropped: it cannot be called, so
 * keeping its description would be keeping a description of nothing. Relations
 * pointing at it are left alone — `relationGraph` already declines to offer a
 * link whose endpoint is missing, so the graph corrects itself without this
 * having to reason about it.
 */
export const mergeRefreshedOps = (
  existing: CatalogEntry,
  fresh: CatalogEntry,
): CatalogEntry["ops"] => {
  const before = new Map(existing.ops.map((op) => [op.id, op]));
  return fresh.ops.map((op) => {
    const previous = before.get(op.id);
    if (!previous) return op;
    return {
      ...op,
      ...(previous.description ? { description: previous.description } : {}),
      ...(previous.facet ? { facet: previous.facet } : {}),
    };
  });
};

/**
 * Whether this entry has been through the passes, and at which versions.
 *
 * Two passes, tracked separately. They cost different money and answer
 * different questions, so a labelling pass that changes shape must not mark
 * the expensive relation map stale and invite a re-run of something it does
 * not produce.
 */
export const mapState = (
  entry: CatalogEntry,
): {
  mapped: boolean;
  stale: boolean;
  endpoints: number;
  described: number;
  withFields: number;
  labelled: boolean;
  labelsStale: boolean;
  labels: number;
} => ({
  mapped: entry.mapVersion !== undefined,
  // A pass that has changed shape since is worth running again.
  stale: entry.mapVersion !== undefined && entry.mapVersion < MAP_VERSION,
  endpoints: entry.ops.length,
  described: entry.ops.filter((op) => op.description).length,
  withFields: entry.ops.filter((op) => (op.fields?.length ?? 0) > 0).length,
  labelled: entry.labelVersion !== undefined,
  labelsStale: entry.labelVersion !== undefined && entry.labelVersion < LABEL_VERSION,
  labels: Object.keys(entry.labels ?? {}).length,
});

/** Relations merged in, without letting a guess shadow something declared. */
const mergeRelations = (
  resources: readonly ResourceSpec[],
  found: Readonly<Record<string, ResourceSpec["relations"]>>,
): ResourceSpec[] =>
  resources.map((resource) => {
    const extra = found[resource.id] ?? [];
    if (extra.length === 0) return resource;
    const known = new Set(resource.relations.map((relation) => relation.resource));
    return {
      ...resource,
      relations: [...resource.relations, ...extra.filter((relation) => !known.has(relation.resource))],
    };
  });

export const mapRoutes =
  (deps: MapRouteDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    /**
     * What mapping this API would involve, costing nothing to ask.
     *
     * The counts are the honest version of "is this integration ready?" — how
     * many endpoints exist, how many can already be told apart by their
     * description, and how many carry a field list.
     */
    app.get<{ Params: { id: string } }>("/api/catalog/:id/map", async (request, reply) => {
      const entry = deps.catalog?.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "no such catalog entry" });

      const state = mapState(entry);
      return {
        ...state,
        mappedAt: entry.mappedAt ?? null,
        /*
         * The endpoints the pass would have to *call*, as opposed to read.
         *
         * Almost always a handful: an endpoint with no declared response is
         * usually also one that needs an id, and those cannot be called
         * speculatively at all.
         */
        wouldSample: entry.ops.filter(
          (op) => (op.fields?.length ?? 0) === 0 && pathParamNames(op.path).length === 0,
        ).length,
        canRun: deps.llm("map") !== null,
      };
    });

    /**
     * Re-read the endpoint schemas, keeping everything the map has learned.
     *
     * Costs one fetch of a public document and no model tokens, so it is
     * offered without a price. What it is for: the importer improves, and until
     * now every API already imported was frozen at whatever it understood on
     * the day. The case that forced it — nested objects were recorded as
     * strings, so a field like `Category.Name` existed nowhere in the map, and
     * every feature that reasons about nested values was reading a flat world.
     */
    app.post<{ Params: { id: string }; Body: { specUrl?: string } }>(
      "/api/catalog/:id/refresh",
      async (request, reply) => {
        if (!deps.catalog) return reply.status(501).send({ error: "no catalog configured" });
        if (!deps.fetchDocument) {
          return reply.status(501).send({ error: "this server cannot fetch documents" });
        }

        const entry = deps.catalog.get(request.params.id);
        if (!entry) return reply.status(404).send({ error: "no such catalog entry" });

        /*
         * An override is accepted because entries imported before `specUrl`
         * existed have none, and those are exactly the ones most worth
         * refreshing — they were written by the oldest version of the importer.
         */
        const url = request.body?.specUrl ?? entry.specUrl;
        if (!url) {
          return reply.status(400).send({
            error:
              "This entry does not record where its spec came from. Pass specUrl to say where to re-read it.",
          });
        }

        let fetched: { status: number; text: string; url: string };
        try {
          fetched = await deps.fetchDocument(url);
        } catch (caught) {
          return reply.status(502).send({
            error: caught instanceof Error ? caught.message : String(caught),
          });
        }
        if (fetched.status >= 400) {
          return reply.status(502).send({ error: `${url} answered ${fetched.status}` });
        }

        /*
         * A spec served as a document, or one embedded in a docs page.
         *
         * Discovery has read both since inline extraction shipped, and this
         * route read only the first — so the entries most worth refreshing
         * were exactly the ones it refused. Some vendors publish no standalone
         * spec at all: the whole document sits inside the page their reference
         * renderer draws, and "go and find the .json" is not an instruction
         * anybody can follow when there is not one.
         */
        const direct = parseSpecDocument(fetched.text);
        const inline = looksLikeOpenApi(direct)
          ? null
          : extractInlineSpec(fetched.text, looksLikeOpenApi);
        const doc = inline ? inline.spec : direct;
        if (!looksLikeOpenApi(doc)) {
          return reply.status(400).send({
            error: `${url} is not an OpenAPI document, and none was found embedded in it`,
          });
        }
        const parsed = parseOpenApi(doc, fetched.url);
        if (!parsed || parsed.entry.ops.length === 0) {
          return reply
            .status(400)
            .send({ error: "no readable GET endpoints could be imported from that spec" });
        }

        const ops = mergeRefreshedOps(entry, parsed.entry);
        const nested = ops.filter((op) => op.fields?.some((field) => field.name.includes("."))).length;

        const saved = deps.catalog.put({
          ...entry,
          ops,
          // Untouched, and that is the whole point of this route existing.
          resources: entry.resources,
          specUrl: fetched.url,
          updatedAt: new Date().toISOString(),
        });

        return {
          endpoints: saved.ops.length,
          added: saved.ops.filter((op) => !entry.ops.some((old) => old.id === op.id)).length,
          /*
           * Endpoints the spec no longer describes. Reported rather than
           * buried: something the map used to offer is gone, which is a change
           * to a shared artifact even though nothing went wrong.
           */
          removed: entry.ops.filter((op) => !saved.ops.some((now) => now.id === op.id)).length,
          withFields: saved.ops.filter((op) => (op.fields?.length ?? 0) > 0).length,
          /*
           * How many endpoints now describe a nested field. The number this
           * route exists to move off zero.
           */
          withNestedFields: nested,
          descriptionsKept: saved.ops.filter((op) => op.description).length,
          relationsKept: saved.resources.reduce(
            (total, resource) => total + resource.relations.length,
            0,
          ),
          warnings: parsed.warnings,
          specUrl: fetched.url,
        };
      },
    );


    /**
     * Name the fields, and nothing else.
     *
     * Split out from the map because the two passes improve on their own
     * schedules and cost different amounts. Re-running this on an API whose
     * relations are already correct is a few calls; re-running the whole map
     * to get it would be paying again for an answer nobody disputes.
     *
     * Also the route to reach for when an entry was mapped before labelling
     * existed — which is every entry mapped before today.
     */
    app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
      "/api/catalog/:id/labels",
      async (request, reply) => {
        if (!deps.catalog) return reply.status(501).send({ error: "no catalog configured" });

        const entry = deps.catalog.get(request.params.id);
        if (!entry) return reply.status(404).send({ error: "no such catalog entry" });

        const state = mapState(entry);
        if (state.labelled && !state.labelsStale && request.body?.force !== true) {
          return { ...state, ranPass: false, note: "the fields on this API are already named" };
        }

        const llm = deps.llm("label");
        if (!llm) {
          return reply.status(400).send({
            error:
              "Naming an API's fields needs an AI key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY on the server.",
          });
        }

        const named = await labelFields(llm, {
          apiTitle: entry.title,
          ops: entry.ops.map((op) => ({
            id: op.id,
            title: op.title,
            ...(op.fields ? { fields: op.fields } : {}),
          })),
        });

        const saved = deps.catalog.put({
          ...entry,
          // Merged, not replaced: a lost batch must not cost the labels a
          // previous run already established.
          labels: { ...(entry.labels ?? {}), ...named.labels },
          labelledAt: new Date().toISOString(),
          labelVersion: LABEL_VERSION,
          updatedAt: new Date().toISOString(),
        });

        return {
          ...mapState(saved),
          ranPass: true,
          labelsWritten: Object.keys(named.labels).length,
          /*
           * Which fields the pass left alone. Not a failure — a field whose
           * name already reads well needs no entry, and the mechanical label
           * is what shows for it.
           */
          unlabelled:
            new Set(entry.ops.flatMap((op) => (op.fields ?? []).map((field) => field.name))).size -
            Object.keys(saved.labels ?? {}).length,
          errors: named.errors,
          skipped: named.skipped,
        };
      },
    );

    /**
     * Run the pass and store the result.
     *
     * Deliberately not idempotent-by-default: re-running costs the same as the
     * first time, so it happens only when asked. `force` is how a stale map is
     * refreshed once the pass itself has changed.
     */
    app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
      "/api/catalog/:id/map",
      async (request, reply) => {
        if (!deps.catalog) return reply.status(501).send({ error: "no catalog configured" });

        const entry = deps.catalog.get(request.params.id);
        if (!entry) return reply.status(404).send({ error: "no such catalog entry" });

        const state = mapState(entry);
        if (state.mapped && !state.stale && request.body?.force !== true) {
          return { ...state, ranPass: false, note: "this API is already mapped" };
        }

        const llm = deps.llm("map");
        if (!llm) {
          return reply.status(400).send({
            error:
              "Mapping an API needs an AI key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY on the server.",
          });
        }

        const ops = entry.ops.map((op) => ({
          id: op.id,
          title: op.title,
          path: op.path,
          ...(op.description ? { description: op.description } : {}),
          ...(op.fields ? { fields: op.fields } : {}),
        }));

        /*
         * Retract what the rules now reject, before proposing anything new.
         *
         * Merging can add a link but never withdraw one, so without this a
         * relation recorded wrongly is permanent — the corrected pass simply
         * declines to propose it again and the bad one stays. Pruning first
         * also keeps the prompt honest: the model is not told a link it is
         * about to reconsider is "already linked".
         */
        const pruned = pruneAmbiguousRelations({
          apiTitle: entry.title,
          resources: entry.resources,
          ops,
        });

        const result = await mapApi(llm, {
          apiTitle: entry.title,
          resources: pruned.resources,
          ops,
        });

        /*
         * The second half of understanding an API: what to call its fields.
         *
         * Run here rather than as its own route-by-default because it answers
         * the same question the relations do — what does this API mean — and
         * because somebody who has just agreed to pay for one pass should not
         * have to be asked twice to get readable column headers. It has its
         * own route as well, for re-running it alone once the pass improves.
         *
         * Keyed by distinct field name, so it costs a handful of calls on an
         * API with hundreds of endpoints rather than one call per endpoint.
         */
        /*
         * On the cheap model deliberately, even inside the expensive pass —
         * naming a field is reading, not deciding, and this is by far the
         * larger number of calls. Falls back to the mapping adapter so the
         * labels still get written on a server that only has the one key.
         */
        const named = await labelFields(deps.llm("label") ?? llm, { apiTitle: entry.title, ops });

        const mapped: CatalogEntry = {
          ...entry,
          ops: entry.ops.map((op) => {
            const written = result.descriptions[op.id];
            // The pass never overwrites an author's own words, and this is the
            // second place that holds — belt and braces on a shared artifact.
            return written && !op.description ? { ...op, description: written } : op;
          }),
          resources: mergeRelations(pruned.resources, result.relations),
          /*
           * Merged over whatever is already there rather than replacing it, so
           * a re-run that loses a batch does not lose labels the last run got.
           */
          labels: { ...(entry.labels ?? {}), ...named.labels },
          mappedAt: new Date().toISOString(),
          mapVersion: MAP_VERSION,
          labelledAt: new Date().toISOString(),
          labelVersion: LABEL_VERSION,
        };

        const saved = deps.catalog.put(mapped);
        const after = mapState(saved);

        return {
          ...after,
          ranPass: true,
          mappedAt: saved.mappedAt ?? null,
          descriptionsWritten: Object.keys(result.descriptions).length,
          labelsWritten: Object.keys(named.labels).length,
          relationsFound: Object.values(result.relations).reduce(
            (total, list) => total + list.length,
            0,
          ),
          /*
           * Batches fail independently, so a partial map is a real outcome and
           * has to say what it is missing rather than looking complete.
           */
          errors: [...result.errors, ...named.errors],
          /*
           * Links the pass declined to record. Not errors — the pass worked
           * and refused to guess — but a missing relation needs a reason
           * attached or it reads as the mapper simply not noticing.
           */
          skipped: [...result.skipped, ...named.skipped],
          /*
           * Links a previous pass had recorded and this one retracted. Worth
           * reporting separately: something the map used to claim is no longer
           * claimed, which is a change to the shared artifact.
           */
          retracted: pruned.removed,
        };
      },
    );
  };
