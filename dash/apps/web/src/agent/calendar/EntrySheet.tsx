import type { CalendarEvent } from "@freebirdai/dash-spec";
import { AgentChip, Badge, Button } from "@freebirdai/dash-components";
import { useEffect, useState } from "react";
import { api } from "../../api.js";
import type { Route } from "../../route.js";
import { KIND_LABELS, STATUS_LABELS, colorVar, entryEnd, entryStart, isAllDay, timeLabel, type OwnerInfo } from "./model.js";

const dateWords = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** "Tuesday 14 October 2026 · 9:00 AM – 10:30 AM", or a date range for a whole-day entry. */
export const whenWords = (entry: CalendarEvent): { readonly date: string; readonly time: string } => {
  const start = entryStart(entry);
  const end = entryEnd(entry);
  if (isAllDay(entry)) {
    const multi = entry.end && new Date(end).toDateString() !== new Date(start).toDateString();
    return { date: multi ? `${dateWords(start)} – ${dateWords(end)}` : dateWords(start), time: "All day" };
  }
  return { date: dateWords(start), time: timeLabel(entry) };
};

/**
 * One entry, beside the calendar: when, whose, where it came from, and what
 * can be done to it. A workflow's entry links back to its workflow, and to
 * the record it is about; changing one by hand pins it, and the sheet says
 * so before the person does it.
 */
export const EntrySheet = ({
  entry,
  owner,
  workflowName,
  canManage,
  onClose,
  onEdit,
  onChanged,
  onNavigate,
}: {
  readonly entry: CalendarEvent;
  readonly owner: OwnerInfo;
  readonly workflowName?: string;
  readonly canManage: boolean;
  readonly onClose: () => void;
  readonly onEdit: (entry: CalendarEvent) => void;
  /** The entry as it is now, or null when it was removed. */
  readonly onChanged: (entry: CalendarEvent | null) => void;
  readonly onNavigate: (route: Route) => void;
}): JSX.Element => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (what: string, run: () => Promise<CalendarEvent | null>) => {
    setBusy(what);
    setError(null);
    try {
      onChanged(await run());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const when = whenWords(entry);
  const appointment = entry.kind === "appointment" || Boolean(entry.booking);
  const finished = entry.status === "done" || entry.status === "cancelled";
  const madeBy = entry.workflow ? "Workflow" : entry.booking ? "Booking" : "Added by hand";

  return (
    <div className="dash-sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="dash-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-entry-title"
        onClick={(event) => event.stopPropagation()}
        style={{ ["--cal-color" as string]: colorVar(owner.color), width: "min(560px, 100%)" }}
        data-testid="calendar-entry-sheet"
      >
        <header className="dash-sheet__head">
          <div className="dash-sheet__trail">
            <span className="dash-cal-sheet__swatch" aria-hidden="true" />
            <span>Calendar</span>
            <span className="dash-sheet__crumb-sep">/</span>
            <span>{KIND_LABELS[entry.kind]}</span>
          </div>
          <div className="dash-sheet__bar">
            <h2 id="calendar-entry-title" className="dash-sheet__title">
              {entry.title}
            </h2>
            <Button tone="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>

        <div className="dash-sheet__body">
          <section className="dash-sheet__section">
            <dl className="dash-cal-sheet__facts">
              <dt>When</dt>
              <dd>
                <span className="dash-cal-sheet__when">{when.date}</span>
              </dd>
              <dt>Time</dt>
              <dd>{when.time}</dd>
              <dt>Status</dt>
              <dd>
                <Badge tone={entry.status === "cancelled" ? "danger" : entry.status === "tentative" ? "warn" : entry.status === "open" ? "accent" : "neutral"}>
                  {STATUS_LABELS[entry.status]}
                </Badge>
                {entry.pinned && <Badge title="Changed by hand: the workflow that made it leaves it where it is.">Pinned</Badge>}
              </dd>
              <dt>Owner</dt>
              <dd>{owner.kind === "none" ? <span className="dash-hint">Nobody</span> : <AgentChip name={owner.name} color={owner.color || 1} />}</dd>
              <dt>Made by</dt>
              <dd>
                {entry.workflow ? (
                  <button type="button" className="dash-cal-sheet__link" onClick={() => onNavigate({ kind: "agent", section: "workflows", id: entry.workflow! })}>
                    {workflowName ?? "A workflow"}
                  </button>
                ) : (
                  madeBy
                )}
              </dd>
              {entry.source && (
                <>
                  <dt>About</dt>
                  <dd>
                    <button
                      type="button"
                      className="dash-cal-sheet__link"
                      onClick={() =>
                        onNavigate({
                          kind: "entity",
                          connectionId: entry.source!.connection,
                          entityId: entry.source!.entity,
                          recordId: entry.source!.recordId,
                          ...(entry.source!.parents ? { parents: entry.source!.parents } : {}),
                        })
                      }
                    >
                      Open the {entry.source.entity} record ({entry.source.recordId})
                    </button>
                  </dd>
                </>
              )}
            </dl>
          </section>

          {entry.notes && (
            <section className="dash-sheet__section">
              <h3 className="dash-sheet__sub">Notes</h3>
              <p className="dash-cal-sheet__notes">{entry.notes}</p>
            </section>
          )}

          {appointment ? (
            <p className="dash-cal-sheet__callout">This is an appointment. It changes through its booking, so the booking page and the calendar always agree.</p>
          ) : entry.workflow && !entry.pinned && canManage ? (
            <p className="dash-cal-sheet__callout">A workflow keeps this entry in step with its record. Changing it here pins it: the workflow will leave it where you put it.</p>
          ) : null}

          {error && (
            <p className="dash-cal-form__error" role="alert">
              {error}
            </p>
          )}
        </div>

        {canManage && !appointment && (
          <footer className="dash-cal-sheet__foot">
            <div className="dash-cal-sheet__foot-group">
              {finished ? (
                <Button busy={busy === "reopen"} onClick={() => void act("reopen", () => api.setCalendarStatus(entry.id, "open"))}>
                  Reopen
                </Button>
              ) : (
                <>
                  <Button tone="primary" busy={busy === "done"} onClick={() => void act("done", () => api.setCalendarStatus(entry.id, "done"))} testId="calendar-entry-done">
                    Mark done
                  </Button>
                  <Button onClick={() => onEdit(entry)} testId="calendar-entry-edit">
                    Edit
                  </Button>
                </>
              )}
            </div>
            <div className="dash-cal-sheet__foot-group">
              {!finished && (
                <Button tone="ghost" busy={busy === "cancel"} onClick={() => void act("cancel", () => api.setCalendarStatus(entry.id, "cancelled"))}>
                  Cancel entry
                </Button>
              )}
              {!entry.workflow &&
                (confirming ? (
                  <>
                    <span className="dash-hint">Delete for good?</span>
                    <Button tone="danger" busy={busy === "delete"} onClick={() => void act("delete", async () => (await api.removeCalendarEntry(entry.id), null))}>
                      Delete
                    </Button>
                    <Button tone="ghost" onClick={() => setConfirming(false)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button tone="danger" onClick={() => setConfirming(true)}>
                    Delete
                  </Button>
                ))}
            </div>
          </footer>
        )}
      </div>
    </div>
  );
};
