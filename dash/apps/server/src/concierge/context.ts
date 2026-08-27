import type { ChildCollection, ConciergeContext, DrillDownCandidate, InferredShape, JoinCandidate, ReadPlan } from "@freebirdai/dash-agent";
import type {
  CapabilityReport,
  CatalogEntry,
  ConnectionSpec,
  MappedField,
  PersistedShape,
} from "@freebirdai/dash-spec";
import { getOp, isStale, pathParamNames, relationGraph } from "@freebirdai/dash-spec";
import type { ChildLink, RelationGraph } from "@freebirdai/dash-spec";
import { estimateEnumeration, findFilterParam } from "../capabilities.js";

/**
 * What the concierge is allowed to ask about, assembled from what is on disk.
 *
 * The step machine is pure and speaks in ops; the capability report speaks in
 * resources and was written by the enumeration pass. This is the translation
 * between them, and it is the only place that has to know both vocabularies.
 *
 * Nothing here reads an API. Every fact comes from a report that already
 * exists, which is what lets a whole conversation be planned without spending
 * a single request — the read is a separate, priced, consented step.
 */

/** How many per-row calls a fan-out join is allowed. Matches `namedSource.fanOut`. */
const FAN_OUT_CAP = 25;

const toInferred = (shape: PersistedShape): InferredShape => ({
  rowsPath: shape.rowsPath,
  rowCount: shape.rowCount,
  schemaHash: shape.schemaHash,
  fields: shape.fields.map((field) => ({
    name: field.name,
    kinds: field.kinds,
    nullable: field.nullable,
    ...(field.format ? { format: field.format } : {}),
    distinct: field.distinct,
    // The report deliberately stores no values. Samples exist for the shape
    // inferrer's own use and are not persisted, so nothing that came off
    // somebody's API is being handed back to a model here.
    samples: [],
  })),
});

export interface ContextInput {
  readonly connections: readonly ConnectionSpec[];
  /** Reports keyed however the caller has them; matched by `report.connection`. */
  readonly reports: readonly CapabilityReport[];
  /**
   * Whether a connection's credentials are all stored.
   *
   * Injected rather than read here, because the vault is the server's and this
   * module has no business touching it. Absent means "assume it is fine",
   * which only affects whether a read is offered — never whether one happens.
   */
  readonly hasKey?: (connection: ConnectionSpec) => boolean;
  /**
   * The API maps, matched to a connection by its catalog id.
   *
   * This is what makes "keys and go" true. A map is a property of the *API* —
   * every endpoint, what each one is for, what its rows contain, and how they
   * relate — so it is the same for everybody and can be shared. The report is
   * a property of an *account*, and is now enrichment rather than the source:
   * it says which endpoints actually have rows here and how varied the values
   * are, neither of which should decide what somebody is allowed to build.
   */
  readonly maps?: readonly CatalogEntry[];
}

/**
 * A declared field list, in the shape the questions read.
 *
 * `distinct` is zero and `samples` is empty, and both are honest: nothing has
 * been looked at. Downstream that means a spec-only endpoint offers no
 * highlight candidates and no cardinality-based suggestion — which is right,
 * because those are claims about values nobody has seen.
 */
const fromMapped = (fields: readonly MappedField[]): InferredShape => ({
  rowsPath: "$",
  rowCount: 0,
  schemaHash: "",
  fields: fields.map((field) => ({
    name: field.name,
    kinds: field.kinds,
    nullable: field.nullable,
    ...(field.format ? { format: field.format } : {}),
    distinct: 0,
    samples: [],
  })),
});

/**
 * Declared fields fill in wherever sampling did not reach.
 *
 * Applied last, so a real sample always wins: it saw values, so it knows
 * formats and cardinality a declaration cannot state. What this covers is the
 * endpoint nobody sampled — because the account is empty of it, because the
 * key is not permitted, or because it cannot be called without an id at all.
 * None of those should decide what somebody is allowed to build.
 */
const applyDeclared = (
  declared: ReadonlyMap<string, readonly MappedField[]>,
  shapes: Record<string, InferredShape>,
): void => {
  for (const [opId, fields] of declared) {
    if (!shapes[opId] || shapes[opId]!.fields.length === 0) shapes[opId] = fromMapped(fields);
  }
};

/**
 * The map's relationships, read once, as the two things the concierge offers.
 *
 * Both used to be walked here by hand, each with its own idea of which side a
 * field lived on: a child section took its query parameter from
 * `relation.filterParam`, which by definition names a parameter on the *other*
 * endpoint. `relationGraph` is now the single reading — it walks each relation
 * in both directions once, de-duplicates the same fact recorded from both
 * ends, checks every link against the fields before offering it, and resolves
 * how each side is actually fetched.
 *
 * What is left here is translation: the graph speaks in links, the step
 * machine speaks in `ChildCollection` and `JoinCandidate`, and this is the
 * only place that has to know both.
 */
const graphFor = (
  map: CatalogEntry | undefined,
  shapes: Readonly<Record<string, InferredShape>>,
): RelationGraph | undefined => {
  if (!map) return undefined;

  /*
   * What each endpoint's rows carry, preferring what was actually sampled.
   *
   * A declared schema says what an API promises; a sample says what an account
   * returns, and only the second one knows a field is really an object with a
   * usable id inside. Falling back to the declaration is what keeps the
   * endpoints nobody can call — a child collection needs an id by definition —
   * from looking fieldless.
   */
  const fields: Record<string, readonly { name: string; kinds: readonly string[] }[]> = {};
  for (const op of map.ops) {
    if (op.fields?.length) fields[op.id] = op.fields;
  }
  for (const [opId, shape] of Object.entries(shapes)) {
    if (shape.fields.length > 0) fields[opId] = shape.fields;
  }

  return relationGraph({
    resources: map.resources,
    ops: map.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
    fields,
  });
};

/**
 * The records the map says can be opened, for a connection nobody has read.
 *
 * `report.drillDowns` was the only source, and it exists only after the priced
 * enumeration — so a freshly mapped connection could see every relationship in
 * an API and open none of them. That is the wrong way round: which endpoint
 * returns one record of a collection is a property of the API, shared by
 * everybody, and exactly what the map is for.
 *
 * The one fact a specification cannot state is which field holds a row's
 * identity, and `recordOf` reads that from the naming where nothing has been
 * sampled. A conventional reading fails visibly — the detail request 404s —
 * where the previous behaviour failed silently, by offering nothing at all.
 */
const recordsFromMap = (
  graph: RelationGraph | undefined,
  ops: ReadonlyMap<string, { readonly title: string }>,
): DrillDownCandidate[] => {
  if (!graph) return [];
  const out: DrillDownCandidate[] = [];

  for (const [opId, op] of ops) {
    const record = graph.recordOf(opId);
    if (!record) continue;
    out.push({
      resource: record.resource,
      title: op.title,
      listOp: opId,
      detailOp: record.op,
      idField: record.idField,
      detailParam: record.param,
      ...(record.labelField ? { labelField: record.labelField } : {}),
    });
  }
  return out;
};

/**
 * A child link in the vocabulary the step machine reads.
 *
 * `path` is passed in rather than read off the link, because the graph works
 * in resources and the path belongs to the op — and a candidate shown without
 * one reads as less real than the bare endpoints beside it in the index.
 */
const asChildCollection = (link: ChildLink, path?: string): ChildCollection => ({
  id: link.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64),
  parentOp: link.parentOp,
  title: link.title,
  op: link.op,
  ...(path ? { path } : {}),
  ...(link.resource ? { resource: link.resource } : {}),
  ...(link.parentIdField ? { parentIdField: link.parentIdField } : {}),
  ...(link.fetch.mode === "match"
    ? { linkField: link.fetch.field, linkKind: link.fetch.kind }
    : { param: link.fetch.param }),
});

/**
 * A peer link as a join, where both sides have fields to name columns with.
 *
 * The graph already proved both endpoints are callable bare and both link
 * fields resolve. What it does not know is whether anything has been read from
 * them here — and a join whose columns cannot be named is an offer that
 * renders blank, so that last check stays with the caller who holds the shapes.
 */
const asJoinCandidates = (
  graph: RelationGraph | undefined,
  shapes: Readonly<Record<string, InferredShape>>,
): JoinCandidate[] =>
  (graph?.peers ?? [])
    .filter(
      (peer) =>
        (shapes[peer.fromOp]?.fields.length ?? 0) > 0 &&
        (shapes[peer.toOp]?.fields.length ?? 0) > 0,
    )
    .map((peer) => ({
      id: peer.id,
      fromOp: peer.fromOp,
      toOp: peer.toOp,
      title: peer.title,
      leftField: peer.leftField,
      rightField: peer.rightField,
      /*
       * Fetched whole and matched in memory unless the target declares a real
       * parameter. `relationGraph` only ever reports one it read off the
       * endpoint's own declaration, so this can never be an invented name.
       */
      fetch: { mode: "filtered", param: peer.filterParam },
    }));

export const buildConciergeContext = (input: ContextInput): ConciergeContext => {
  const connections: Array<{ id: string; title: string }> = [];
  const ops: Array<{
    id: string;
    title: string;
    connection: string;
    path?: string;
    description?: string;
  }> = [];
  const shapes: Record<string, InferredShape> = {};
  const joins: JoinCandidate[] = [];
  const drillDowns: DrillDownCandidate[] = [];
  const children: ChildCollection[] = [];
  const searchable: Array<{ op: string; param: string }> = [];
  const rangeFilterable: Array<{ op: string; start: string; end?: string }> = [];
  const readPlans: ReadPlan[] = [];
  /*
   * What each API calls its fields, keyed by connection.
   *
   * The same lexicon the browser renders headers from — it lives on the map,
   * which is what makes it shareable. Carried here so an option card offering
   * a field and the column that field becomes cannot read as two things.
   */
  const labels: Record<string, Readonly<Record<string, string>>> = {};

  const reportFor = new Map(input.reports.map((report) => [report.connection, report]));
  const mapFor = new Map((input.maps ?? []).map((entry) => [entry.id, entry]));

  for (const connection of input.connections) {
    connections.push({ id: connection.id, title: connection.title });

    /*
     * The map for this connection, if one has been made.
     *
     * Matched on the catalog id it was created from, falling back to the
     * connection's own id — which is what `connectionFromCatalog` uses when it
     * is not disambiguating a second copy.
     */
    const map = mapFor.get(connection.catalog ?? connection.id) ?? mapFor.get(connection.id);
    const mappedOps = new Map((map?.ops ?? []).map((op) => [op.id, op]));
    if (map?.labels && Object.keys(map.labels).length > 0) labels[connection.id] = map.labels;
    /*
     * Which resource each op lists, taken from whichever side declares it.
     *
     * Only list ops appear here: a resource names one `listOp`, and a detail
     * endpoint returning a single record is not what a widget reads.
     */
    const resourceOfOp = new Map<string, string>();
    for (const resource of connection.resources ?? map?.resources ?? []) {
      if (resource.listOp) resourceOfOp.set(resource.listOp, resource.id);
    }
    /** Declared fields, held until the report has had first refusal. */
    const declaredShapes = new Map<string, readonly MappedField[]>();

    /*
     * Only endpoints that need nothing to be called.
     *
     * An op with a path parameter cannot be the *start* of a widget — there is
     * nobody to supply the id yet. It is still reachable as a drill-down,
     * where the row supplies it, so leaving it off this list removes a dead
     * end rather than a capability.
     */
    for (const op of connection.ops) {
      const resolved = getOp(connection, op.id);
      if (!resolved) continue;

      /*
       * What every endpoint returns, including the ones that need an id.
       *
       * Gathered before the filter below, and that ordering is the whole
       * point. `ops` is what a widget can be built *from*, so an endpoint that
       * cannot be called without an id is rightly absent. `shapes` is what we
       * know each endpoint *returns*, and that is worth having either way —
       * a child collection is param'd by definition, so collecting its shape
       * only for standalone endpoints meant no record ever found its children.
       */
      const declaredFields = mappedOps.get(op.id)?.fields;
      if (declaredFields && declaredFields.length > 0) declaredShapes.set(op.id, declaredFields);

      if (pathParamNames(resolved.path).length > 0) continue;
      const described = resolved.description ?? mappedOps.get(op.id)?.description;
      const resource = resourceOfOp.get(op.id);
      ops.push({
        id: op.id,
        title: resolved.title,
        connection: connection.id,
        path: resolved.path,
        ...(described ? { description: described } : {}),
        ...(resource ? { resource } : {}),
      });

    }

    const report = reportFor.get(connection.id);

    /*
     * What reading this one would cost, computed without touching it.
     *
     * `estimateEnumeration` is pure over the connection's own endpoints and
     * spends nothing, which is what lets the price be part of the question
     * rather than something discovered afterwards.
     */
    const estimate = estimateEnumeration(connection);
    readPlans.push({
      connection: connection.id,
      requests: estimate.estimatedRequests,
      estimatedMs: estimate.estimatedMs,
      alreadyRead: report !== undefined && !isStale(report, connection),
      stale: report !== undefined && isStale(report, connection),
      // No `hasKey` supplied means the caller is not in a position to know, so
      // the read stays on offer — refusing on a guess would be worse.
      needsKey: input.hasKey ? !input.hasKey(connection) : false,
    });

    if (!report) {
      /*
       * No sampling has happened here, and that is no longer a dead end.
       *
       * Everything the questions need — endpoints, what they return, how they
       * relate — is a property of the API, and the map has it. The report adds
       * what only this account can say; its absence costs cardinality and
       * highlight candidates, not the ability to build.
       */
      applyDeclared(declaredShapes, shapes);
      const graph = graphFor(map, shapes);
      joins.push(...asJoinCandidates(graph, shapes));
      children.push(
        ...(graph?.children ?? []).map((link) =>
          asChildCollection(link, mappedOps.get(link.op)?.path),
        ),
      );
      drillDowns.push(...recordsFromMap(graph, mappedOps));
      continue;
    }

    /*
     * Shapes are stored per resource, because that is what sampling walks.
     * The questions need them per op, and both of a resource's endpoints
     * return the same fields — a detail response is one row of its own list —
     * so both map to the sample that was actually taken.
     */
    const listOpOf = new Map<string, string>();
    for (const resource of report.resources) {
      const shape = report.shapes[resource.id];
      if (!shape) continue;
      const inferred = toInferred(shape);
      if (resource.listOp) {
        shapes[resource.listOp] = inferred;
        listOpOf.set(resource.id, resource.listOp);
      }
      if (resource.detailOp) shapes[resource.detailOp] = inferred;
    }

    for (const offer of report.drillDowns) {
      drillDowns.push({
        resource: offer.resource,
        title: offer.title,
        listOp: offer.listOp,
        detailOp: offer.detailOp,
        idField: offer.idField,
        detailParam: offer.detailParam,
        ...(offer.labelField ? { labelField: offer.labelField } : {}),
      });
    }

    for (const offer of report.joins) {
      const fromOp = listOpOf.get(offer.from);
      const toOp = listOpOf.get(offer.to);
      // Both sides need a collection endpoint with a sample behind it. Without
      // one there is nothing to join and nothing to name the columns.
      if (!fromOp || !toOp || fromOp === toOp) continue;

      const target = report.resources.find((resource) => resource.id === offer.to);

      /*
       * A fan-out needs somewhere to put the key.
       *
       * Without a filter parameter the only route is calling the other side
       * once per row — and that only works if the other side accepts the key
       * as an input. The by-id endpoint's own path parameter is that input.
       * When there is neither, the join is not offered at all, because an
       * offer that cannot be built is worse than a missing one.
       */
      const fetch = offer.needsFanOut
        ? target?.detailOp && target.detailParam
          ? ({ mode: "perRow", param: target.detailParam, maxRows: FAN_OUT_CAP } as const)
          : null
        : ({ mode: "filtered", param: offer.filterParam } as const);
      if (!fetch) continue;

      joins.push({
        id: `${fromOp}:${offer.foreignField}:${toOp}`,
        fromOp,
        toOp: fetch.mode === "perRow" ? (target!.detailOp as string) : toOp,
        title: offer.title,
        leftField: offer.foreignField,
        rightField: offer.targetField,
        fetch,
      });
    }

    searchable.push(...report.searchable);
    rangeFilterable.push(...report.rangeFilterable);

    applyDeclared(declaredShapes, shapes);
    const graph = graphFor(map, shapes);
    joins.push(...asJoinCandidates(graph, shapes));
    children.push(
        ...(graph?.children ?? []).map((link) =>
          asChildCollection(link, mappedOps.get(link.op)?.path),
        ),
      );

    /*
     * The report's offers win. It saw the id field rather than reading it off
     * a name, and it lists only resources that actually returned rows on this
     * account. The map fills in every collection it never reached.
     */
    const seen = new Set(drillDowns.map((offer) => offer.listOp));
    drillDowns.push(
      ...recordsFromMap(graph, mappedOps).filter((offer) => !seen.has(offer.listOp)),
    );
  }

  return {
    connections,
    ops,
    shapes,
    joins,
    drillDowns,
    children,
    searchable,
    rangeFilterable,
    readPlans,
    labels,
  };
};
