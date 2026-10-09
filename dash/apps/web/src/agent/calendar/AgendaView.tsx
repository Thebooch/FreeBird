import type { CalendarEvent } from "@freebirdai/dash-spec";
import { AgentChip, Badge, EmptyState } from "@freebirdai/dash-components";
import { useMemo } from "react";
import { KIND_LABELS, STATUS_LABELS, byDay, colorVar, dayKey, entryEnd, entryStart, isAllDay, startOfDay, viewDays, type OwnerInfo } from "./model.js";

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const STATUS_TONE: Readonly<Record<CalendarEvent["status"], "neutral" | "accent" | "warn" | "danger">> = {
  open: "neutral",
  tentative: "warn",
  done: "neutral",
  cancelled: "danger",
};

/**
 * The next thirty days as a list, one section per day that has anything. The
 * default on a narrow screen, and the quickest answer to "what's coming up".
 */
export const AgendaView = ({
  anchor,
  now,
  entries,
  ownerOf,
  sourceOf,
  onOpen,
  onAdd,
}: {
  readonly anchor: number;
  readonly now: number;
  readonly entries: readonly CalendarEvent[];
  readonly ownerOf: (entry: CalendarEvent) => OwnerInfo;
  /** A few words on where an entry came from: "Workflow · Unassigned work orders". */
  readonly sourceOf: (entry: CalendarEvent) => string;
  readonly onOpen: (entry: CalendarEvent) => void;
  readonly onAdd?: () => void;
}): JSX.Element => {
  const days = useMemo(() => viewDays("agenda", anchor), [anchor]);
  const grouped = useMemo(() => byDay(entries, days), [entries, days]);
  const today = dayKey(startOfDay(now));
  const filled = days.filter((day) => (grouped.get(dayKey(day)) ?? []).length > 0);

  if (filled.length === 0) {
    return (
      <div className="dash-cal-agenda__empty" data-testid="calendar-agenda-empty">
        <EmptyState
          glyph="▦"
          title="Nothing scheduled in these 30 days"
          body="Entries appear here as workflows schedule them, bookings come in, or you add them yourself."
          {...(onAdd ? { action: { label: "Add an entry", onClick: onAdd } } : {})}
        />
      </div>
    );
  }

  return (
    <div className="dash-cal-agenda" data-testid="calendar-agenda">
      {filled.map((day) => {
        const key = dayKey(day);
        const list = grouped.get(key) ?? [];
        const date = new Date(day);
        return (
          <section key={key} className="dash-cal-agenda__day" aria-label={date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}>
            <header className="dash-cal-agenda__dayhead">
              <span className="dash-cal-agenda__dow">{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="dash-cal-agenda__date">{date.toLocaleDateString(undefined, { day: "numeric", month: "long" })}</span>
              {key === today && <Badge tone="accent">Today</Badge>}
              <span className="dash-cal-agenda__count">
                {list.length} {list.length === 1 ? "entry" : "entries"}
              </span>
            </header>
            <ul className="dash-cal-agenda__list">
              {list.map((entry) => {
                const owner = ownerOf(entry);
                const start = entryStart(entry);
                const end = entryEnd(entry);
                const continued = !isAllDay(entry) && startOfDay(start) < day;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="dash-cal-agenda__row"
                      data-status={entry.status}
                      data-kind={entry.kind}
                      style={{ ["--cal-color" as string]: colorVar(owner.color) }}
                      onClick={() => onOpen(entry)}
                      data-testid="calendar-agenda-row"
                    >
                      <span className="dash-cal-agenda__time">
                        {isAllDay(entry) ? (
                          "All day"
                        ) : continued ? (
                          `until ${time(end)}`
                        ) : (
                          <>
                            <span>{time(start)}</span>
                            {end > start && <span className="dash-cal-agenda__time-end">{time(end)}</span>}
                          </>
                        )}
                      </span>
                      <span className="dash-cal-agenda__bar" aria-hidden="true" />
                      <span className="dash-cal-agenda__main">
                        <span className="dash-cal-agenda__title">
                          {entry.kind === "deadline" ? "⚑ " : ""}
                          {entry.title}
                        </span>
                        <span className="dash-cal-agenda__meta">{sourceOf(entry)}</span>
                      </span>
                      <span className="dash-cal-agenda__side">
                        {owner.kind !== "none" && <AgentChip name={owner.name} color={owner.color || 1} size="sm" />}
                        {entry.kind !== "event" && <Badge>{KIND_LABELS[entry.kind]}</Badge>}
                        {entry.status !== "open" && <Badge tone={STATUS_TONE[entry.status]}>{STATUS_LABELS[entry.status]}</Badge>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
};
