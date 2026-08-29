import { z } from "zod";
import type { AuthContext, DbAdapter } from "@freebirdai/core";
import { requireScratch } from "@freebirdai/core";

/**
 * What the conversation is currently about.
 *
 * People ask follow-ups. "Is 123 Main St active?" is followed by "has anyone
 * applied?", and the second question is about the same record as the first —
 * but nothing in the wording says so, and searching again from scratch is both
 * slower and liable to land on a different record entirely.
 *
 * So when a search finds the records a question was about, those records are
 * kept. Not the search: the **records**, whole. Two reasons, and the second is
 * the one that pays off repeatedly:
 *
 *   1. A follow-up usually needs a *different field* of the same record. The
 *      row was narrowed to fit a prompt; the copy kept here is not, so the
 *      description, the dates and everything else are already in hand and the
 *      answer costs nothing.
 *   2. A follow-up often needs something *related* to the record, and the
 *      identifier is the only way to ask for it. Holding the record means
 *      holding its id, which is what turns "has anyone applied?" into a lookup
 *      rather than a second search.
 *
 * As many records as the question matched. "Any dishwasher or washing machine
 * tasks?" is a question about two records and the follow-up may be about
 * either.
 *
 * Nothing here knows what a task or a property is. A focus is a source id, an
 * identifier field name and some rows — all of which come from the API map and
 * the relation graph, so this works the same on an API nobody has seen.
 */

export const focusRecordSchema = z.record(z.string(), z.unknown());

export const focusSchema = z.object({
  /** The question these records were found for, in the user's own words. */
  question: z.string().max(500),
  /** Workspace handle of the widget, or the op id when read directly. */
  source: z.string().min(1),
  /** Human name for the source, for saying where something came from. */
  sourceTitle: z.string().max(200).default(""),
  connection: z.string().min(1),
  /** The endpoint the records came from, so related lookups can be derived. */
  op: z.string().min(1),
  /**
   * The field carrying each record's identity, when one is known.
   *
   * Worked out by the relation graph rather than assumed — an API that calls
   * it `Id`, `uuid` or `ticket_number` all work, and one where no identity can
   * be established simply cannot do related lookups, which is reported rather
   * than guessed around.
   */
  idField: z.string().nullable().default(null),
  records: z.array(focusRecordSchema).max(50),
  savedAt: z.string(),
});

export type Focus = z.infer<typeof focusSchema>;

/**
 * Fold newly opened records into the ones already held.
 *
 * A record opened in full supersedes the summary it was read from — same
 * record, more fields — but the records beside it are still what the
 * conversation is about. "Any dishwasher or washing machine tasks?" followed
 * by "notes on the dishwasher one?" must not lose the washing machine,
 * because "and the other one?" is the next thing anybody asks.
 *
 * Without an identifier there is nothing to match on, so the opened records
 * simply lead and the rest follow. That is worse than merging and better than
 * pretending two records are the same because they arrived together.
 */
export const mergeRecords = (
  held: readonly Record<string, unknown>[],
  opened: readonly Record<string, unknown>[],
  idField: string | null,
): Record<string, unknown>[] => {
  if (!idField) return [...opened, ...held];
  const replaced = new Set(
    opened.map((record) => String(record[idField] ?? "")).filter((id) => id !== ""),
  );
  return [
    ...opened,
    ...held.filter((record) => !replaced.has(String(record[idField] ?? ""))),
  ];
};

/** How long a focus survives without being used. */
export const FOCUS_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * A focus is per **conversation**, not per board.
 *
 * The concierge's draft is scoped to a dashboard because a half-built widget
 * belongs to the board it is being built on. What a conversation is about
 * belongs to the conversation: two sessions looking at the same board are
 * asking about different things, and one must not answer from the other's
 * records.
 */
export interface FocusStore {
  get(sessionId: string): Promise<Focus | null>;
  put(sessionId: string, focus: Focus): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

const MAX_SESSIONS = 200;

export class MemoryFocusStore implements FocusStore {
  readonly #held = new Map<string, { focus: Focus; touched: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async get(sessionId: string): Promise<Focus | null> {
    const entry = this.#held.get(sessionId);
    if (!entry) return null;
    if (this.#now() - entry.touched > FOCUS_TTL_MS) {
      this.#held.delete(sessionId);
      return null;
    }
    return entry.focus;
  }

  async put(sessionId: string, focus: Focus): Promise<void> {
    // Re-inserted so insertion order is recency order, which is what makes the
    // eviction below evict the least recently used.
    this.#held.delete(sessionId);
    this.#held.set(sessionId, { focus, touched: this.#now() });
    while (this.#held.size > MAX_SESSIONS) {
      const oldest = this.#held.keys().next();
      if (oldest.done) break;
      this.#held.delete(oldest.value);
    }
  }

  async clear(sessionId: string): Promise<void> {
    this.#held.delete(sessionId);
  }
}

export const FOCUS_NAMESPACE = "dash.focus";

/**
 * A focus in the chat database, so a follow-up survives a restart.
 *
 * Records read off somebody's API are held here, which is why the identity is
 * explicit rather than defaulted: `freebird_scratch` folds tenant and user into
 * its primary key precisely so a blank identity cannot read another's rows.
 */
export class ScratchFocusStore implements FocusStore {
  readonly #scratch: ReturnType<typeof requireScratch>;
  readonly #auth: AuthContext;
  readonly #now: () => number;

  constructor(db: DbAdapter, auth: AuthContext, now: () => number = Date.now) {
    this.#scratch = requireScratch(db);
    this.#auth = auth;
    this.#now = now;
  }

  async get(sessionId: string): Promise<Focus | null> {
    const record = await this.#scratch.get(sessionId, FOCUS_NAMESPACE, this.#auth);
    return record ? parseFocus(record.data) : null;
  }

  async put(sessionId: string, focus: Focus): Promise<void> {
    await this.#scratch.put(
      {
        scope: sessionId,
        namespace: FOCUS_NAMESPACE,
        data: focus,
        expiresAt: new Date(this.#now() + FOCUS_TTL_MS),
      },
      this.#auth,
    );
  }

  async clear(sessionId: string): Promise<void> {
    await this.#scratch.delete(sessionId, FOCUS_NAMESPACE, this.#auth);
  }
}

/**
 * A focus read back from storage.
 *
 * Parsed, never cast — the same posture the draft store takes, and for the
 * same reason: once it is not this process's own memory it is untrusted input.
 * An unparseable one reads as "nothing in focus", which costs a search and is
 * always recoverable.
 */
export const parseFocus = (value: unknown): Focus | null => {
  const parsed = focusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The identifiers of the focused records, for a related lookup. */
export const focusIds = (focus: Focus): string[] => {
  if (!focus.idField) return [];
  const seen = new Set<string>();
  for (const record of focus.records) {
    const value = record[focus.idField];
    if (value === null || value === undefined || value === "") continue;
    seen.add(String(value));
  }
  return [...seen];
};
