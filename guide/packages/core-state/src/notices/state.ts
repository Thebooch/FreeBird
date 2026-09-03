import type { StateNotice } from "@freebirdai/core";

/**
 * The tier-1 buffer: what happened, waiting for a turn to ride along with.
 *
 * Pure and separate from the store so the interesting parts — coalescing and
 * the caps — can be tested without a transport, a clock, or a session.
 *
 * Every limit here exists because this buffer is fed by UI events, and UI
 * events arrive in floods. A slider emits on every pixel; a filter emits twice
 * because two components both noticed. Left alone, one drag would put four
 * hundred lines into somebody's prompt.
 */

/** Identical emissions closer together than this collapse into one. */
export const COALESCE_WINDOW_MS = 5_000;

/** Hard ceiling on buffered notices, whatever their size. */
export const MAX_NOTICES = 50;

/** Total budget across all buffered summaries. */
export const MAX_TOTAL_CHARS = 8 * 1024;

/** Longest a single summary may be before it is cut. */
export const MAX_SUMMARY_CHARS = 500;

export interface NoticeBuffer {
  readonly notices: readonly StateNotice[];
  /** True once something was dropped or trimmed, so the block can say so. */
  readonly overflowed: boolean;
}

export const emptyNoticeBuffer = (): NoticeBuffer => ({ notices: [], overflowed: false });

/** Same event, said the same way — the coalescing key. */
const sameEvent = (a: StateNotice, b: StateNotice): boolean =>
  a.kind === b.kind &&
  a.summary === b.summary &&
  JSON.stringify(a.detail ?? null) === JSON.stringify(b.detail ?? null);

const totalChars = (notices: readonly StateNotice[]): number =>
  notices.reduce((sum, notice) => sum + notice.summary.length, 0);

/**
 * Add one notice, applying every cap.
 *
 * Returns a new buffer; the caller replaces its state with it. Never throws —
 * a host emitting something oversized has made a judgement call about its own
 * UI, not an error, and losing the turn over it would be absurd.
 */
export const appendNotice = (
  buffer: NoticeBuffer,
  notice: StateNotice,
): NoticeBuffer => {
  const trimmedSummary =
    notice.summary.length > MAX_SUMMARY_CHARS
      ? `${notice.summary.slice(0, MAX_SUMMARY_CHARS - 3)}...`
      : notice.summary;
  const incoming: StateNotice = { ...notice, summary: trimmedSummary };
  let overflowed = buffer.overflowed || trimmedSummary !== notice.summary;

  /*
   * Coalescing looks only at the most recent notice, not the whole buffer.
   *
   * The flood this defends against is repetition *in a row* — a slider, a
   * double-fired handler. Two identical events separated by other activity
   * are two real events, and collapsing those would lie about the order
   * things happened in.
   */
  const last = buffer.notices[buffer.notices.length - 1];
  if (last && sameEvent(last, incoming) && incoming.at - last.at < COALESCE_WINDOW_MS) {
    // Keep the newest timestamp: what matters is when it last happened.
    const notices = [...buffer.notices.slice(0, -1), incoming];
    return { notices, overflowed };
  }

  let notices = [...buffer.notices, incoming];

  // Oldest go first under both caps: the most recent state is the one the
  // model needs to answer the message arriving with it.
  while (notices.length > MAX_NOTICES) {
    notices = notices.slice(1);
    overflowed = true;
  }
  while (notices.length > 1 && totalChars(notices) > MAX_TOTAL_CHARS) {
    notices = notices.slice(1);
    overflowed = true;
  }

  return { notices, overflowed };
};

/** What to send this turn, with an explicit marker when anything was lost. */
export const flushNotices = (buffer: NoticeBuffer): StateNotice[] => {
  if (buffer.notices.length === 0) return [];
  if (!buffer.overflowed) return [...buffer.notices];
  return [
    {
      kind: "notices_truncated",
      summary: "(some earlier changes were dropped — this list is incomplete)",
      at: buffer.notices[0]!.at,
    },
    ...buffer.notices,
  ];
};
