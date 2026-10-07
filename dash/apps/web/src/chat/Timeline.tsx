import { AgentChip, EmptyState, ErrorState } from "@freebirdai/dash-components";
import type { AgentSpec } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ChatDaySummary, type ChatTimelineTask, type ChatTopic } from "../api.js";
import { dayLabel, timeLabel } from "./stream.js";

/**
 * The chat's Timeline tab (plan 3): the conversation, day by day.
 *
 * The first view lists days. Clicking one shows what happened that day in
 * time order: the topics talked about and the work that finished (workflow
 * runs and tasks). Clicking a topic goes back to the chat at the point the
 * topic started, with that whole day loaded.
 */
export const ChatTimeline = ({
  onOpenTopic,
}: {
  readonly onOpenTopic: (day: string, topicId: string) => void;
}): JSX.Element => {
  const [days, setDays] = useState<ChatDaySummary[] | null>(null);
  const [today, setToday] = useState<string>("");
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .chatDays()
      .then((result) => {
        if (cancelled) return;
        setDays(result.days);
        setToday(result.today);
        setMore(result.more);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "The timeline could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const loadMore = useCallback(async () => {
    const oldest = days?.[days.length - 1]?.day;
    if (!oldest || loadingMore || !more) return;
    setLoadingMore(true);
    try {
      const result = await api.chatDays(oldest);
      setDays((current) => [...(current ?? []), ...result.days.filter((one) => !current?.some((have) => have.day === one.day))]);
      setMore(result.more);
    } catch {
      // The button stays; trying again is the person's call.
    } finally {
      setLoadingMore(false);
    }
  }, [days, loadingMore, more]);

  if (selected) {
    return (
      <ChatDay
        day={selected}
        today={today}
        onBack={() => setSelected(null)}
        onOpenTopic={(topicId) => onOpenTopic(selected, topicId)}
      />
    );
  }

  if (error && !days) return <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!days) return <p className="dash-hint dash-timeline__pad">Loading…</p>;
  if (days.length === 0) {
    return <EmptyState title="Nothing yet" body="Days you talk with the assistant, or workflows finish work, show up here." />;
  }

  return (
    <div
      className="dash-timeline"
      data-testid="chat-timeline"
      onScroll={(event) => {
        const el = event.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) void loadMore();
      }}
    >
      <ol className="dash-timeline__days">
        {days.map((one) => (
          <li key={one.day}>
            <button
              type="button"
              className="dash-timeline__day"
              onClick={() => setSelected(one.day)}
              data-testid={`timeline-day-${one.day}`}
            >
              <span className="dash-timeline__day-name">{dayLabel(one.day, today)}</span>
              <span className="dash-timeline__counts">
                {[
                  one.topics > 0 ? `${one.topics} topic${one.topics === 1 ? "" : "s"}` : null,
                  one.tasks > 0 ? `${one.tasks} task${one.tasks === 1 ? "" : "s"} done` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {more && (
        <button type="button" className="dash-control dash-timeline__more" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Earlier days"}
        </button>
      )}
    </div>
  );
};

type DayItem = { kind: "topic"; at: string; topic: ChatTopic } | { kind: "task"; at: string; task: ChatTimelineTask };

/** One day: its topics and finished work, in time order. */
const ChatDay = ({
  day,
  today,
  onBack,
  onOpenTopic,
}: {
  readonly day: string;
  readonly today: string;
  readonly onBack: () => void;
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

  return (
    <div className="dash-timeline" data-testid="chat-timeline-day">
      <div className="dash-timeline__dayhead">
        <button type="button" className="dash-iconbtn" onClick={onBack} aria-label="All days" title="All days" data-testid="timeline-back">
          ←
        </button>
        <h4 className="dash-timeline__title">{dayLabel(day, today)}</h4>
      </div>
      {error && !found && <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />}
      {!found && !error && <p className="dash-hint dash-timeline__pad">Loading…</p>}
      {found && items.length === 0 && <p className="dash-hint dash-timeline__pad">Nothing happened this day.</p>}
      <ol className="dash-timeline__rail">
        {items.map((item) =>
          item.kind === "topic" ? (
            <li key={`topic:${item.topic.id}`} className="dash-timeline__item" data-kind="topic">
              <button
                type="button"
                className="dash-timeline__row"
                onClick={() => onOpenTopic(item.topic.id)}
                data-testid={`timeline-topic-${item.topic.id}`}
              >
                <span className="dash-timeline__time">{timeLabel(item.at)}</span>
                <span className="dash-timeline__name">{item.topic.name}</span>
                <span className="dash-timeline__meta">
                  {item.topic.count} message{item.topic.count === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ) : (
            <li key={item.task.id} className="dash-timeline__item" data-kind="task" data-status={item.task.status}>
              <a
                className="dash-timeline__row"
                href={item.task.link ?? "#/agent/overview"}
                data-testid={`timeline-task-${item.task.id}`}
              >
                <span className="dash-timeline__time">{timeLabel(item.at)}</span>
                <span className="dash-timeline__name">
                  {item.task.title}
                  {item.task.status === "failed" ? " (failed)" : ""}
                </span>
                <span className="dash-timeline__meta">
                  {item.task.agent && agentById.get(item.task.agent) ? (
                    <AgentChip name={agentById.get(item.task.agent)!.name} color={agentById.get(item.task.agent)!.color} size="sm" />
                  ) : null}
                  {item.task.detail ? <span>{item.task.detail}</span> : null}
                </span>
              </a>
            </li>
          ),
        )}
      </ol>
    </div>
  );
};
