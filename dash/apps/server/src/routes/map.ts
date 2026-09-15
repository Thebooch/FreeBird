import type {
  EntityResult,
  LlmAdapter,
  ReferenceResult,
} from "@freebirdai/dash-agent";
import {
  classifyReferences,
  chooseViews,
  describeEntities,
  mapApi,
  pruneAmbiguousRelations,
} from "@freebirdai/dash-agent";
import type { CatalogEntry, EntitySpec, ResourceSpec } from "@freebirdai/dash-spec";
import { ENTITY_VERSION, MAP_VERSION, pathParamNames } from "@freebirdai/dash-spec";
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
  readonly onRefreshed?: (previous: CatalogEntry, fresh: CatalogEntry) => void;
  readonly catalog: CatalogStore | undefined;
  /**
   * The model for one action. Null means no AI key is configured.
   *
   * Takes the action's name because the passes here are not alike: finding how
   * an API's resources relate is reasoning over hundreds of endpoints, naming
   * its fields is a vocabulary exercise a cheap model does well, and describing
   * what its records *are* is the hardest reading of the three. They were one
   * call resolving to one model; the argument is what separates them.
   */
  readonly llm: (task: "map" | "entity") => LlmAdapter | null;
  /**
   * SSRF-guarded fetch for re-reading a spec. Absent disables the refresh.
   *
   * The same entry point discovery uses, injected for the same reason: this
   * module has no business deciding what a server may fetch.
   */
  readonly fetchDocument?:
    | ((url: string) => Promise<{ status: number; text: string; url: string }>)
    | undefined;
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
    };
  });
};

/**
 * A re-description, with what was *earned* kept.
 *
 * Describing an API again is cheap to ask for and expensive to get wrong: a
 * re-run that overwrote everything would throw away the one thing a model
 * cannot produce — evidence. Verification comes from real rows on a real
 * account, and nothing in a second reading of the same specification is
 * evidence against it.
 *
 * But it is evidence about a *particular* claim, so it survives only while
 * that claim is unchanged:
 *
 * - An entity's `verified` and its `identity.observed` mean "a real response
 *   carried this field". If the re-run picked a different identity field, the
 *   old sighting says nothing about the new one and is dropped.
 * - A reference's `verified` means "a real id resolved against that record
 *   type's own endpoint". If the re-run points the field somewhere else, or
 *   changes how the id is held, the old resolution proves nothing about the
 *   new link.
 *
 * Everything a model writes — names, descriptions, labels, grouping — is taken
 * fresh. A re-run is asked for precisely because the newer reading is wanted,
 * and keeping the old prose would make the pass unable to improve anything.
 *
 * A record type the fresh description no longer has is dropped: it describes
 * nothing, and carrying its verification forward would be carrying proof about
 * something that is gone.
 */
export const mergeDescribedEntities = (
  existing: readonly EntitySpec[],
  fresh: readonly EntitySpec[],
): EntitySpec[] => {
  const before = new Map(existing.map((entity) => [entity.id, entity]));

  return fresh.map((entity) => {
    const previous = before.get(entity.id);
    if (!previous) return entity;

    const identity = entity.identity;
    const sameIdentity =
      previous.identity !== undefined &&
      identity !== undefined &&
      previous.identity.field === identity.field;

    const was = new Map(previous.fields.map((field) => [field.path, field]));

    return {
      ...entity,
      ...(sameIdentity && previous.identity?.observed && identity
        ? { identity: { ...identity, observed: true } }
        : {}),
      verified: sameIdentity ? previous.verified : false,
      fields: entity.fields.map((field) => {
        const reference = field.reference;
        const older = was.get(field.path)?.reference;
        if (!reference || !older?.verified) return field;
        const sameLink = older.entity === reference.entity && older.holds === reference.holds;
        return sameLink ? { ...field, reference: { ...reference, verified: true } } : field;
      }),
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
} => ({
  mapped: entry.mapVersion !== undefined,
  // A pass that has changed shape since is worth running again.
  stale: entry.mapVersion !== undefined && entry.mapVersion < MAP_VERSION,
  endpoints: entry.ops.length,
  described: entry.ops.filter((op) => op.description).length,
  withFields: entry.ops.filter((op) => (op.fields?.length ?? 0) > 0).length,
});

/**
 * Whether this API's records have been described, and how well.
 *
 * Tracked separately from the map and the labels, on the same reasoning that
 * separates those two: three passes that cost different money and answer
 * different questions must not be able to mark each other stale. A pass that
 * changes shape here should not invite a re-run of the relation map, which
 * does not produce any of this.
 *
 * The counts are the honest version of "is this integration ready?" — how many
 * record types are described, how many can say what identifies one, how many
 * can say a record's *name*, and how many fields point at another record.
 * Those four are exactly what everything downstream needs, so a low number
 * here is a specific, fixable thing rather than a vague sense that the
 * integration is thin.
 */
export const entityState = (
  entry: CatalogEntry,
): {
  described: boolean;
  stale: boolean;
  entities: number;
  withIdentity: number;
  withName: number;
  references: number;
  fieldsDescribed: number;
  /** Record types a live account has confirmed the identity of. */
  verified: number;
  /** Links a real id actually resolved through. */
  referencesVerified: number;
} => {
  const entities = entry.entities ?? [];
  return {
    /*
     * Whether there are record types, not whether a version stamp is set.
     *
     * The stamp means "the current pass finished cleanly", which is a
     * different question and not the one anybody looking at this screen is
     * asking. Read off the stamp, an API with 108 described record types whose
     * last run was partial — or whose stamp a re-read cleared — was reported
     * as "nothing here has been described yet", which is simply untrue and
     * offers to spend money redoing work that is already done.
     */
    described: entities.length > 0,
    /*
     * Worth running again: either the pass has moved on since, or it never
     * finished. Both are "there is more to get", which is what a reader can
     * act on; which of the two it is belongs in the run's own report.
     */
    stale:
      entities.length > 0 &&
      (entry.entityVersion === undefined || entry.entityVersion < ENTITY_VERSION),
    entities: entities.length,
    withIdentity: entities.filter((entity) => entity.identity).length,
    withName: entities.filter((entity) => entity.display).length,
    references: entities.reduce(
      (total, entity) => total + entity.fields.filter((field) => field.reference).length,
      0,
    ),
    fieldsDescribed: entities.reduce(
      (total, entity) => total + entity.fields.filter((field) => field.description).length,
      0,
    ),
    /*
     * What a real account has settled, as opposed to what a model believes.
     * Reported separately from the counts above because the difference is the
     * whole question somebody is asking before they share this: a description
     * can be confidently wrong in ways no amount of re-reading would reveal.
     */
    verified: entities.filter((entity) => entity.verified).length,
    referencesVerified: entities.reduce(
      (total, entity) =>
        total + entity.fields.filter((field) => field.reference?.verified).length,
      0,
    ),
  };
};

/**
 * Carry the values a refreshed spec declares onto the record types.
 *
 * Deterministic, free, and deliberately not left to the describing pass. That
 * a field is one of "Active", "Ended" is a fact the specification states
 * outright — nobody should pay a model to read it back, and nobody should have
 * to re-describe a whole API to pick it up when the vendor adds a status.
 *
 * Only ever the declared set. What an *account* has is a different question
 * and belongs to that install, never to a shared artifact.
 *
 * Matched by field path against the endpoints a record type reads from, which
 * is the same join `fieldsOfResource` makes. A field the fresh spec no longer
 * constrains has its values dropped rather than kept: a stale closed set is
 * worse than none, because a strip built from one folds everything it missed
 * into "Other".
 */
export const withDeclaredValues = (
  entities: readonly EntitySpec[],
  resources: readonly ResourceSpec[],
  ops: readonly CatalogEntry["ops"][number][],
): EntitySpec[] => {
  const opById = new Map(ops.map((op) => [op.id, op]));
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));

  return entities.map((entity) => {
    const resource = resourceById.get(entity.resource);
    const declared = new Map<string, readonly string[]>();
    for (const id of [resource?.listOp, resource?.detailOp]) {
      for (const field of (id ? opById.get(id)?.fields : undefined) ?? []) {
        if (field.values && field.values.length > 0 && !declared.has(field.name)) {
          declared.set(field.name, field.values);
        }
      }
    }
    /*
     * What the endpoints actually declare, so a field they no longer do can be
     * dropped. This is evidence, not ignorance: an endpoint with no declared
     * fields tells us nothing and is skipped, exactly as a link against an
     * unknown row list is allowed through rather than refused.
     *
     * The case that forced it: an importer misread a by-id response and put
     * `Number` and `Type` on a record type that has forty fields. Re-reading
     * the spec fixed the endpoint, and without this the record type kept the
     * two bogus fields until somebody paid to describe the whole API again.
     */
    const known = new Set<string>();
    let sawAny = false;
    for (const id of [resource?.listOp, resource?.detailOp]) {
      const fields = (id ? opById.get(id)?.fields : undefined) ?? [];
      if (fields.length === 0) continue;
      sawAny = true;
      for (const field of fields) known.add(field.name);
    }

    /*
     * Never a field the record type points at.
     *
     * `identity`, `display` and `views` are all validated against the field
     * list, so pruning one they name makes the record type unparseable — and
     * the write that was meant to *fix* an entry would fail it instead. A
     * referenced field that is genuinely wrong is rarer, survives here, and is
     * now drawn around rather than blanking the page.
     */
    const referenced = new Set<string>(
      [
        entity.identity?.field,
        ...(entity.display?.title ?? []),
        entity.display?.subtitle,
        entity.display?.status,
        entity.display?.image,
        ...entity.views.columns,
        ...entity.views.facets,
        entity.views.sort?.field,
        entity.views.timeField,
        ...entity.views.record.facts,
        ...entity.views.record.groups.flatMap((group) => group.fields),
      ].filter((path): path is string => typeof path === "string"),
    );

    const prunable = (path: string): boolean => !known.has(path) && !referenced.has(path);
    const stale = sawAny ? entity.fields.filter((field) => prunable(field.path)) : [];
    if (
      stale.length === 0 &&
      declared.size === 0 &&
      entity.fields.every((field) => field.values.length === 0)
    ) {
      return entity;
    }

    return {
      ...entity,
      fields: entity.fields
        .filter((field) => !sawAny || !prunable(field.path))
        .map((field) => {
        const values = declared.get(field.path) ?? [];
        // Cleared rather than deleted: the schema defaults this to an empty
        // array, so "no declared set" and "the key is absent" are the same
        // thing once parsed.
        if (values.length === 0) {
          return field.values.length === 0 ? field : { ...field, values: [] };
        }
        return { ...field, values: [...values] };
      }),
    };
  });
};

/**
 * Has the schema moved in a way the descriptions were a claim about?
 *
 * Not a deep compare of the whole endpoint list, which is what this was. A
 * re-read that picks up nothing but a **declared set of values** changes the
 * JSON and changes nothing anybody described: the fields are the same fields
 * and their prose is still true. Comparing everything meant the free half of a
 * refresh marked the expensive half stale and invited somebody to re-describe
 * a hundred record types to learn that a status has a fourth value.
 *
 * What does count is a field appearing, disappearing or changing what it
 * holds — then a description really is a claim about something else.
 */
const schemaMoved = (
  before: readonly CatalogEntry["ops"][number][],
  after: readonly CatalogEntry["ops"][number][],
): boolean => {
  const shape = (ops: readonly CatalogEntry["ops"][number][]) =>
    JSON.stringify(
      ops.map((op) => ({
        id: op.id,
        path: op.path,
        params: op.params,
        fields: (op.fields ?? []).map((field) => ({
          name: field.name,
          kinds: field.kinds,
          format: field.format,
          nullable: field.nullable,
        })),
      })),
    );
  return shape(before) !== shape(after);
};

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
      relations: [
        ...resource.relations,
        ...extra.filter((relation) => !known.has(relation.resource)),
      ],
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

        const saved = deps.catalog.put({
          ...entry,
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

        const ops = entry.ops.map((op) => ({
          id: op.id,
          title: op.title,
          path: op.path,
          ...(op.description ? { description: op.description } : {}),
          ...(op.fields ? { fields: op.fields } : {}),
        }));

        /*
         * One progress list for both passes.
         *
         * Safe because a batch key is a content hash: each pass recognises
         * only its own and ignores the other's, so a resumed run picks up
         * wherever it stopped without either pass having to know the other
         * exists.
         */
        const batches =
          !force && entry.entityProgress?.version === ENTITY_VERSION
            ? entry.entityProgress.batches
            : [];

        const checkpoint = (entities: readonly CatalogEntry["entities"][number][], done: readonly string[]): void => {
          const current = deps.catalog!.get(entry.id) ?? entry;
          deps.catalog!.put({
            ...current,
            entities: [...entities],
            // Cleared while a pass is mid-flight: a half-described API must
            // not read as finished if the next batch never lands.
            entityVersion: undefined,
            entityProgress: { version: ENTITY_VERSION, batches: [...done] },
          });
        };

        const described = await describeEntities(
          llm,
          { apiTitle: entry.title, resources: entry.resources, ops },
          {
            completedBatches: batches,
            existing: entry.entities,
            onCheckpoint: (result: EntityResult) =>
              checkpoint(result.entities, result.completedBatches),
          },
        );

        /*
         * Where each record type's rows live, so two collections sharing a
         * noun can be told apart by their section of the API. The same
         * evidence `resolveSameNoun` reads, handed to the model as the only
         * thing that distinguishes them.
         */
        const pathOf = (id: string): string | undefined => {
          const listOp = entry.resources.find((resource) => resource.id === id)?.listOp;
          return listOp ? ops.find((op) => op.id === listOp)?.path : undefined;
        };

        const linked =
          described.entities.length > 0
            ? await classifyReferences(
                llm,
                { apiTitle: entry.title, entities: described.entities, pathOf },
                {
                  completedBatches: batches,
                  onCheckpoint: (result: ReferenceResult) =>
                    checkpoint(result.entities, [
                      ...described.completedBatches,
                      ...result.completedBatches,
                    ]),
                },
              )
            : {
                entities: described.entities,
                errors: [] as readonly string[],
                skipped: [] as readonly string[],
                completedBatches: [] as readonly string[],
                considered: 0,
                linked: 0,
              };

        const errors = [...described.errors, ...linked.errors];
        const saved = deps.catalog.put({
          ...entry,
          /*
           * Merged rather than replaced: a re-description must not throw away
           * evidence gathered from a live account, which is the one thing a
           * model cannot produce.
           */
          entities: mergeDescribedEntities(entry.entities ?? [], linked.entities),
          entitiesAt: new Date().toISOString(),
          // Only a clean run marks the pass done; a partial one stays
          // resumable and says what it is missing.
          entityVersion: errors.length === 0 ? ENTITY_VERSION : undefined,
          entityProgress: {
            version: ENTITY_VERSION,
            batches: [...described.completedBatches, ...linked.completedBatches],
          },
          updatedAt: new Date().toISOString(),
        });

        return {
          ...entityState(saved),
          ranPass: true,
          entitiesAt: saved.entitiesAt ?? null,
          /*
           * How many fields were *asked* about against how many became links.
           * The difference is the honest part: a candidate the model refused
           * is a field that looks like a reference and is not one, and that
           * number being large is information rather than a fault.
           */
          considered: linked.considered,
          linked: linked.linked,
          errors,
          /*
           * Readings the passes declined. Not errors — they worked and refused
           * to guess — but a record type left unnamed or a link left unmade
           * needs a reason attached or it reads as the pass not noticing.
           */
          skipped: [...described.skipped, ...linked.skipped],
        };
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
