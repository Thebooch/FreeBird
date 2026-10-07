import { AgentChip, ErrorState } from "@freebirdai/dash-components";
import type { AgentSpec } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type ChatDaySummary, type ChatTimelineTask, type ChatTopic } from "../api.js";
import {
  addDays,
  addMonths,
  firstOfMonth,
  fromDay,
  monthGrid,
  monthOf,
  recentDays,
  sameDayIn,
  toDay,
  weekdayNames,
  type Month,
} from "./calendar.js";
import { dayLabel, timeLabel } from "./stream.js";

/**
 * The chat's Timeline tab (plan 3): the conversation, day by day.
 *
 * The last seven calendar days sit across the top as tiles, today last; a
 * day with nothing in it is muted but still opens. "Later" opens a month
 * calendar for anything older, with the days that had activity marked. The
 * day picked shows below: the topics talked about and the work that finished
 * (workflow runs and tasks), in time order. Clicking a topic goes back to the
 * chat at the point the topic started, with that whole day loaded.
 *
 * Counts are only shown inside a day; the tiles and the calendar only say
 * whether anything happened.
 */
export const ChatTimeline = ({
  onOpenTopic,
}: {
  readonly onOpenTopic: (day: string, topicId: string) => void;
}): JSX.Element => {
  // The browser's own today until the server (asked in the same time zone) says.
  const [today, setToday] = useState<string>(() => toDay(new Date()));
  const [recent, setRecent] = useState<Map<string, ChatDaySummary> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Seven distinct days with activity always cover the last seven calendar days.
    api
      .chatDays(undefined, 7)
      .then((result) => {
        if (cancelled) return;
        setToday(result.today);
        setRecent(new Map(result.days.map((one) => [one.day, one])));
        // Open on the latest day that had something in it, else today.
        setSelected((current) => current ?? result.days[0]?.day ?? result.today);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "The timeline could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const tiles = useMemo(() => recentDays(today, 7), [today]);
  const olderPicked = selected !== null && selected < tiles[0]!;

  return (
    <div className="dash-chat-timeline" data-testid="chat-timeline">
      <div className="dash-chat-timeline__strip">
        <div className="dash-chat-timeline__strip-head">
          <span className="dash-chat-timeline__eyebrow">Last 7 days</span>
          <LaterPicker today={today} selected={olderPicked ? selected : null} onPick={setSelected} />
        </div>
        {error && !recent ? (
          <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : (
          <ol className="dash-chat-timeline__tiles" aria-label="Last 7 days">
            {tiles.map((day) => {
              const date = fromDay(day);
              const empty = recent !== null && !recent.has(day);
              return (
                <li key={day}>
                  <button
                    type="button"
                    className="dash-chat-timeline__tile"
                    data-empty={empty ? "true" : undefined}
                    data-today={day === today ? "true" : undefined}
                    aria-pressed={selected === day}
                    aria-current={day === today ? "date" : undefined}
                    aria-label={`${longDate(day, today)}${empty ? ", nothing recorded" : ""}`}
                    onClick={() => setSelected(day)}
                    data-testid={`timeline-day-${day}`}
                  >
                    <span className="dash-chat-timeline__tile-weekday">
                      {date.toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <span className="dash-chat-timeline__tile-date">{date.getDate()}</span>
                    <span className="dash-chat-timeline__tile-month">
                      {date.toLocaleDateString(undefined, { month: "short" })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {selected ? (
        <ChatDay key={selected} day={selected} today={today} onOpenTopic={(topicId) => onOpenTopic(selected, topicId)} />
      ) : (
        !error && <p className="dash-chat-timeline__note">Loading…</p>
      )}
    </div>
  );
};

/** "Wednesday, October 7" (with the year when it is not this one). */
const longDate = (day: string, today: string): string =>
  fromDay(day).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
  });

/**
 * "Later": older days, from a month calendar.
 *
 * The days with activity are read a page at a time (newest first), only as
 * far back as the month on screen, and kept while the tab is open.
 */
const LaterPicker = ({
  today,
  selected,
  onPick,
}: {
  readonly today: string;
  /** The older day being shown, when one was picked here. */
  readonly selected: string | null;
  readonly onPick: (day: string) => void;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const [active, setActive] = useState<ReadonlySet<string>>(new Set());
  const [reading, setReading] = useState(false);
  const known = useRef<{ reach: string | null; done: boolean; busy: boolean; wanted: string; alive: boolean }>({
    reach: null,
    done: false,
    busy: false,
    wanted: "9999-12-31",
    alive: true,
  });
  useEffect(() => {
    known.current.alive = true;
    return () => {
      known.current.alive = false;
    };
  }, []);

  /** Read activity back to `from` (inclusive), unless it is already known. */
  const reachBack = useCallback(async (from: string) => {
    const state = known.current;
    if (from < state.wanted) state.wanted = from;
    const needed = () => !state.done && (state.reach === null || state.reach > state.wanted);
    if (state.busy || !needed()) return;
    state.busy = true;
    setReading(true);
    try {
      while (needed()) {
        const page = await api.chatDays(state.reach ?? undefined, 120);
        if (!state.alive) return;
        setActive((current) => new Set([...current, ...page.days.map((one) => one.day)]));
        const oldest = page.days[page.days.length - 1]?.day;
        if (!page.more || !oldest) state.done = true;
        else state.reach = oldest;
      }
    } catch {
      // Unmarked days still open; the marks are a guide, not the way in.
    } finally {
      state.busy = false;
      if (state.alive) setReading(false);
    }
  }, []);

  const onMonth = useCallback((month: Month) => void reachBack(firstOfMonth(month)), [reachBack]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="dash-later" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className="dash-later__trigger"
        data-active={selected ? "true" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
        data-testid="timeline-later"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="12" height="11" rx="2" />
          <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
        </svg>
        {selected ? fromDay(selected).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Later"}
      </button>
      {open && (
        <DatePicker
          today={today}
          initial={selected ?? addDays(today, -7)}
          active={active}
          reading={reading}
          onMonth={onMonth}
          onPick={(day) => {
            onPick(day);
            close();
          }}
          onClose={close}
        />
      )}
    </div>
  );
};

/** A standard month calendar: arrows between months, arrow keys between days. */
const DatePicker = ({
  today,
  initial,
  active,
  reading,
  onMonth,
  onPick,
  onClose,
}: {
  readonly today: string;
  readonly initial: string;
  readonly active: ReadonlySet<string>;
  readonly reading: boolean;
  readonly onMonth: (month: Month) => void;
  readonly onPick: (day: string) => void;
  readonly onClose: () => void;
}): JSX.Element => {
  const [focused, setFocused] = useState(initial);
  const [view, setView] = useState<Month>(() => monthOf(initial));
  const grid = useRef<HTMLDivElement>(null);
  /** Focus follows the roving day only once it is already inside the grid. */
  const moveFocus = useRef(true);

  const thisMonth = monthOf(today);
  const atLatest = view.year === thisMonth.year && view.month === thisMonth.month;
  const weeks = useMemo(() => monthGrid(view), [view]);
  const names = useMemo(() => weekdayNames("narrow"), []);
  const fullNames = useMemo(() => weekdayNames("short"), []);

  useEffect(() => {
    onMonth(view);
  }, [view, onMonth]);

  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)?.focus();
  }, [focused, view]);

  const go = (day: string) => {
    const capped = day > today ? today : day;
    moveFocus.current = true;
    setFocused(capped);
    const month = monthOf(capped);
    if (month.year !== view.year || month.month !== view.month) setView(month);
  };

  const shiftMonth = (n: number) => {
    const next = addMonths(view, n);
    moveFocus.current = false;
    setView(next);
    const day = sameDayIn(focused, next);
    setFocused(day > today ? today : day);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const weekday = fromDay(focused).getDay();
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      Home: () => addDays(focused, -weekday),
      End: () => addDays(focused, 6 - weekday),
      PageUp: () => sameDayIn(focused, addMonths(monthOf(focused), event.shiftKey ? -12 : -1)),
      PageDown: () => sameDayIn(focused, addMonths(monthOf(focused), event.shiftKey ? 12 : 1)),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    go(move());
  };

  const title = new Date(view.year, view.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div
      className="dash-later__pop"
      role="dialog"
      aria-label="Choose a date"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      data-testid="timeline-calendar"
    >
      <div className="dash-later__head">
        <button type="button" className="dash-later__nav" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M10 3.5 5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="dash-later__title" aria-live="polite">
          {title}
        </span>
        <button
          type="button"
          className="dash-later__nav"
          onClick={() => shiftMonth(1)}
          disabled={atLatest}
          aria-label="Next month"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="dash-later__grid" role="grid" aria-label={title} ref={grid} onKeyDown={onKey}>
        <div className="dash-later__row" role="row">
          {names.map((name, index) => (
            <span key={index} className="dash-later__weekday" role="columnheader" aria-label={fullNames[index]}>
              {name}
            </span>
          ))}
        </div>
        {weeks.map((week, row) => (
          <div key={row} className="dash-later__row" role="row">
            {week.map((day, index) =>
              day === null ? (
                <span key={index} role="gridcell" className="dash-later__blank" />
              ) : (
                <span key={day} role="gridcell">
                  <button
                    type="button"
                    className="dash-later__day"
                    data-day={day}
                    data-active={active.has(day) ? "true" : undefined}
                    data-today={day === today ? "true" : undefined}
                    tabIndex={day === focused ? 0 : -1}
                    disabled={day > today}
                    aria-current={day === today ? "date" : undefined}
                    aria-label={`${longDate(day, today)}${active.has(day) ? ", has activity" : ""}`}
                    onClick={() => onPick(day)}
                    onFocus={() => {
                      moveFocus.current = true;
                      if (day !== focused) setFocused(day);
                    }}
                  >
                    {fromDay(day).getDate()}
                  </button>
                </span>
              ),
            )}
          </div>
        ))}
      </div>
      <div className="dash-later__foot">
        <span className="dash-later__legend">
          <i aria-hidden="true" /> Activity
        </span>
        {reading && <span className="dash-later__reading">Reading…</span>}
      </div>
    </div>
  );
};

type DayItem = { kind: "topic"; at: string; topic: ChatTopic } | { kind: "task"; at: string; task: ChatTimelineTask };

/** One day: its topics and finished work, in time order. */
const ChatDay = ({
  day,
  today,
  onOpenTopic,
}: {
  readonly day: string;
  readonly today: string;
  readonly onOpenTopic: (topicId: string) => void;
}): JSX.Element => {
  const [found, setFound] = useState<{ topics: ChatTopic[]; tasks: ChatTimelineTask[] } | null>(null);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .chatDay(day)
      .then((result) => {
        if (!cancelled) setFound(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "This day could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [day, attempt]);

  useEffect(() => {
    let cancelled = false;
    // Only for the chips beside finished work; the day reads fine without them.
    api
      .agents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const items = useMemo<DayItem[]>(
    () =>
      found
        ? [
            ...found.topics.map((topic) => ({ kind: "topic" as const, at: topic.firstAt, topic })),
            ...found.tasks.map((task) => ({ kind: "task" as const, at: task.at, task })),
          ].sort((a, b) => a.at.localeCompare(b.at))
        : [],
    [found],
  );
  const relative = dayLabel(day, today);
  const summary = found
    ? [
        found.topics.length > 0 ? `${found.topics.length} topic${found.topics.length === 1 ? "" : "s"}` : null,
        found.tasks.length > 0 ? `${found.tasks.length} task${found.tasks.length === 1 ? "" : "s"} done` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <section className="dash-chat-timeline__dayview" data-testid="chat-timeline-day" aria-label={longDate(day, today)}>
      <header className="dash-chat-timeline__dayhead">
        {(relative === "Today" || relative === "Yesterday") && <span className="dash-chat-timeline__eyebrow">{relative}</span>}
        <h4 className="dash-chat-timeline__title">{longDate(day, today)}</h4>
        {summary && <p className="dash-chat-timeline__summary">{summary}</p>}
      </header>
      {error && !found && <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />}
      {!found && !error && <p className="dash-chat-timeline__note">Loading…</p>}
      {found && items.length === 0 && (
        <div className="dash-chat-timeline__empty">
          <strong>Nothing recorded</strong>
          <span>No conversations or finished work on this day.</span>
        </div>
      )}
      {items.length > 0 && (
        <ol className="dash-chat-timeline__rail">
          {items.map((item) =>
            item.kind === "topic" ? (
              <li key={`topic:${item.topic.id}`} className="dash-chat-timeline__item" data-kind="topic">
                <span className="dash-chat-timeline__time">{timeLabel(item.at)}</span>
                <button
                  type="button"
                  className="dash-chat-timeline__row"
                  onClick={() => onOpenTopic(item.topic.id)}
                  data-testid={`timeline-topic-${item.topic.id}`}
                >
                  <span className="dash-chat-timeline__kind">Conversation</span>
                  <span className="dash-chat-timeline__name">{item.topic.name}</span>
                  <span className="dash-chat-timeline__meta">
                    {item.topic.count} message{item.topic.count === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ) : (
              <li key={item.task.id} className="dash-chat-timeline__item" data-kind="task" data-status={item.task.status}>
                <span className="dash-chat-timeline__time">{timeLabel(item.at)}</span>
                <a
                  className="dash-chat-timeline__row"
                  href={item.task.link ?? "#/agent/overview"}
                  data-testid={`timeline-task-${item.task.id}`}
                >
                  <span className="dash-chat-timeline__kind">{item.task.status === "failed" ? "Failed" : "Completed"}</span>
                  <span className="dash-chat-timeline__name">{item.task.title}</span>
                  {(item.task.detail || (item.task.agent && agentById.get(item.task.agent))) && (
                    <span className="dash-chat-timeline__meta">
                      {item.task.agent && agentById.get(item.task.agent) ? (
                        <AgentChip name={agentById.get(item.task.agent)!.name} color={agentById.get(item.task.agent)!.color} size="sm" />
                      ) : null}
                      {item.task.detail ? <span>{item.task.detail}</span> : null}
                    </span>
                  )}
                </a>
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
};
