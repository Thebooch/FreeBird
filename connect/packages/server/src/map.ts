import { chooseViews, mapApi, pruneAmbiguousRelations } from "@freebirdai/connect/agent";
import type { CatalogEntry } from "@freebirdai/connect-spec";
import { MAP_VERSION, pathParamNames } from "@freebirdai/connect-spec";
import type { FastifyInstance } from "fastify";
import {
  describeCatalogRecords,
  entityState,
  extractInlineSpec,
  looksLikeOpenApi,
  mapState,
  mergeRefreshedOps,
  mergeRelations,
  parseOpenApi,
  parseSpecDocument,
  schemaMoved,
  withConnectDetails,
  withDeclaredValues,
} from "@freebirdai/connect/host";
import type { MapRouteDeps } from "@freebirdai/connect/host";

/**
 * Mapping an API, once, for everyone who connects to it: the routes over
 * `@freebirdai/connect/map`. Fastify; a host serving `createEngine` mounts it.
 */
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
        /*
         * The record types, reported beside the map because they are the half
         * a person actually sees: a mapped API with nothing described still
         * shows raw field names and ids.
         */
        records: entityState(entry),
        entitiesAt: entry.entitiesAt ?? null,
        entitiesVerifiedAt: entry.entitiesVerifiedAt ?? null,
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
        canRunRecords: deps.llm("entity") !== null,
        /* The record types are being described at this moment. */
        describing: deps.describing?.has(entry.id) ?? false,
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
        const nested = ops.filter((op) =>
          op.fields?.some((field) => field.name.includes(".")),
        ).length;

        /*
         * How to reach and get into the API comes from the fresh read too —
         * the address, its template, the auth and what the docs say about
         * keys — so an importer that learned to read those better reaches
         * every entry refreshed here. See `withConnectDetails`.
         */
        const saved = deps.catalog.put({
          ...withConnectDetails(entry, parsed.entry),
          ops,
          ...(schemaMoved(entry.ops, ops)
            ? {
                mapVersion: undefined,
                /*
                 * The record types describe these fields, so a schema that has
                 * moved underneath them makes their descriptions a claim about
                 * something else. The descriptions themselves are kept — they
                 * cost money and most will still be right — and the version is
                 * cleared so the pass is offered again.
                 */
                entityVersion: undefined,
              }
            : {}),
          // Untouched, and that is the whole point of this route existing.
          resources: entry.resources,
          /*
           * Except for the one thing a re-read genuinely settles about them: a
           * closed set of values is stated by the specification, so picking up
           * a status the vendor has added costs nothing and needs no pass.
           */
          entities: withDeclaredValues(entry.entities ?? [], entry.resources, ops),
          specUrl: fetched.url,
          updatedAt: new Date().toISOString(),
        });
        deps.onRefreshed?.(entry, saved);

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
     * Describe what this API's records are, and which of them point at each
     * other.
     *
     * The pass everything a person sees rests on. A mapped API still shows raw
     * field names and bare ids: the map knows which endpoint lists a thing and
     * which returns one, and nothing about what the thing *is*. This answers
     * that — what these records are called, which field identifies one, how to
     * say its name, what each field means — and then which fields hold another
     * record's identity, which is what turns a number into a link.
     *
     * Two calls' worth of passes rather than one, deliberately. Describing a
     * record type is reading its fields; deciding that `VendorId` names a
     * vendor is a closed question asked once per candidate field. Running them
     * together is what makes the second one's question answerable at all — it
     * needs the first one's record types as the set to choose from.
     *
     * Costs model tokens and **zero requests against anybody's API**, like the
     * other two passes here. It needs no key and no connection, which is
     * precisely what makes the result worth sharing.
     */
    app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
      "/api/catalog/:id/entities",
      async (request, reply) => {
        if (!deps.catalog) return reply.status(501).send({ error: "no catalog configured" });

        const entry = deps.catalog.get(request.params.id);
        if (!entry) return reply.status(404).send({ error: "no such catalog entry" });

        const force = request.body?.force === true;
        const state = entityState(entry);
        if (state.described && !state.stale && !force) {
          return {
            ...state,
            ranPass: false,
            note: "the records on this API are already described",
          };
        }

        const llm = deps.llm("entity");
        if (!llm) {
          return reply.status(400).send({
            error:
              "Describing an API's records needs an AI key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY on the server.",
          });
        }

        if (entry.resources.length === 0) {
          return {
            ...state,
            ranPass: false,
            note: "this API has no resources to describe — map it first",
          };
        }

        /*
         * One run at a time. A second would pay for every batch twice and
         * interleave its checkpoints with the first's.
         */
        if (deps.describing?.has(entry.id)) {
          return reply.status(409).send({
            error: "This API's record types are already being described.",
            describing: true,
          });
        }
        deps.describing?.add(entry.id);
        try {
        return await describeCatalogRecords(deps.catalog, entry, llm, force);
        } finally {
          deps.describing?.delete(entry.id);
          deps.onDescribed?.(entry.id);
        }
      },
    );

    /**
     * Choose how each record type is listed and shown.
     *
     * The third and smallest pass, and the only optional one. Everything it
     * fills already has a defensible answer without it — columns from the
     * primary fields, the sort and the strips from the record type's kind, the
     * numbers above a record from counting the collections hanging off it — so
     * an API nobody has run this on works. What it buys is the cases those
     * rules are blunt on: which six of forty fields matter, a category field
     * whose name no rule recognises, and which amount is worth totalling.
     *
     * Costs model tokens and **zero requests against anybody's account**, like
     * the other two here: it reads record types that already exist.
     */
    app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
      "/api/catalog/:id/views",
      async (request, reply) => {
        if (!deps.catalog) return reply.status(501).send({ error: "no catalog is configured" });
        const entry = deps.catalog.get(request.params.id);
        if (!entry) return reply.status(404).send({ error: "no such catalog entry" });

        const entities = entry.entities ?? [];
        if (entities.length === 0) {
          return reply.status(409).send({
            error: "This API's records have not been described yet, so there is nothing to lay out.",
          });
        }

        const llm = deps.llm("entity");
        if (!llm) {
          return reply.status(400).send({
            error: "Choosing views needs an AI key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
          });
        }

        const force = request.body?.force === true;
        const batches = !force && entry.viewProgress ? entry.viewProgress.batches : [];

        const chosen = await chooseViews(
          llm,
          {
            apiTitle: entry.title,
            entities,
            resources: entry.resources,
            ops: entry.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
          },
          {
            completedBatches: batches,
            onCheckpoint: (result) => {
              const current = deps.catalog!.get(entry.id) ?? entry;
              deps.catalog!.put({
                ...current,
                entities: [...result.entities],
                viewProgress: { batches: [...result.completedBatches] },
              });
            },
          },
        );

        const saved = deps.catalog.put({
          ...(deps.catalog.get(entry.id) ?? entry),
          entities: [...chosen.entities],
          viewProgress: { batches: [...chosen.completedBatches] },
          updatedAt: new Date().toISOString(),
        });

        return {
          ...entityState(saved),
          ranPass: true,
          considered: chosen.considered,
          chosen: chosen.chosen,
          errors: chosen.errors,
          /*
           * Answers refused. Not errors — the pass worked and declined to
           * record a field that does not exist — but a record type left with
           * its defaults needs a reason or it reads as the pass not noticing.
           */
          skipped: chosen.skipped,
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

        const result =
          state.mapped && !state.stale && request.body?.force !== true
            ? {
                descriptions: {} as Record<string, string>,
                relations: {},
                errors: [],
                skipped: [],
                completedBatches: entry.mapProgress?.batches ?? [],
              }
            : await mapApi(
                llm,
                {
                  apiTitle: entry.title,
                  resources: pruned.resources,
                  ops,
                },
                {
                  completedBatches:
                    request.body?.force !== true && entry.mapProgress?.version === MAP_VERSION
                      ? entry.mapProgress.batches
                      : [],
                  onCheckpoint: (checkpoint) =>
                    deps.catalog!.put({
                      ...entry,
                      ops: entry.ops.map((op) =>
                        !op.description && checkpoint.descriptions[op.id]
                          ? { ...op, description: checkpoint.descriptions[op.id] }
                          : op,
                      ),
                      resources: mergeRelations(pruned.resources, checkpoint.relations),
                      mapVersion: undefined,
                      mapProgress: {
                        version: MAP_VERSION,
                        batches: [...checkpoint.completedBatches],
                      },
                    }),
                },
              );

        const mapped: CatalogEntry = {
          ...entry,
          ops: entry.ops.map((op) => {
            const written = result.descriptions[op.id];
            // The pass never overwrites an author's own words, and this is the
            // second place that holds — belt and braces on a shared artifact.
            return written && !op.description ? { ...op, description: written } : op;
          }),
          resources: mergeRelations(pruned.resources, result.relations),
          mappedAt: new Date().toISOString(),
          mapVersion: result.errors.length === 0 ? MAP_VERSION : undefined,
          mapProgress: { version: MAP_VERSION, batches: [...result.completedBatches] },
        };

        const saved = deps.catalog.put(mapped);
        const after = mapState(saved);

        return {
          ...after,
          ranPass: true,
          mappedAt: saved.mappedAt ?? null,
          descriptionsWritten: Object.keys(result.descriptions).length,
          relationsFound: Object.values(result.relations).reduce(
            (total, list) => total + list.length,
            0,
          ),
          /*
           * Batches fail independently, so a partial map is a real outcome and
           * has to say what it is missing rather than looking complete.
           */
          errors: [...result.errors],
          /*
           * Links the pass declined to record. Not errors — the pass worked
           * and refused to guess — but a missing relation needs a reason
           * attached or it reads as the mapper simply not noticing.
           */
          skipped: [...result.skipped],
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
