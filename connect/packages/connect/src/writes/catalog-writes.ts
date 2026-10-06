import type { CatalogEntry, WriteOpDef } from "@freebirdai/connect-spec";

/**
 * Keeping a catalog entry's write endpoints where they belong: on the server.
 *
 * An API's writes are its largest part — one real API's two hundred carry
 * request bodies that together outweigh everything else in the entry — and
 * the browser needs none of it to draw a page; it asks the server what a
 * record type can do. So entries leave for the browser with their writes
 * counted rather than carried, and an entry saved back from the browser
 * keeps the writes the server already holds. Otherwise a round trip through
 * a form would erase them, and a large enough one would not fit a request at
 * all.
 *
 * An entry that has only just been discovered has nowhere to keep its writes
 * yet, so discovery holds them here until somebody adopts it (`Discovered`).
 */

/** Whether this entry's writes can be read again from its specification. */
export const writesRereadable = (entry: CatalogEntry): boolean =>
  entry.origin === "openapi" && Boolean(entry.specUrl);

export type BrowserCatalogEntry = CatalogEntry & { readonly writeOpCount: number };

/** An entry as the browser receives it: writes counted, never carried. */
export const catalogForBrowser = (entry: CatalogEntry): BrowserCatalogEntry => ({
  ...entry,
  writes: [],
  writeOpCount: entry.writes.length,
});

/**
 * Writes read by discovery, held until the entry they belong to is adopted.
 *
 * Discovery hands the browser an entry, and the browser saves it back to
 * adopt it; the writes are the one part that does not make the trip. An hour
 * is longer than any wizard, and a restart costs only a second discovery.
 */
export class Discovered {
  private readonly held = new Map<string, { writes: WriteOpDef[]; writesVersion?: number; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60 * 60 * 1000,
  ) {}

  hold(entry: CatalogEntry): void {
    if (entry.writes.length === 0) return;
    for (const [id, value] of this.held) if (this.now() - value.at > this.ttlMs) this.held.delete(id);
    this.held.set(entry.id, {
      writes: entry.writes,
      ...(entry.writesVersion !== undefined ? { writesVersion: entry.writesVersion } : {}),
      at: this.now(),
    });
  }

  /** The writes discovery read for this entry, once. */
  take(id: string): { writes: WriteOpDef[]; writesVersion?: number } | undefined {
    const value = this.held.get(id);
    this.held.delete(id);
    if (!value || this.now() - value.at > this.ttlMs) return undefined;
    return {
      writes: value.writes,
      ...(value.writesVersion !== undefined ? { writesVersion: value.writesVersion } : {}),
    };
  }
}

/**
 * The writes an entry saved from the browser should keep: the ones already
 * held, when there are any, whatever the body said.
 */
export const preservedWrites = (
  existing: CatalogEntry | null | undefined,
  discovered: { writes: WriteOpDef[]; writesVersion?: number } | undefined,
): { writes: WriteOpDef[]; writesVersion?: number } => {
  if (existing && existing.writes.length > 0) {
    return {
      writes: existing.writes,
      ...(existing.writesVersion !== undefined ? { writesVersion: existing.writesVersion } : {}),
    };
  }
  return discovered ?? { writes: [] };
};

/**
 * Fresh writes, keeping what people and the model decided about the old ones.
 *
 * A refresh re-reads what the specification says; it must not undo what
 * somebody confirmed, mapped or learned by sending one. Matched by op id,
 * and within an op by field path.
 */
export const mergeRefreshedWrites = (
  held: readonly WriteOpDef[],
  fresh: readonly WriteOpDef[],
): WriteOpDef[] => {
  const byId = new Map(held.map((op) => [op.id, op]));
  return fresh.map((op) => {
    const old = byId.get(op.id);
    if (!old) return op;
    const oldFields = new Map((old.body?.fields ?? []).map((field) => [field.path, field]));
    return {
      ...op,
      verified: op.verified || old.verified,
      ...(old.confirmed !== undefined ? { confirmed: old.confirmed } : {}),
      ...(op.body
        ? {
            body: {
              ...op.body,
              fields: op.body.fields.map((field) => {
                const was = oldFields.get(field.path);
                if (!was || (was.mappedBy !== "person" && was.mappedBy !== "model" && !was.label && !was.hidden)) {
                  return field;
                }
                return {
                  ...field,
                  ...(was.mappedBy === "person" || was.mappedBy === "model"
                    ? { readFrom: was.readFrom ?? null, mappedBy: was.mappedBy }
                    : {}),
                  ...(was.label !== undefined ? { label: was.label } : {}),
                  ...(was.hidden !== undefined ? { hidden: was.hidden } : {}),
                };
              }),
            },
          }
        : {}),
    };
  });
};
