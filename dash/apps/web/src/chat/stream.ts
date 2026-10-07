import type { ChatMessage } from "@freebirdai/core";

/**
 * The chat as one stream (plan 3).
 *
 * There is no "new chat" any more: every message, in every topic, reads as one
 * conversation, loaded a day at a time. Today is always loaded; scrolling past
 * the top border loads the day before, and a jump from the timeline loads the
 * day it lands on, with the days after it loading as the reader scrolls down.
 * What the store holds live (the turn being had now) is added at the bottom
 * whenever the loaded days reach the latest one.
 */

/** One loaded day of the stream. */
export interface StreamDay {
  readonly day: string;
  readonly messages: readonly ChatMessage[];
  /** The nearest earlier day with messages, or null at the beginning. */
  readonly prev: string | null;
  /** The nearest later day with messages, or null when this is the latest. */
  readonly next: string | null;
}

export type StreamItem =
  | { readonly kind: "day"; readonly key: string; readonly day: string }
  | { readonly kind: "topic"; readonly key: string; readonly topicId: string; readonly name: string }
  | { readonly kind: "message"; readonly key: string; readonly message: ChatMessage; readonly day: string };

/** Whether the loaded days reach the latest message, so live messages belong below them. */
export const reachesLatest = (days: readonly StreamDay[], today: string): boolean => {
  const last = days[days.length - 1];
  return !last || last.day >= today || last.next === null;
};

/** Add a day in its place, replacing one already loaded. Days stay oldest first. */
export const withDay = (days: readonly StreamDay[], loaded: StreamDay): StreamDay[] =>
  [...days.filter((one) => one.day !== loaded.day), loaded].sort((a, b) => a.day.localeCompare(b.day));

const shown = (message: ChatMessage): boolean => message.role === "user" || message.role === "assistant";

/**
 * Day headings, topic dividers and messages, in reading order.
 *
 * A topic divider goes wherever the topic changes and at the top of each day,
 * so a day read on its own still says what it was about. Messages appear once
 * even when a loaded day and the live store both hold them.
 */
export const buildStream = (input: {
  readonly days: readonly StreamDay[];
  /** What the store holds for the turn being had, oldest first. */
  readonly live: readonly ChatMessage[];
  readonly today: string;
  /** Topic names by id. */
  readonly topics: Readonly<Record<string, string>>;
}): StreamItem[] => {
  const items: StreamItem[] = [];
  const seen = new Set<string>();
  let day: string | null = null;
  let topic: string | null = null;

  const push = (message: ChatMessage, on: string) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    if (on !== day) {
      day = on;
      topic = null;
      items.push({ kind: "day", key: `day:${on}`, day: on });
    }
    // A message the store made up (an error line) has no topic of its own.
    if (message.sessionId && message.sessionId !== topic && shown(message)) {
      topic = message.sessionId;
      items.push({
        kind: "topic",
        key: `topic:${on}:${message.id}`,
        topicId: message.sessionId,
        name: input.topics[message.sessionId] ?? "Earlier chat",
      });
    }
    items.push({ kind: "message", key: message.id, message, day: on });
  };

  for (const loaded of input.days) for (const message of loaded.messages) push(message, loaded.day);
  if (reachesLatest(input.days, input.today)) for (const message of input.live) push(message, input.today);
  return items;
};

/** "Today", "Yesterday", or the date, for a `YYYY-MM-DD` in the reader's own calendar. */
export const dayLabel = (day: string, today: string): string => {
  if (day === today) return "Today";
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  const yesterday = new Date(ty, tm - 1, td - 1);
  if (date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()) {
    return "Yesterday";
  }
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(y !== ty ? { year: "numeric" } : {}),
  });
};

/** The time of day, for timeline rows. */
export const timeLabel = (at: string): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Messages the store has held since the column opened, kept across topic
 * switches: opening a topic empties the store, but what was just said must
 * stay on screen in the one stream.
 */
export const mergeLive = (kept: readonly ChatMessage[], current: readonly ChatMessage[]): ChatMessage[] => {
  const byId = new Map(kept.map((message) => [message.id, message]));
  for (const message of current) byId.set(message.id, message);
  return [...byId.values()];
};
