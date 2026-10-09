import type { CalendarEvent } from "@freebirdai/dash-spec";
import { KIND_LABELS, STATUS_LABELS, colorVar, isAllDay, shortTime, timeLabel, type OwnerInfo } from "./model.js";

/**
 * One entry, as the month grid shows it: its owner's colour down the left,
 * its time if it has one, and its title. A deadline is outlined rather than
 * filled, a held appointment is hatched, and done or cancelled is struck
 * through, so what an entry *is* reads before what it says.
 */
export const EntryChip = ({
  entry,
  owner,
  onOpen,
}: {
  readonly entry: CalendarEvent;
  readonly owner: OwnerInfo;
  readonly onOpen: (entry: CalendarEvent) => void;
}): JSX.Element => {
  const label = [entry.title, timeLabel(entry), owner.name, entry.kind !== "event" ? KIND_LABELS[entry.kind] : "", entry.status !== "open" ? STATUS_LABELS[entry.status] : ""]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      className="dash-cal-chip"
      data-kind={entry.kind}
      data-status={entry.status}
      style={{ ["--cal-color" as string]: colorVar(owner.color) }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(entry);
      }}
      title={label}
      aria-label={label}
      data-testid="calendar-chip"
    >
      {entry.kind === "deadline" && (
        <span className="dash-cal-chip__flag" aria-hidden="true">
          ⚑
        </span>
      )}
      {!isAllDay(entry) && <span className="dash-cal-chip__time">{shortTime(entry)}</span>}
      <span className="dash-cal-chip__title">{entry.title}</span>
    </button>
  );
};
