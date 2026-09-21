import type { ColumnMeta, ColumnReference, ResolvedParams } from "@freebirdai/dash-spec";
import { queryKey, referenceIds, targetOfRow } from "@freebirdai/dash-spec";
import type { Row } from "@freebirdai/dash-runtime";

/**
 * Fetching the names behind the ids in a table.
 *
 * Three ways a name arrives, tried in this order because they cost wildly
 * different amounts:
 *
 * 1. **It is already on the row.** Plenty of APIs embed a name beside the id —
 *    `RentalManager.Id` next to `RentalManager.FirstName`. Free, and on the
 *    real Buildium map this covers 43 of the links.
 * 2. **It was fetched.** One request per distinct id, bounded and deduplicated,
 *    through the ordinary query cache — so two widgets naming the same vendor
 *    resolve it once, and a record already open costs nothing.
 * 3. **Neither.** The cell reads "Vendor 4711" rather than `4711`. Still not
 *    the name, but it says what kind of thing the number is, which is the
 *    difference between an opaque value and a legible one.
 *
 * The cap is the load-bearing part. This is the first thing in the design that
 * spends **API requests** in proportion to what is on screen rather than model
 * tokens, and an uncapped version turns a hundred-row table with three
 * reference columns into three hundred calls against somebody's rate limit.
 * So: a stated limit, the rows the reader sees first, and the fallback above
 * for everything past it.
 *
 * Deliberately **not** an index across widgets yet. Once a vendors table has
 * loaded, the names on a tasks table beside it could be free — the rows are
 * already in the cache — but that needs an id-keyed index populated by every
 * fetch, and claiming it before it exists would be claiming a saving nobody
 * is getting. A later slice.
 */

/**
 * How many distinct records one widget will look up.
 *
 * The same number `namedSource.fanOut` uses, and for the same reason: it is
 * where a helpful embellishment becomes a burst of traffic nobody asked for.
 */
export const MAX_LOOKUPS = 25;

/** One record a view needs the name of. */
export interface ReferenceLookup {
  readonly connection: string;
  readonly op: string;
  readonly param: string;
  readonly id: string | number;
  /** The record type, so a caller can index what came back. */
  readonly target: string;
  /** The column whose values these ids came from. */
  readonly column: string;
  /** The cache key this lookup will occupy. */
  readonly key: string;
  /**
   * Already in the record index, so resolving it costs nothing.
   *
   * These are skipped when fetching and kept when naming — the whole point of
   * the index is that a record fetched once names itself everywhere after.
   */
  readonly held?: true;
}

export interface LookupInput {
  readonly rows: readonly Row[];
  readonly columns: readonly ColumnMeta[];
  readonly connection: string;
  readonly params: ResolvedParams;
  readonly limit?: number;
  /**
   * Columns whose record is needed even though the row already names it.
   *
   * A reference that carries the far record's name is free to *draw* and
   * still has to be fetched when a column reads some other field off that
   * record — a vendor's phone is not on the task however well the task names
   * the vendor.
   */
  readonly alsoFetch?: ReadonlySet<string>;
  /**
   * Records already held, which therefore cost nothing and are not capped.
   *
   * The cap exists to bound **requests**, so a record something else already
   * fetched must not consume a slot — otherwise a board that had just drawn a
   * vendors table would still stop naming vendors after twenty-five of them.
   * Known records are always resolved; the limit applies to the rest.
   */
  readonly known?: (lookup: { readonly target: string; readonly id: string | number }) => boolean;
}

/**
 * The records this view needs fetched, deduplicated and capped.
 *
 * Rows are read in order, so what the reader sees first is what gets resolved
 * first — a cap that spent its budget on row ninety would be worse than no cap
 * at all.
 */
export const referenceLookups = (input: LookupInput): readonly ReferenceLookup[] => {
  const limit = input.limit ?? MAX_LOOKUPS;
  const wanted: ReferenceLookup[] = [];
  const seen = new Set<string>();
  /** How many of `wanted` would actually cost a request. */
  let spend = 0;

  const linked = input.columns.filter(
    (column): column is ColumnMeta & { reference: ColumnReference } =>
      column.reference !== undefined &&
      column.reference.lookup !== undefined &&
      // Already on the row, so nothing has to be asked for — unless something
      // reads a *different* field off the far record.
      (column.reference.embedded.length === 0 || (input.alsoFetch?.has(column.name) ?? false)),
  );
  if (linked.length === 0) return [];

  for (const row of input.rows) {
    for (const column of linked) {
      const reference = column.reference;
      const lookup = reference.lookup;
      if (!lookup) continue;
      // A row pointing at another kind of record would be fetched from the
      // wrong endpoint. Its cell falls back to the plain value.
      if (targetOfRow(row, reference) !== reference.target) continue;

      for (const id of referenceIds(row[column.name], reference.holds)) {
        const key = queryKey(input.connection, lookup.op, { [lookup.param]: id }, input.params);
        if (seen.has(key)) continue;
        seen.add(key);
        const free = input.known?.({ target: reference.target, id }) ?? false;
        /*
         * Counted against the budget only when it would cost a request. A
         * free one still has to be *returned* — it is how its name reaches
         * the cell — it just must not push a payable one off the list.
         */
        if (!free) {
          if (spend >= limit) continue;
          spend++;
        }
        wanted.push({
          connection: input.connection,
          op: lookup.op,
          param: lookup.param,
          id,
          target: reference.target,
          column: column.name,
          key,
          ...(free ? { held: true as const } : {}),
        });
      }
    }
  }
  return wanted;
};

/**
 * The status that ends a pass rather than being retried.
 *
 * Measured against a real account: a collection endpoint answered with 128
 * rows and a by-id call seconds later came back 429. Per-id lookups are
 * exactly the traffic that trips a limit, so they are the traffic that has to
 * back off first.
 */
export const REFUSAL_STATUS = 429;

export interface SerialFetch {
  readonly lookups: readonly ReferenceLookup[];
  /** Run one lookup through the cache. Resolves whether or not it worked. */
  fetch(lookup: ReferenceLookup): Promise<void>;
  /** The HTTP status that lookup ended with, where it failed with one. */
  statusOf(lookup: ReferenceLookup): number | undefined;
  /** True once the view that asked for these has gone away. */
  stopped?(): boolean;
}

export interface SerialResult {
  readonly fetched: number;
  /** Set when the API refused and the pass gave up rather than pressing on. */
  readonly refusedWith?: number;
}

/**
 * Fetch the records a view needs, one at a time, stopping at a refusal.
 *
 * Serial rather than parallel because these are embellishments — names for ids
 * that would otherwise read as bare numbers — so they are the last traffic
 * that should cost somebody their rate limit. A burst of twenty-five parallel
 * by-id calls is the shape most likely to trip one.
 *
 * A refusal ends the pass instead of being retried per id: the next call would
 * be refused too, and every unresolved cell falls back to naming the kind of
 * record, which is what that fallback is for. An *ordinary* failure does not
 * stop anything — a 404 on one id says nothing about the next.
 */
export const fetchLookupsInOrder = async (input: SerialFetch): Promise<SerialResult> => {
  let fetched = 0;
  for (const lookup of input.lookups) {
    if (input.stopped?.()) return { fetched };
    await input.fetch(lookup);
    fetched += 1;
    if (input.statusOf(lookup) === REFUSAL_STATUS) {
      return { fetched, refusedWith: REFUSAL_STATUS };
    }
  }
  return { fetched };
};

/**
 * A record's name, read off whatever came back.
 *
 * The far row is a detail response in the API's own shape, so the title fields
 * are dotted paths rather than this widget's column names — and a response may
 * arrive flattened or not, so both spellings are tried. Returns null rather
 * than an empty string, so a caller can tell "no name" from "a record whose
 * name happens to be blank".
 */
/**
 * One value off a fetched record, by the path the API spells for it.
 *
 * A detail response arrives in the API's own shape, so the path is dotted
 * rather than a column name — and a response may arrive flattened or not, so
 * both spellings are tried. The one reader for this, shared by the name a
 * reference cell shows and the columns read through one, because two would
 * drift on the nested case that is hardest to get right.
 */
export const valueAtPath = (record: unknown, path: string): unknown => {
  if (!record || typeof record !== "object") return undefined;
  const row = (Array.isArray(record) ? record[0] : record) as Record<string, unknown> | undefined;
  if (!row || typeof row !== "object") return undefined;

  const direct = row[path] ?? row[path.replace(/\./g, "_")];
  if (direct !== undefined) return direct;
  let current: unknown = row;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

export const nameOfRecord = (
  record: unknown,
  title: readonly string[],
  mode: "join" | "first" = "join",
): string | null => {
  if (!record || typeof record !== "object") return null;
  const row = (Array.isArray(record) ? record[0] : record) as Record<string, unknown> | undefined;
  if (!row || typeof row !== "object") return null;

  const parts = title
    .map((path) => valueAtPath(row, path))
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value));
  if (parts.length === 0) return null;
  /*
   * Alternatives, not parts: a supplier carries a company name *or* a
   * person's, and joining them produces a name nobody has.
   */
  return mode === "first" ? parts[0]! : parts.join(" ");
};

/** A column read through a reference, as a widget declares it. */
export interface LinkedField {
  readonly through: string;
  readonly field: string;
  readonly as: string;
  readonly label?: string | undefined;
}

/**
 * The rows, with their linked columns filled in.
 *
 * A task's vendor's phone is on the vendor, so no pipeline over tasks could
 * produce it. The pipeline made the column empty; this puts the value in once
 * the record it belongs to has landed — from the *same* fetch the reference
 * cell uses for its name, so following a link and reading a field through it
 * cost one request between them rather than two.
 *
 * A row whose record has not arrived is returned untouched, so the column
 * reads blank rather than wrong.
 */
export const withLinkedValues = (input: {
  readonly rows: readonly Row[];
  readonly linked: readonly LinkedField[];
  readonly lookups: readonly ReferenceLookup[];
  readonly recordOf: (lookup: ReferenceLookup) => unknown;
}): readonly Row[] => {
  if (input.linked.length === 0 || input.rows.length === 0) return input.rows;

  // Null-separated, because a column name and an id are both arbitrary text
  // and a plain join could collide between two different pairs.
  const keyed = new Map(
    input.lookups.map(
      (lookup) => [`${lookup.column} ${String(lookup.id)}`, lookup] as const,
    ),
  );

  return input.rows.map((row) => {
    const extra: Record<string, unknown> = {};
    for (const one of input.linked) {
      const id = row[one.through];
      if (id === null || id === undefined || id === "") continue;
      const lookup = keyed.get(`${one.through} ${String(id)}`);
      if (lookup === undefined) continue;
      const value = valueAtPath(input.recordOf(lookup), one.field);
      if (value !== undefined) extra[one.as] = value;
    }
    return Object.keys(extra).length > 0 ? { ...row, ...extra } : row;
  });
};

/** column → id → the name that resolved for it. */
export type ReferenceNames = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * The names this view managed to resolve, as a plain table.
 *
 * A lookup table rather than a callback, so a component stays dumb and the
 * whole thing is checkable without rendering anything: the hook resolves, the
 * cell reads.
 */
export const referenceNames = (
  lookups: readonly ReferenceLookup[],
  /**
   * The record behind one lookup, from wherever the caller has it.
   *
   * Takes the lookup rather than its cache key, because a record may be held
   * under a record-type index that knows nothing about request keys — which is
   * the whole point of that index.
   */
  recordOf: (lookup: ReferenceLookup) => unknown,
  columns: readonly ColumnMeta[],
): ReferenceNames => {
  const byColumn: Record<string, Record<string, string>> = {};
  const titleOf = new Map(
    columns.flatMap((column) =>
      column.reference
        ? [
            [
              column.name,
              {
                fields: column.reference.targetTitle,
                mode: column.reference.targetTitleMode ?? ("join" as const),
              },
            ] as const,
          ]
        : [],
    ),
  );

  for (const lookup of lookups) {
    const title = titleOf.get(lookup.column);
    const name = nameOfRecord(recordOf(lookup), title?.fields ?? [], title?.mode ?? "join");
    if (name === null) continue;
    const held = byColumn[lookup.column] ?? {};
    held[String(lookup.id)] = name;
    byColumn[lookup.column] = held;
  }
  return byColumn;
};
