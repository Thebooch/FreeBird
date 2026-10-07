import { parseCron } from "@freebirdai/core";
import { WORKFLOW_EVERY_MS, type WorkflowTrigger } from "@freebirdai/dash-spec";

/**
 * When a watched workflow is due.
 *
 * A schedule is read in the workflow's own time zone: "weekdays at 7" means
 * 7 where the team is, through daylight saving. Intervals and API polls come
 * round a fixed time after the last run started.
 */

type ParsedCron = ReturnType<typeof parseCron>;

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (zone: string): Intl.DateTimeFormat => {
  let held = formatters.get(zone);
  if (!held) {
    held = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(zone, held);
  }
  return held;
};

const WEEKDAY: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall clock in a zone at one instant. */
const wallClock = (at: number, zone: string) => {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(at))) parts[part.type] = part.value;
  return {
    minute: Number(parts["minute"]),
    hour: Number(parts["hour"]) % 24,
    day: Number(parts["day"]),
    month: Number(parts["month"]),
    weekday: WEEKDAY[parts["weekday"] ?? "Sun"] ?? 0,
  };
};

const matches = (cron: ParsedCron, at: number, zone: string): boolean => {
  const wall = wallClock(at, zone);
  return Boolean(cron.minute[wall.minute] && cron.hour[wall.hour] && cron.dom[wall.day - 1] && cron.month[wall.month - 1] && cron.dow[wall.weekday]);
};

/** How far ahead a schedule is looked for: past this, it is treated as never. */
const HORIZON_MS = 400 * 24 * 60 * 60_000;

/**
 * The first minute strictly after `from` that the schedule names, in the zone;
 * null when none falls within a year and a bit (a 31st of February).
 *
 * Minute by minute, which is plenty: the runner asks once per tick, and a
 * daily schedule is found within 1,440 steps. Whole hours that cannot match
 * are skipped.
 */
export const nextScheduled = (cronSource: string, zone: string, from: number): number | null => {
  const cron = parseCron(cronSource);
  let at = Math.floor(from / 60_000) * 60_000 + 60_000;
  const until = from + HORIZON_MS;
  while (at <= until) {
    const wall = wallClock(at, zone);
    if (!cron.hour[wall.hour] || !cron.dom[wall.day - 1] || !cron.month[wall.month - 1] || !cron.dow[wall.weekday]) {
      /* Nothing this hour: on to the next one. */
      at += (60 - wall.minute) * 60_000;
      continue;
    }
    if (matches(cron, at, zone)) return at;
    at += 60_000;
  }
  return null;
};

/**
 * When a watched workflow is next due, from when it last started (or, never
 * having run, from when it was turned on). An API trigger that has never run
 * is due at once: its first run only takes note of what exists.
 */
export const nextDue = (trigger: WorkflowTrigger, lastStartedAt: number | null, enabledAt: number): number | null => {
  switch (trigger.kind) {
    case "schedule":
      return nextScheduled(trigger.cron, trigger.timezone, lastStartedAt ?? enabledAt);
    case "every":
      return (lastStartedAt ?? enabledAt) + WORKFLOW_EVERY_MS[trigger.every];
    case "record_created":
    case "record_changed":
      return lastStartedAt === null ? enabledAt : lastStartedAt + WORKFLOW_EVERY_MS[trigger.every];
    default:
      return null;
  }
};

export const isDue = (trigger: WorkflowTrigger, lastStartedAt: number | null, enabledAt: number, now: number): boolean => {
  const due = nextDue(trigger, lastStartedAt, enabledAt);
  return due !== null && due <= now;
};
