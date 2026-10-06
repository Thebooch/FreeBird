import type {
  EntityResult,
  LlmAdapter,
  ReferenceResult,
} from "./agent/index.js";
import {
  classifyReferences,
  describeEntities,
} from "./agent/index.js";
import type { CatalogEntry, EntitySpec, ResourceSpec } from "@freebirdai/connect-spec";
import { ENTITY_VERSION, MAP_VERSION } from "@freebirdai/connect-spec";
import type { CatalogStore } from "./catalog.js";

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
  /**
   * Catalog ids whose record types are being described right now.
   *
   * The describing pass is one long request — minutes on a large API — and
   * nothing else could tell it was running: the wizard showed "Integration
   * created" and then sat with its buttons disabled while the pass ran
   * underneath. Shared with onboarding, which must not divide an API into
   * parts while half its record types are still arriving.
   */
  readonly describing?: Set<string>;
  /**
   * The record types were just described. What an account read showed about
   * them can be applied now — a read that finished first had nothing to apply
   * it to.
   */
  readonly onDescribed?: (catalogId: string) => void;
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
 * that one real API's map recorded every nested object as a string, so
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
      ...(previous.readAt && !entity.readAt ? { readAt: previous.readAt } : {}),
      fields: entity.fields.map((field) => {
        const older = was.get(field.path);
        /*
         * What a response showed about this field is evidence about the API,
         * not about the prose describing it, so a re-description keeps it.
         */
        const kept =
          older?.observed && !field.observed ? { ...field, observed: older.observed } : field;
        const reference = kept.reference;
        if (!reference || !older?.reference?.verified) return kept;
        const sameLink =
          older.reference.entity === reference.entity && older.reference.holds === reference.holds;
        return sameLink ? { ...kept, reference: { ...reference, verified: true } } : kept;
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
  /** Record types whose real rows an account read has seen. */
  read: number;
  /** Fields whose real values turned out not to be what the docs declared. */
  corrected: number;
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
    read: entities.filter((entity) => entity.readAt).length,
    corrected: entities.reduce(
      (total, entity) =>
        total +
        entity.fields.filter((field) => field.observed?.coercion || field.observed?.semantic).length,
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
export const schemaMoved = (
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
export const mergeRelations = (
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


/**
 * The describing pass over one catalog entry: record types, then which of
 * their fields point at other records, checkpointed as it goes.
 *
 * Shared by the route a person starts and by the integration check, which
 * starts it by itself once a read has shown fields the documentation never
 * declared. Batches are keyed by their content, so a pass that is not forced
 * describes only the resources whose fields are new, and keeps the rest.
 */
export const describeCatalogRecords = async (
  catalog: NonNullable<MapRouteDeps["catalog"]>,
  entry: CatalogEntry,
  llm: LlmAdapter,
  force: boolean,
) => {
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
    const current = catalog.get(entry.id) ?? entry;
    catalog.put({
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
  const saved = catalog.put({
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
};

/**
 * Describe what has no description yet, by itself — for the integration check.
 *
 * Nothing to press: the check read endpoints whose documentation declared no
 * fields, recorded what the reads showed, and this describes the record types
 * that now can be. One run at a time per API, like the route's.
 */
export const describeMissingRecords = async (
  deps: Pick<MapRouteDeps, "catalog" | "llm" | "describing" | "onDescribed">,
  entryId: string,
): Promise<void> => {
  const entry = deps.catalog?.get(entryId);
  const llm = deps.llm("entity");
  if (!deps.catalog || !entry || !llm || entry.resources.length === 0 || deps.describing?.has(entry.id)) return;
  deps.describing?.add(entry.id);
  try {
    await describeCatalogRecords(deps.catalog, entry, llm, false);
  } finally {
    deps.describing?.delete(entry.id);
    deps.onDescribed?.(entry.id);
  }
};
