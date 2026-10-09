import type { Block, CalendarEvent } from "@freebirdai/dash-spec";
import type { HostOccurrence } from "../../api.js";
import { useEffect, useMemo, useRef } from "react";
import { EntryChip } from "./EntryChip.jsx";
import { colorVar, dayKey, dayOf, entryEnd, entryStart, isAllDay, shortSpan, startOfDay, timeLabel, viewDays, type OwnerInfo } from "./model.js";

const HOUR_PX = 48;
const MINUTE_PX = HOUR_PX / 60;
/** The shortest an entry is drawn, so a point in time is still something to click. */
const MIN_MINUTES = 24;

interface Placed {
  readonly entry: CalendarEvent;
  readonly top: number;
  readonly height: number;
  readonly lane: number;
  readonly lanes: number;
}

/**
 * Lay out one day's timed entries side by side where they overlap.
 *
 * Greedy lanes within each cluster of entries that overlap one another: an
 * entry takes the first lane free at its start, and every entry in a cluster
 * is as wide as the cluster's widest point allows. Exported for its test.
 */
export const layDay = (entries: readonly CalendarEvent[], day: number): Placed[] => {
  const next = new Date(day);
  const dayEnd = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1).getTime();
  const spans = entries
    .map((entry) => {
      const start = Math.max(entryStart(entry), day);
      const end = Math.min(Math.max(entryEnd(entry), entryStart(entry) + MIN_MINUTES * 60_000), dayEnd);
      return { entry, start, end };
    })
    .filter((one) => one.end > day && one.start < dayEnd)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const placed: Placed[] = [];
  let cluster: Array<{ entry: CalendarEvent; start: number; end: number; lane: number }> = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((one) => one.lane + 1));
    for (const one of cluster) {
      const minutes = (one.start - day) / 60_000;
      placed.push({ entry: one.entry, top: minutes * MINUTE_PX, height: Math.max((one.end - one.start) / 60_000, MIN_MINUTES) * MINUTE_PX, lane: one.lane, lanes });
    }
    cluster = [];
  };
  for (const span of spans) {
    if (span.start >= clusterEnd && cluster.length > 0) flush();
    const taken = new Set(cluster.filter((one) => one.end > span.start).map((one) => one.lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    cluster.push({ ...span, lane });
    clusterEnd = Math.max(clusterEnd === -Infinity ? span.end : clusterEnd, span.end);
  }
  if (cluster.length > 0) flush();
  return placed;
};

/**
 * Seven days as a time grid: all-day entries and deadlines in a lane across
 * the top, timed entries placed by the minute below, a line at now. Opens
 * scrolled to the working day; an empty half hour is a button that starts a
 * new entry there.
 */
export const WeekView = ({
  anchor,
  now,
  entries,
  ownerOf,
  onOpen,
  onAddAt,
  bands = [],
  blocks = [],
}: {
  readonly anchor: number;
  readonly now: number;
  readonly entries: readonly CalendarEvent[];
  readonly ownerOf: (entry: CalendarEvent) => OwnerInfo;
  readonly onOpen: (entry: CalendarEvent) => void;
  readonly onAddAt?: (at: number) => void;
  /** One person's block occurrences, drawn as bands behind the entries. */
  readonly bands?: readonly HostOccurrence[];
  readonly blocks?: readonly Block[];
}): JSX.Element => {
  const days = useMemo(() => viewDays("week", anchor), [anchor]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = dayKey(startOfDay(now));

  /* Open at 7:00, so the working day is in view without scrolling. */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX - 8;
  }, [anchor]);

  const allDay = (day: number): CalendarEvent[] => {
    const key = dayKey(day);
    return entries.filter((entry) => (isAllDay(entry) || entry.kind === "deadline") && entryCovers(entry, key));
  };
  const timed = (day: number): CalendarEvent[] => {
    const next = new Date(day);
    const dayEnd = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1).getTime();
    return entries.filter((entry) => !isAllDay(entry) && entry.kind !== "deadline" && entryStart(entry) < dayEnd && Math.max(entryEnd(entry), entryStart(entry) + 1) > day);
  };
  const nowOffset = (now - startOfDay(now)) / 60_000;

  return (
    <div className="dash-cal-week" data-testid="calendar-week">
      <div className="dash-cal-week__head" role="row">
        <span aria-hidden="true" />
        {days.map((day) => {
          const date = new Date(day);
          return (
            <div key={day} className="dash-cal-week__day" data-today={dayKey(day) === today ? "true" : undefined} role="columnheader">
              <span className="dash-cal-week__dow">{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="dash-cal-week__date">{date.getDate()}</span>
            </div>
          );
        })}
      </div>
      <div className="dash-cal-week__allday">
        <span className="dash-cal-week__allday-label">All day</span>
        {days.map((day) => (
          <div key={day} className="dash-cal-week__allday-cell">
            {allDay(day).map((entry) => (
              <EntryChip key={entry.id} entry={entry} owner={ownerOf(entry)} onOpen={onOpen} />
            ))}
          </div>
        ))}
      </div>
      <div className="dash-cal-week__scroll" ref={scrollRef}>
        <div className="dash-cal-week__body">
          <div className="dash-cal-week__hours" aria-hidden="true">
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="dash-cal-week__hour">
                {hour === 0 ? "" : new Date(2026, 0, 5, hour).toLocaleTimeString(undefined, { hour: "numeric" })}
              </span>
            ))}
          </div>
          {days.map((day) => {
            const isToday = dayKey(day) === today;
            const date = new Date(day);
            return (
              <div key={day} className="dash-cal-week__col" data-today={isToday ? "true" : undefined} style={{ height: 24 * HOUR_PX }}>
                {onAddAt &&
                  Array.from({ length: 48 }, (_, half) => {
                    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(half / 2), (half % 2) * 30).getTime();
                    return (
                      <button
                        key={half}
                        type="button"
                        className="dash-cal-week__slot"
                        style={{ top: half * (HOUR_PX / 2) }}
                        tabIndex={-1}
                        aria-label={`Add an entry at ${new Date(at).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}`}
                        onClick={() => onAddAt(at)}
                      />
                    );
                  })}
                {bands
                  .filter((band) => band.start < dayEndOf(day) && band.end > day)
                  .map((band) => {
                    const block = blocks.find((one) => one.id === (band.setTo ?? band.block));
                    const blank = blocks.find((one) => one.id === band.block);
                    const top = ((Math.max(band.start, day) - day) / 60_000) * MINUTE_PX;
                    const height = ((Math.min(band.end, dayEndOf(day)) - Math.max(band.start, day)) / 60_000) * MINUTE_PX;
                    const label =
                      band.kind === "closed"
                        ? `${blank?.name ?? "Closed"} · closed`
                        : band.kind === "blank"
                          ? band.setTo
                            ? `${block?.name ?? "Block"} · set by first booking`
                            : `Blank · becomes ${(blank?.becomes ?? []).map((id) => blocks.find((one) => one.id === id)?.name ?? id).join(" or ")}`
                          : (block?.name ?? "Block");
                    return (
                      <span
                        key={`${band.placement}-${band.date}`}
                        className="dash-cal-week__band"
                        data-kind={band.kind}
                        data-set={band.setTo ? "true" : undefined}
                        style={{ top, height, ["--cal-color" as string]: colorVar(band.kind === "blank" && !band.setTo ? 0 : (block?.color ?? 0)) }}
                        title={label}
                        aria-hidden="true"
                      >
                        <span className="dash-cal-week__band-label">{label}</span>
                      </span>
                    );
                  })}
                {layDay(timed(day), day).map(({ entry, top, height, lane, lanes }) => {
                  const owner = ownerOf(entry);
                  const width = 100 / lanes;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className="dash-cal-week__event"
                      data-status={entry.status}
                      style={{
                        ["--cal-color" as string]: colorVar(owner.color),
                        top,
                        height: Math.max(height - 2, 18),
                        left: `calc(${lane * width}% + 2px)`,
                        width: `calc(${width}% - 4px)`,
                      }}
                      onClick={() => onOpen(entry)}
                      title={`${entry.title}, ${timeLabel(entry)}, ${owner.name}`}
                      data-testid="calendar-week-event"
                    >
                      <span className="dash-cal-week__event-title">{entry.title}</span>
                      {height >= 34 && <span className="dash-cal-week__event-time">{shortSpan(entry)}</span>}
                    </button>
                  );
                })}
                {isToday && <span className="dash-cal-week__now" style={{ top: nowOffset * MINUTE_PX }} aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const dayEndOf = (day: number): number => {
  const date = new Date(day);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
};

const entryCovers = (entry: CalendarEvent, key: string): boolean => {
  const start = startOfDay(entryStart(entry));
  const end = startOfDay(Math.max(entryEnd(entry), entryStart(entry)));
  const day = dayOf(key);
  return day >= start && day <= end;
};
