import type { ConciergeContext } from "@freebirdai/dash-agent";
import type { Reference, ToolBinding } from "./types.js";

/**
 * What each connected API can actually be asked to do — derived, never authored.
 *
 * This is the translation layer, and it is the whole reason there is one `read`
 * rather than one per API. A binding is assembled entirely from things the map
 * already worked out: which endpoint returns one record, which input takes its
 * identifier, which field on a row carries that identifier, and which fields
 * point at other records. None of that is vendor knowledge. An API nobody here
 * has seen produces bindings by the same code, or produces none and says so.
 *
 * Deliberately not a registry anyone writes into. The moment a binding can be
 * hand-added per API, the pressure is to hand-add behaviour with it, and the
 * per-API tool set arrives through the back door. Everything here comes from
 * the resource graph; an API that cannot be read this way is a gap in the map,
 * which is a fixable and shared thing, rather than a gap in this file, which
 * would be neither.
 */

export interface BindingsInput {
  readonly context: ConciergeContext;
  /** Restrict to one connection. The direct-request case. */
  readonly connection?: string | undefined;
  /**
   * How a connection paginates, so those inputs are not offered as filters.
   *
   * A function rather than a value because the caller holds the connection
   * specs and this module deliberately does not — it reads the map, and the
   * map is the part that is shareable.
   */
  readonly pagination?: ((connection: string) => unknown) | undefined;
}

/**
 * Turn a resource noun into the handle a person would type.
 *
 * Qualified only when two connections both expose that noun — the same rule
 * widget handles follow, and for the same reason: "task" reads as a thing and
 * "task--acme-crm" reads as configuration, so the second is worth paying only
 * where the first would be ambiguous.
 */
const handles = (
  entries: readonly { resource: string; connection: string }[],
): Map<string, string> => {
  const seen = new Map<string, Set<string>>();
  for (const entry of entries) {
    const owners = seen.get(entry.resource) ?? new Set<string>();
    owners.add(entry.connection);
    seen.set(entry.resource, owners);
  }
  const out = new Map<string, string>();
  for (const entry of entries) {
    const shared = (seen.get(entry.resource)?.size ?? 0) > 1;
    out.set(
      `${entry.connection}|${entry.resource}`,
      shared ? `${entry.resource}--${entry.connection}` : entry.resource,
    );
  }
  return out;
};

/**
 * Every record that can be opened by its identifier.
 *
 * A drill-down is exactly this fact — a collection, the endpoint returning one
 * of its records, the input that takes the id and the field on the row that
 * supplies it — recorded once when the API was mapped and true of every API
 * that has records at all.
 */
export const readBindings = (input: BindingsInput): ToolBinding[] => {
  const { context } = input;
  const opById = new Map(context.ops.map((op) => [op.id, op]));
  const connectionTitle = new Map(context.connections.map((entry) => [entry.id, entry.title]));

  /*
   * Keyed off the *collection*, not the record endpoint.
   *
   * `ConciergeContext.ops` deliberately lists only endpoints that need nothing
   * to be called, because that is what a widget can be built from — and a
   * record endpoint needs an id by definition, so none of them are there. The
   * first version looked the detail op up in that list and derived nothing at
   * all from an API with eighty-two openable records.
   *
   * The collection is the right key anyway: it is what the map describes, and
   * what it says is what the records ARE, which is the sentence a binding
   * needs.
   */
  const offers = context.drillDowns
    .map((offer) => ({ offer, list: opById.get(offer.listOp) }))
    .filter(
      (entry): entry is { offer: (typeof context.drillDowns)[number]; list: NonNullable<typeof entry.list> } =>
        entry.list !== undefined,
    )
    .filter((entry) => !input.connection || entry.list.connection === input.connection);

  const named = handles(
    offers.map((entry) => ({ resource: entry.offer.resource, connection: entry.list.connection })),
  );

  const seen = new Set<string>();
  const bindings: ToolBinding[] = [];
  for (const { offer, list } of offers) {
    const id = named.get(`${list.connection}|${offer.resource}`) ?? offer.resource;
    // Two drill-downs onto the same resource is a mapping duplicate, not two
    // things to offer. The first wins, silently, because a model choosing
    // between two identical handles is worse than losing one.
    if (seen.has(id)) continue;
    seen.add(id);

    bindings.push({
      verb: "read",
      id,
      connection: list.connection,
      connectionTitle: connectionTitle.get(list.connection) ?? list.connection,
      resource: offer.resource,
      title: offer.title,
      op: offer.detailOp,
      describes: list.description ?? list.path ?? "",
      idParam: offer.detailParam,
      idField: offer.idField,
      listOp: offer.listOp,
    });
  }
  return bindings;
};

/**
 * Inputs the pagination strategy owns.
 *
 * Excluded from what a query may set, because the adapter is already driving
 * them — offering `limit` to a model that has no idea a page cap exists is an
 * invitation to fight the fetcher, and the resulting "I only got 20" is
 * unattributable from either side.
 */
const paginationParams = (pagination: unknown): Set<string> => {
  const spec = pagination as { param?: string; limitParam?: string } | undefined;
  return new Set([spec?.param, spec?.limitParam].filter((name): name is string => Boolean(name)));
};

/**
 * Every collection that can be narrowed before it is read.
 *
 * Built from roles rather than names, which is the whole reason one
 * implementation can serve every API: `paramDefSchema` says it outright —
 * every vendor spells the same idea differently, `q` / `search` / `filter`,
 * `since` / `start_date` / `created[gte]`, and recording the role once means a
 * caller can offer "narrow this to a date range" without knowing the vendor's
 * vocabulary.
 *
 * Where a role is absent the input is still offered as a plain filter, because
 * an API declaring a query parameter with a name, a type and a description has
 * told us it narrows results — that is what a query parameter is. Only two
 * things are held back: the identifier, which belongs to `read`, and whatever
 * the pagination strategy is already driving.
 */
export const queryBindings = (input: BindingsInput): ToolBinding[] => {
  const { context } = input;
  const connectionTitle = new Map(context.connections.map((entry) => [entry.id, entry.title]));
  const resourceOf = new Map<string, string>();
  for (const offer of context.drillDowns) resourceOf.set(offer.listOp, offer.resource);

  const usable = context.ops.filter(
    (op) =>
      (op.params?.length ?? 0) > 0 && (!input.connection || op.connection === input.connection),
  );

  const named = handles(
    usable.map((op) => ({ resource: resourceOf.get(op.id) ?? op.id, connection: op.connection })),
  );

  const seen = new Set<string>();
  const bindings: ToolBinding[] = [];
  for (const op of usable) {
    const resource = resourceOf.get(op.id) ?? op.id;
    const id = named.get(`${op.connection}|${resource}`) ?? resource;
    if (seen.has(id)) continue;

    const params = op.params ?? [];
    const owned = paginationParams(input.pagination?.(op.connection));
    const search = params.find((param) => param.role === "search");
    const start = params.find((param) => param.role === "rangeStart");
    const end = params.find((param) => param.role === "rangeEnd");
    const sort = params.find((param) => param.role === "sort");
    const filters = params.filter(
      (param) =>
        param.in === "query" &&
        param.role !== "id" &&
        param.role !== "search" &&
        param.role !== "rangeStart" &&
        param.role !== "rangeEnd" &&
        param.role !== "sort" &&
        !owned.has(param.name),
    );

    // Nothing to narrow by is not a query binding. Offering one would promise
    // a filter the endpoint cannot apply.
    if (!search && !start && !sort && filters.length === 0) continue;
    seen.add(id);

    bindings.push({
      verb: "query",
      id,
      connection: op.connection,
      connectionTitle: connectionTitle.get(op.connection) ?? op.connection,
      resource,
      title: op.title,
      op: op.id,
      describes: op.description ?? op.path ?? "",
      ...(search ? { search: search.name } : {}),
      ...(start ? { range: { start: start.name, ...(end ? { end: end.name } : {}) } } : {}),
      ...(sort ? { sort: sort.name } : {}),
      ...(filters.length > 0 ? { filters } : {}),
    });
  }
  return bindings;
};

/** All bindings, for every verb this server can currently perform. */
export const bindingsFor = (input: BindingsInput): ToolBinding[] => [
  ...readBindings(input),
  ...queryBindings(input),
];

/** The binding that opens a record from this collection, when one exists. */
export const expansionFor = (
  bindings: readonly ToolBinding[],
  op: string,
): ToolBinding | null =>
  bindings.find((binding) => binding.verb === "read" && binding.listOp === op) ?? null;

/** The binding a handle names, resolved against the list and never approximated. */
export const bindingFor = (
  bindings: readonly ToolBinding[],
  id: string,
): ToolBinding | null => bindings.find((binding) => binding.id === id) ?? null;

/**
 * Which fields on a record point at other records that can be opened.
 *
 * Only proven links. The relation graph recorded a join when it established
 * that one endpoint's rows carry a key another endpoint's rows match, and a
 * field that merely *looks* like a foreign key is not evidence — a wrong
 * reference silently opens an unrelated record and reads exactly like a right
 * one, which is the failure this refuses to risk.
 *
 * `kind` is carried rather than inferred at read time because the two
 * non-scalar shapes fail quietly: an array-valued key never equals an id, and
 * an object-valued one stringifies to `[object Object]`. Both look like a
 * record with nothing attached.
 */
export const referencesFrom = (
  context: ConciergeContext,
  op: string,
  bindings: readonly ToolBinding[],
): Reference[] => {
  const references: Reference[] = [];
  const taken = new Set<string>();

  for (const join of context.joins) {
    if (join.fromOp !== op) continue;
    const to = bindings.find(
      (binding) => binding.verb === "read" && (binding.op === join.toOp || binding.listOp === join.toOp),
    );
    if (!to) continue;
    const key = `${to.id}|${join.leftField}`;
    if (taken.has(key)) continue;
    taken.add(key);
    references.push({
      to,
      field: join.leftField,
      // A join proves the key matches; what shape it is stored in is a
      // separate fact and the graph does not always carry it here. Scalar is
      // the safe reading because `identityValue` inspects the actual value and
      // handles the other two whatever this says.
      kind: "scalar",
      title: join.title,
    });
  }

  /*
   * Collections that hang off a record are the mirror image of a join and
   * record the same thing from the other side: `parentIdField` is the field on
   * the parent's row that fills the child's input. Where that field also
   * identifies a readable record, it is a reference.
   */
  for (const child of context.children) {
    if (child.parentOp !== op || !child.parentIdField) continue;
    const to = bindings.find(
      (binding) => binding.verb === "read" && (binding.op === child.op || binding.listOp === child.op),
    );
    if (!to) continue;
    const key = `${to.id}|${child.parentIdField}`;
    if (taken.has(key)) continue;
    taken.add(key);
    references.push({
      to,
      field: child.parentIdField,
      kind: child.linkKind ?? "scalar",
      title: child.title,
    });
  }

  return references;
};
