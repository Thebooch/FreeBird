import { useMemo, useState } from "react";
import { STATUS_TONES, statusTone } from "../palette.js";
import { IconButton, Message } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";
import { type CalendarDay, daysCovered, instantOf, monthGrid } from "./collectionModel.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * A month, with each record on the day it falls.
 *
 * The month shown starts on whatever the data is about rather than on today:
 * a widget bound to last quarter that opens on an empty current month looks
 * broken, and the fix — paging back three times — is not obvious.
 */
export const Calendar = (props: WidgetRenderProps): JSX.Element => {
  const startColumn = roleColumn(props.roles, "start");
  const endColumn = roleColumn(props.roles, "end");
  const titleColumn = roleColumn(props.roles, "title");
  const statusColumn = roleColumn(props.roles, "status");

  const formatTitle = makeFormatter(props, titleColumn);

  /** The month the data centres on, unless the reader has paged away. */
  const dataMonth = useMemo(() => {
    if (!startColumn) return props.now;
    const times = props.rows
      .map((row) => instantOf(row[startColumn]))
      .filter((at): at is number => at !== null);
    if (times.length === 0) return props.now;
    // The latest, so a range ending last week opens on last week's month.
    return Math.max(...times);
  }, [props.rows, startColumn, props.now]);

  /*
   * Only the reader's own paging is state, as an offset in months. Storing the
   * month itself would freeze it at mount and a widget whose data moved would
   * keep showing the month it first loaded.
   */
  const [offset, setOffset] = useState(0);
  const shown = useMemo(() => {
    const anchor = new Date(dataMonth);
    return new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1).getTime();
  }, [dataMonth, offset]);

  const days = useMemo(() => monthGrid(shown, props.now), [shown, props.now]);

  const byDay = useMemo(() => {
    const map = new Map<string, { row: Record<string, unknown>; index: number }[]>();
    if (!startColumn) return map;
    props.rows.forEach((row, index) => {
      for (const key of daysCovered(row, startColumn, endColumn)) {
        const existing = map.get(key);
        if (existing) existing.push({ row, index });
        else map.set(key, [{ row, index }]);
      }
    });
    return map;
  }, [props.rows, startColumn, endColumn]);

  if (!startColumn || !titleColumn) {
    return <Message>This widget needs a date field and a title field.</Message>;
  }

  const monthLabel = new Date(shown).toLocaleDateString(props.locale, {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="dash-calendar" data-density={props.presentation?.density ?? "cozy"}>
      <div className="dash-calendar__bar">
        <IconButton label="Previous month" onClick={() => setOffset((value) => value - 1)}>
          ‹
        </IconButton>
        <span className="dash-calendar__month">{monthLabel}</span>
        <IconButton label="Next month" onClick={() => setOffset((value) => value + 1)}>
          ›
        </IconButton>
        {offset !== 0 && (
          <button type="button" className="dash-calendar__reset" onClick={() => setOffset(0)}>
            Back to the data
          </button>
        )}
      </div>

      <div className="dash-calendar__weekdays" aria-hidden="true">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="dash-calendar__grid">
        {days.map((day: CalendarDay) => {
          const entries = byDay.get(day.key) ?? [];
          return (
            <div
              className="dash-calendar__day"
              key={day.key}
              data-in-month={day.inMonth ? "true" : "false"}
              data-today={day.isToday ? "true" : undefined}
            >
              <span className="dash-calendar__date">{day.date}</span>
              <div className="dash-calendar__entries">
                {entries.slice(0, 3).map((entry) => {
                  const status = statusColumn ? entry.row[statusColumn] : null;
                  return (
                    <button
                      type="button"
                      className="dash-calendar__entry"
                      key={entry.index}
                      title={String(entry.row[titleColumn] ?? "")}
                      disabled={!props.onSelectRow}
                      onClick={() => props.onSelectRow?.(entry.row)}
                    >
                      {status != null && (
                        <span
                          className="dash-calendar__tick"
                          style={{ background: STATUS_TONES[statusTone(status)] }}
                          aria-hidden="true"
                        />
                      )}
                      {formatTitle(entry.row[titleColumn])}
                    </button>
                  );
                })}
                {/* A count rather than a scrollbar in a 60px cell. */}
                {entries.length > 3 && (
                  <span className="dash-calendar__more">+{entries.length - 3} more</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
