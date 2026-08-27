import { computed, type ComputedRef } from "vue";
import type { ActionRecord, ActionRecordStatus } from "@freebirdai/core";
import { useFreeBird } from "./useFreeBird.js";

export interface UseActionJournalOptions {
  status?: ActionRecordStatus | ActionRecordStatus[];
  limit?: number;
}

export interface UseActionJournalReturn {
  records: ComputedRef<ActionRecord[]>;
  paused: ComputedRef<ActionRecord[]>;
  resume: (recordId: string) => void;
  discard: (recordId: string) => void;
}

export const useActionJournal = (
  opts: UseActionJournalOptions = {},
): UseActionJournalReturn => {
  const fb = useFreeBird();
  const records = computed(() => {
    const allow = opts.status
      ? new Set(Array.isArray(opts.status) ? opts.status : [opts.status])
      : null;
    let out = fb.actionState.value.journal;
    if (allow) out = out.filter((r) => allow.has(r.status));
    if (opts.limit !== undefined) out = out.slice(0, opts.limit);
    return out;
  });
  return {
    records,
    paused: fb.pausedRecords,
    resume: fb.resumeAction,
    discard: fb.discardActionRecord,
  };
};
