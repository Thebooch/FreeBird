import { WORKFLOW_STEP_INFO } from "@freebirdai/dash-spec";
import type { AgentOverview } from "../../api";

/**
 * The Overview's three filters — agent, task, workflow — applied the same
 * way to both lists. Empty means any.
 */

export interface OverviewFilter {
  readonly agent: string;
  readonly task: string;
  readonly workflow: string;
}

export const NO_FILTER: OverviewFilter = { agent: "", task: "", workflow: "" };

type Active = AgentOverview["active"][number];
type Completed = AgentOverview["completed"][number];

export const keepActive = (item: Active, filter: OverviewFilter): boolean =>
  (!filter.agent || item.agents.includes(filter.agent)) &&
  (!filter.task || item.tasks.includes(filter.task) || (filter.task === "approval" && item.waiting > 0)) &&
  (!filter.workflow || item.workflow === filter.workflow);

export const keepCompleted = (item: Completed, filter: OverviewFilter): boolean =>
  (!filter.agent || item.agent === filter.agent) &&
  (!filter.task || item.task === filter.task) &&
  (!filter.workflow || item.workflow === filter.workflow);

/** A task in words: a step's label, or "Approval". */
export const taskLabel = (task: string): string =>
  task === "approval" ? "Approval" : (WORKFLOW_STEP_INFO[task as keyof typeof WORKFLOW_STEP_INFO]?.label ?? task);

/** The tasks the lists hold, for the filter's choices. */
export const tasksIn = (overview: AgentOverview): string[] =>
  [...new Set([...overview.active.flatMap((one) => one.tasks), ...overview.completed.map((one) => one.task)])].sort((a, b) =>
    taskLabel(a).localeCompare(taskLabel(b)),
  );

/** Completed tasks by day, newest first: "Today", "Yesterday", or the date. */
export const byDay = (items: readonly Completed[], now: Date = new Date()): Array<{ day: string; items: Completed[] }> => {
  const key = (at: Date) => `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
  const today = key(now);
  const yesterday = key(new Date(now.getTime() - 86_400_000));
  const groups = new Map<string, { day: string; items: Completed[] }>();
  for (const item of items) {
    const at = new Date(item.at);
    const k = key(at);
    const day = k === today ? "Today" : k === yesterday ? "Yesterday" : at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const group = groups.get(k) ?? { day, items: [] };
    group.items.push(item);
    groups.set(k, group);
  }
  return [...groups.values()];
};
