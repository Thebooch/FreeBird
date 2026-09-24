import type { EntityLinkView } from "@freebirdai/dash-spec";
import { readField } from "@freebirdai/dash-spec";
import type { Row } from "@freebirdai/dash-runtime";

/**
 * Every record this session has seen, by what it is rather than how it arrived.
 *
 * The query cache is keyed on the *request* — connection, op, params — which
 * is right for deciding whether to repeat a call and useless for answering
 * "do we already know vendor 4711?". So a board that had just drawn a vendors
 * table went on spending one request per vendor to put names on the tasks
 * table beside it, and a record page opened from a row that was already on
 * screen fetched that row again from scratch. `recordIndex.ts` names this gap
 * in its own docblock and defers it; this is that index.
 *
 * Measured on the real Buildium map before building it: 80 of 121 reference
 * links cost a request each, and they point at only 24 distinct record types.
 * Most of those requests are for records something else already fetched.
 *
 * **In memory only, and deliberately.** It holds a customer's own records, so
 * it lives and dies with the tab for exactly the reason the server's response
 * cache lives and dies with the process. A shared store belongs in a database
 * behind the server, never in the browser's local storage.
 */

/** What a fetched response can tell us about one record type. */
export interface IndexedEntity {
  readonly entity: string;
  /** The field holding a record's own id, e.g. `Id`. */
  readonly identity: string;
}

/**
 * Which record type an endpoint's rows are, and how to identify one.
 *
 * Built from `entityLinks`, which already carries `ops` — "the endpoints whose
 * rows *are* these records" — precisely so a browser never has to reason about
 * resources to answer this. Nothing new is fetched to build it.
 */
export const indexPlan = (
  links: Readonly<Record<string, readonly EntityLinkView[]>> | undefined,
): Map<string, IndexedEntity> => {
  const plan = new Map<string, IndexedEntity>();
  for (const [connection, views] of Object.entries(links ?? {})) {
    for (const view of views) {
      if (!view.identity) continue;
      for (const op of view.ops) {
        // First writer wins: an op listed under two record types is ambiguous,
        // and indexing its rows as the wrong type would put one record's name
        // on another. Skipping the second is the safe half of that choice.
        const key = `${connection}.${op}`;
        if (!plan.has(key)) plan.set(key, { entity: view.entity, identity: view.identity });
      }
    }
  }
  return plan;
};

/**
 * The records inside a response, whatever shape it arrived in.
 *
 * Deliberately conservative: only objects that actually carry the identity
 * field are indexed, so a malformed guess about where the rows live cannot
 * put junk in the index. Handles a bare array, a single detail object, and the
 * one-level envelope every paginated API uses (`{ Data: [...] }`).
 */
export const collectRecords = (
  body: unknown,
  identity: string,
): readonly { id: string; row: Row }[] => {
  const found: { id: string; row: Row }[] = [];

  const take = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Row;
    /* An identity may nest — `property.propertyID` — and is read where it is. */
    const id = readField(row, identity);
    if (id === null || id === undefined || id === "") return;
    found.push({ id: String(id), row });
  };

  if (Array.isArray(body)) {
    for (const item of body) take(item);
    return found;
  }
  if (!body || typeof body !== "object") return found;

  take(body);
  if (found.length > 0) return found;

  for (const value of Object.values(body as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) take(item);
    if (found.length > 0) return found;
  }
  return found;
};

/**
 * How many records one connection may hold.
 *
 * A bound rather than a policy: the index exists to save requests, and an
 * unbounded one on a board reading 500-row pages would hold a customer's whole
 * account in a tab. Oldest-first eviction, because the rows a reader is looking
 * at now are the ones whose names are wanted now.
 */
const MAX_RECORDS_PER_CONNECTION = 5_000;

export class RecordIndex {
  /** connection → entity → id → row. */
  private readonly held = new Map<string, Map<string, Map<string, Row>>>();
  private readonly listeners = new Set<() => void>();
  /**
   * Bumped whenever a record is added.
   *
   * A counter rather than a size, so a subscriber can compare snapshots by
   * identity without walking the index on every render — which a board of a
   * dozen widgets would do a dozen times a frame.
   */
  version = 0;

  constructor(private readonly maxPerConnection = MAX_RECORDS_PER_CONNECTION) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(connection: string, entity: string, id: string | number): Row | undefined {
    return this.held.get(connection)?.get(entity)?.get(String(id));
  }

  has(connection: string, entity: string, id: string | number): boolean {
    return this.get(connection, entity, id) !== undefined;
  }

  /**
   * Take whatever records a response holds.
   *
   * Returns how many were added, so a caller can avoid telling subscribers
   * that nothing changed — this runs on every fetch, and a board of a dozen
   * widgets re-rendering for a response with no indexable rows would cost more
   * than the index saves.
   */
  ingest(input: {
    readonly connection: string;
    readonly op: string;
    readonly body: unknown;
    readonly plan: Map<string, IndexedEntity>;
  }): number {
    const known = input.plan.get(`${input.connection}.${input.op}`);
    if (!known) return 0;

    const records = collectRecords(input.body, known.identity);
    if (records.length === 0) return 0;

    const byEntity = this.held.get(input.connection) ?? new Map<string, Map<string, Row>>();
    this.held.set(input.connection, byEntity);
    const rows = byEntity.get(known.entity) ?? new Map<string, Row>();
    byEntity.set(known.entity, rows);

    let added = 0;
    for (const record of records) {
      if (!rows.has(record.id)) added++;
      // Re-inserted even when present, so a detail response — which carries
      // more fields than a list row — replaces the thinner copy rather than
      // being discarded by it.
      rows.delete(record.id);
      rows.set(record.id, record.row);
    }

    this.evict(input.connection);
    if (added > 0) {
      this.version++;
      for (const listener of this.listeners) listener();
    }
    return added;
  }

  /**
   * Forget one connection's records.
   *
   * Paired with the query cache's own scoped invalidation: when credentials
   * change, rows belonging to the old account must not go on naming things.
   */
  forget(connection: string): void {
    if (!this.held.delete(connection)) return;
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** For the inspector and for tests. */
  size(connection: string): number {
    let total = 0;
    for (const rows of this.held.get(connection)?.values() ?? []) total += rows.size;
    return total;
  }

  private evict(connection: string): void {
    const byEntity = this.held.get(connection);
    if (!byEntity) return;
    let total = 0;
    for (const rows of byEntity.values()) total += rows.size;

    // Evict from the largest record type first, so one huge collection cannot
    // push every other type's records out and undo the saving everywhere else.
    while (total > this.maxPerConnection) {
      let largest: Map<string, Row> | undefined;
      for (const rows of byEntity.values()) {
        if (!largest || rows.size > largest.size) largest = rows;
      }
      const oldest = largest?.keys().next();
      if (!largest || !oldest || oldest.done) break;
      largest.delete(oldest.value);
      total--;
    }
  }
}
