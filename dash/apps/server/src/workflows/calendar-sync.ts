import { actionVariant, passes, stepRow, withDefaults, type CalendarEvent, type WorkflowSpec } from "@freebirdai/dash-spec";
import { renderSettings, toWhen } from "./actions.js";
import type { WorkflowEnv } from "./env.js";

/**
 * Keep a workflow's calendar entries in step with the records it reads.
 *
 * A workflow that matches each record once (`per-row`) does not open a second
 * case while the record still matches, so its calendar step never runs again
 * for it. This pass, on every run, does what that step would: for each record
 * the run reached that has an open entry from this workflow,
 *
 * - **still matching**: the entry's date, end and title are filled in again
 *   from the record, and the entry moves if they changed;
 * - **no longer matching**: it is marked done, or cancelled, or left, as the
 *   step's "When the record stops matching" says.
 *
 * Never a record the run did not reach (an incomplete read is not "gone"),
 * never an entry a person pinned, and never a value a step read from earlier
 * steps or case values: those cannot be filled in again without the case, so
 * such an entry only closes, it does not move.
 */

const CALENDAR = "create.calendar";

/** Whether a setting reads anything a record alone cannot supply. */
const needsCase = (value: unknown): boolean => typeof value === "string" && /\{\{[^}]*\b(steps|vars)\./.test(value);

export interface CalendarSyncResult {
  readonly moved: number;
  readonly closed: number;
}

export const syncCalendar = async (
  env: WorkflowEnv,
  workflow: WorkflowSpec,
  rows: ReadonlyArray<{ readonly key: string; readonly row: Record<string, unknown> }>,
  inputs: Readonly<Record<string, unknown>> = {},
): Promise<CalendarSyncResult> => {
  const steps = new Map(workflow.nodes.filter((one) => one.action === CALENDAR).map((one) => [one.id, one]));
  const variant = actionVariant(CALENDAR);
  if (steps.size === 0 || rows.length === 0 || !variant) return { moved: 0, closed: 0 };

  const open = await env.calendar.list({ workflow: workflow.id, statuses: ["open"], limit: 5000 });
  const byRow = new Map<string, CalendarEvent[]>();
  for (const entry of open) {
    if (!entry.rowKey || !entry.dedupeKey || entry.pinned) continue;
    byRow.set(entry.rowKey, [...(byRow.get(entry.rowKey) ?? []), entry]);
  }
  if (byRow.size === 0) return { moved: 0, closed: 0 };

  const now = env.now();
  const at = new Date(now).toISOString();
  let moved = 0;
  let closed = 0;
  for (const { key, row } of rows) {
    const entries = byRow.get(key);
    if (!entries) continue;
    const scope = stepRow(row, inputs);
    const matches = passes(workflow.criteria, scope, now);
    for (const entry of entries) {
      /* The step that made it: the last part of its key. */
      const step = steps.get(entry.dedupeKey!.slice(entry.dedupeKey!.lastIndexOf(":") + 1));
      if (!matches) {
        const how = step?.settings["onUnmatch"] ?? "done";
        if (how === "keep") continue;
        await env.calendar.put({ ...entry, status: how === "cancel" ? "cancelled" : "done", updatedAt: at });
        closed += 1;
        continue;
      }
      if (!step || ["title", "at", "end"].some((field) => needsCase(step.settings[field]))) continue;
      let settings: Record<string, unknown>;
      try {
        settings = renderSettings(variant, withDefaults(variant, step.settings), scope, now);
      } catch {
        continue;
      }
      const when = toWhen(settings["at"]);
      if (!when) continue;
      const end = toWhen(settings["end"]);
      const title = typeof settings["title"] === "string" && settings["title"].trim() ? settings["title"].trim() : entry.title;
      if (when.at === entry.at && (end?.at ?? undefined) === entry.end && title === entry.title) continue;
      const next: CalendarEvent = { ...entry, title, at: when.at, allDay: when.dateOnly, updatedAt: at };
      if (end) next.end = end.at;
      else delete next.end;
      await env.calendar.put(next);
      moved += 1;
    }
  }
  return { moved, closed };
};
