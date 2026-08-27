import type { ConciergeDraft } from "@freebirdai/dash-agent";
import { conciergeDraftSchema } from "@freebirdai/dash-agent";
import type { AuthContext, DbAdapter } from "@freebirdai/core";
import { requireScratch } from "@freebirdai/core";

/**
 * Where a half-finished widget lives between turns.
 *
 * A boundary rather than a table, for the same reason the response cache has
 * one: memory is right for a single-process self-hosted install, and a real
 * database is right for the hosted service. Neither should be the thing the
 * actions and routes are written against.
 *
 * Asynchronous throughout, even though the memory implementation answers
 * instantly — a store that is synchronous by signature cannot later be backed
 * by anything that isn't, and finding that out at the point of switching means
 * rewriting every caller.
 *
 * One draft per scope. A conversation builds one widget at a time; a second
 * concurrent draft would need the user to say which one an answer was for, and
 * nothing about the chat surface makes that askable.
 */
export interface DraftStore {
  get(scope: string): Promise<ConciergeDraft | null>;
  put(scope: string, draft: ConciergeDraft): Promise<void>;
  clear(scope: string): Promise<void>;
}

/** How long an untouched draft survives. */
export const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;

/** How many scopes the memory store holds at once, so it cannot grow forever. */
const MAX_SCOPES = 200;

export class MemoryDraftStore implements DraftStore {
  readonly #drafts = new Map<string, { draft: ConciergeDraft; touched: number }>();
  readonly #now: () => number;

  /** Injected so the expiry is testable without waiting six hours. */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async get(scope: string): Promise<ConciergeDraft | null> {
    const entry = this.#drafts.get(scope);
    if (!entry) return null;
    if (this.#now() - entry.touched > DRAFT_TTL_MS) {
      this.#drafts.delete(scope);
      return null;
    }
    return entry.draft;
  }

  async put(scope: string, draft: ConciergeDraft): Promise<void> {
    // Re-insert so the map's own insertion order is a recency order, which is
    // what makes the eviction below evict the right one.
    this.#drafts.delete(scope);
    this.#drafts.set(scope, { draft, touched: this.#now() });

    while (this.#drafts.size > MAX_SCOPES) {
      const oldest = this.#drafts.keys().next();
      if (oldest.done) break;
      this.#drafts.delete(oldest.value);
    }
  }

  async clear(scope: string): Promise<void> {
    this.#drafts.delete(scope);
  }
}

/** The namespace this product's drafts live under in the shared scratch table. */
export const DRAFT_NAMESPACE = "dash.concierge";

/**
 * Drafts in the chat database, so one survives a restart.
 *
 * The upstream primitive is a namespaced blob keyed by an opaque scope, which
 * is why the scope here is a **dashboard id** rather than a chat session id: a
 * setup belongs to the board it is building on, and it has to work when the
 * chat column has never been opened and no session exists at all.
 *
 * Identity is not optional. `freebird_scratch` folds tenant and user into its
 * primary key precisely so a blank one cannot read another's rows — but a
 * caller that passes no identity would still share one partition with every
 * other such caller, so this takes an explicit `auth` rather than defaulting.
 */
export class ScratchDraftStore implements DraftStore {
  readonly #scratch: ReturnType<typeof requireScratch>;
  readonly #auth: AuthContext;
  readonly #now: () => number;

  constructor(db: DbAdapter, auth: AuthContext, now: () => number = Date.now) {
    this.#scratch = requireScratch(db);
    this.#auth = auth;
    this.#now = now;
  }

  async get(scope: string): Promise<ConciergeDraft | null> {
    const record = await this.#scratch.get(scope, DRAFT_NAMESPACE, this.#auth);
    return record ? parseDraft(record.data) : null;
  }

  async put(scope: string, draft: ConciergeDraft): Promise<void> {
    await this.#scratch.put(
      {
        scope,
        namespace: DRAFT_NAMESPACE,
        data: draft,
        // A draft nobody came back to is litter, and the row is keyed by a
        // board id that may itself be gone — so it expires rather than
        // waiting for something to notice it.
        expiresAt: new Date(this.#now() + DRAFT_TTL_MS),
      },
      this.#auth,
    );
  }

  async clear(scope: string): Promise<void> {
    await this.#scratch.delete(scope, DRAFT_NAMESPACE, this.#auth);
  }
}

/**
 * A draft read back from storage.
 *
 * Parsed, never cast. The moment the store stops being this process's own
 * memory the JSON is untrusted input — an older schema, a hand-edited row, a
 * different version of the product — and the schema is the only thing that
 * decides what a draft may contain. An unparseable one reads as "no setup in
 * progress", which is recoverable; a half-valid one is not.
 */
export const parseDraft = (value: unknown): ConciergeDraft | null => {
  const parsed = conciergeDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
