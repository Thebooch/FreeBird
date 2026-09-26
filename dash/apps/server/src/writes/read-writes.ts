import { WRITES_VERSION, type CatalogEntry } from "@freebirdai/dash-spec";
import type { CatalogStore } from "../catalog.js";
import { rereadSpec } from "../discovery/connect-details.js";
import { mergeRefreshedWrites, writesRereadable } from "./catalog-writes.js";

/**
 * Reading an API's write endpoints from its specification.
 *
 * Changing records is part of every connection, not something to switch on,
 * so a connection whose entry has never had its writes read gets them read
 * for it: when it is added, and once at startup for any added before writes
 * existed. What is fetched is the API's published specification — a
 * documentation read. The connected account itself is never touched.
 */

export type FetchDocument = (url: string) => Promise<{ status: number; text: string; url: string }>;

export interface WritesRead {
  readonly writes: number;
  readonly added: number;
  readonly removed: number;
}

/** Never read, and readable: the entry came from a specification it can be read from again. */
export const writesUnread = (entry: CatalogEntry): boolean =>
  entry.writesVersion === undefined && writesRereadable(entry);

/**
 * Read an entry's write endpoints again and keep them — only them. Reads,
 * record types, categories and the cache are left exactly as they were, and
 * what people and the model decided about the old endpoints is kept.
 *
 * Throws with a sentence worth showing when the specification cannot be read.
 */
export const readWriteEndpoints = async (
  catalog: CatalogStore,
  entry: CatalogEntry,
  fetchDocument: FetchDocument,
): Promise<WritesRead> => {
  if (!writesRereadable(entry) || !entry.specUrl) {
    throw new Error("This API was not read from a specification, so there is nothing to read its write endpoints from again.");
  }
  const parsed = await rereadSpec(entry.specUrl, fetchDocument);
  // The entry as it is now: somebody may have changed it while the document downloaded.
  const current = catalog.get(entry.id) ?? entry;
  const writes = mergeRefreshedWrites(current.writes, parsed.entry.writes);
  catalog.put({ ...current, writes, writesVersion: WRITES_VERSION });
  return {
    writes: writes.length,
    added: writes.filter((op) => !current.writes.some((old) => old.id === op.id)).length,
    removed: current.writes.filter((op) => !writes.some((now) => now.id === op.id)).length,
  };
};

/**
 * Reads each entry's write endpoints once, in the background, one at a time.
 *
 * One at a time because each is a whole specification — Buildium's is
 * several megabytes — and nobody is waiting on it. Once per entry per run:
 * a specification that could not be read is not asked for again until the
 * server restarts or somebody asks under Connections → Changes.
 */
export class WriteEndpointReader {
  private readonly tried = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly deps: {
      readonly catalog: CatalogStore;
      readonly fetchDocument: FetchDocument;
      /** Told after every read that changed what can be written. */
      readonly onRead: (entryId: string, result: WritesRead) => void;
      readonly onFailed: (entryId: string, error: unknown) => void;
    },
  ) {}

  /** Read this entry's writes if they never have been. Resolves when every read queued so far is done. */
  ensure(entryId: string): Promise<void> {
    if (this.closed || this.tried.has(entryId)) return this.queue;
    const entry = this.deps.catalog.get(entryId);
    if (!entry || !writesUnread(entry)) return this.queue;
    this.tried.add(entryId);
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      const now = this.deps.catalog.get(entryId);
      if (!now || !writesUnread(now)) return;
      try {
        this.deps.onRead(entryId, await readWriteEndpoints(this.deps.catalog, now, this.deps.fetchDocument));
      } catch (error) {
        this.deps.onFailed(entryId, error);
      }
    });
    return this.queue;
  }

  close(): void {
    this.closed = true;
  }
}
