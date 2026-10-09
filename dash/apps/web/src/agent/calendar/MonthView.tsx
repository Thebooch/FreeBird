import type { CalendarEvent } from "@freebirdai/dash-spec";
import { IconButton } from "@freebirdai/dash-components";
import { useEffect, useMemo, useRef, useState } from "react";
import { EntryChip } from "./EntryChip.jsx";
import { MONTH_CELL_ENTRIES, byDay, dayKey, startOfDay, viewDays, type OwnerInfo } from "./model.js";

const WEEKDAYS = (locale?: string): string[] => {
  /* 5 January 2026 is a Monday: the week starts there. */
  return Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 5 + index).toLocaleDateString(locale, { weekday: "short" }));
};

/**
 * Six weeks, Monday first. A day shows up to three entries; "+N more" opens
 * the whole day over the grid, and the day's number opens it in the week
 * view. Days outside the month are there, and marked, because an entry on
 * the 1st that falls on a Sunday has to be somewhere.
 */
export const MonthView = ({
  anchor,
  now,
  entries,
  ownerOf,
  onOpen,
  onDay,
  onAdd,
}: {
  readonly anchor: number;
  readonly now: number;
  readonly entries: readonly CalendarEvent[];
  readonly ownerOf: (entry: CalendarEvent) => OwnerInfo;
  readonly onOpen: (entry: CalendarEvent) => void;
  readonly onDay: (day: number) => void;
  readonly onAdd?: (day: number) => void;
}): JSX.Element => {
  const days = useMemo(() => viewDays("month", anchor), [anchor]);
  const grouped = useMemo(() => byDay(entries, days), [entries, days]);
  const month = new Date(anchor).getMonth();
  const today = dayKey(startOfDay(now));
  const [open, setOpen] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  /* The floated day closes on Escape or a click anywhere else. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(null);
    const onClick = (event: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div className="dash-cal-month" role="grid" aria-readonly="true" data-testid="calendar-month">
      <div className="dash-cal-month__weekdays" role="row">
        {WEEKDAYS().map((name) => (
          <div key={name} className="dash-cal-month__weekday" role="columnheader">
            {name}
          </div>
        ))}
      </div>
      <div className="dash-cal-month__grid">
        {days.map((day) => {
          const key = dayKey(day);
          const list = grouped.get(key) ?? [];
          const shown = list.length > MONTH_CELL_ENTRIES ? list.slice(0, MONTH_CELL_ENTRIES - 1) : list;
          const more = list.length - shown.length;
          const date = new Date(day);
          const weekday = date.getDay();
          const long = date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
          return (
            <div
              key={key}
              className="dash-cal-month__cell"
              role="gridcell"
              aria-label={`${long}${list.length > 0 ? `, ${list.length} ${list.length === 1 ? "entry" : "entries"}` : ""}`}
              data-outside={date.getMonth() !== month ? "true" : undefined}
              data-today={key === today ? "true" : undefined}
              data-weekend={weekday === 0 || weekday === 6 ? "true" : undefined}
              data-day={key}
            >
              <div className="dash-cal-month__date">
                <button type="button" className="dash-cal-month__num" onClick={() => onDay(day)} title={`Open ${long} in the week view`}>
                  {date.getDate()}
                </button>
                {onAdd && (
                  <button type="button" className="dash-cal-month__add" onClick={() => onAdd(day)} aria-label={`Add an entry on ${long}`} title="Add an entry">
                    +
                  </button>
                )}
              </div>
              {shown.length > 0 && (
                <ul className="dash-cal-month__entries">
                  {shown.map((entry) => (
                    <li key={entry.id}>
                      <EntryChip entry={entry} owner={ownerOf(entry)} onOpen={onOpen} />
                    </li>
                  ))}
                </ul>
              )}
              {more > 0 && (
                <button type="button" className="dash-cal-month__more" onClick={() => setOpen(key)} aria-expanded={open === key}>
                  +{more} more
                </button>
              )}
              {open === key && (
                <div className="dash-cal-pop" ref={popRef} role="dialog" aria-label={long}>
                  <div className="dash-cal-pop__head">
                    <span className="dash-cal-pop__title">{long}</span>
                    <IconButton label="Close" onClick={() => setOpen(null)}>
                      ✕
                    </IconButton>
                  </div>
                  {list.map((entry) => (
                    <EntryChip key={entry.id} entry={entry} owner={ownerOf(entry)} onOpen={(one) => (setOpen(null), onOpen(one))} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
