import type { ActionRecord, ActionRecordStatus } from "@freebirdai/core";
import { useFreeBird } from "../provider.js";

export interface UseActionJournalOptions {
  /** Restrict to a subset of statuses. */
  status?: ActionRecordStatus | ActionRecordStatus[];
  /** Hard cap on returned records (most-recent first). */
  limit?: number;
}

export interface UseActionJournalReturn {
  /** Filtered journal entries (most-recent first). */
  records: ActionRecord[];
  /** Convenience selector for resumable records. */
  paused: ActionRecord[];
  /** Pick up a previously paused record. */
  resume: (recordId: string) => void;
  /** Drop a record from the in-memory journal. */
  discard: (recordId: string) => void;
}

/**
 * Reactive view of the action journal.
 *
 * The journal is in-memory and scoped to the FreeBirdStore instance; it
 * is *not* persisted across reloads. Hosts that want cross-session
 * resume should subscribe to {@link useActionEvents} and store records
 * themselves, then `store.hydrateJournal()` on boot.
 */
export const useActionJournal = (
  opts: UseActionJournalOptions = {},
): UseActionJournalReturn => {
  const fb = useFreeBird();
  const allow = opts.status
    ? new Set(Array.isArray(opts.status) ? opts.status : [opts.status])
    : null;
  let records = fb.actionState.journal;
  if (allow) records = records.filter((r) => allow.has(r.status));
  if (opts.limit !== undefined) records = records.slice(0, opts.limit);
  return {
    records,
    paused: fb.pausedRecords,
    resume: fb.resumeAction,
    discard: fb.discardActionRecord,
  };
};
