import { areaKey, areaOf, matchesMailQuery, parseMailQuery, type AgentSpec, type MailboxView, type MailMessage } from "@freebirdai/dash-spec";

/**
 * What the Communications page decides without the server: which areas there
 * are, which mailboxes each person has ticked in each, and the instant filter
 * over what is already on screen while someone types.
 */

export interface AreaGroup {
  /** `team`, or `agent:<id>`. */
  readonly key: string;
  readonly label: string;
  /** For an agent's area: its colour. */
  readonly color?: number;
  readonly mailboxes: readonly MailboxView[];
}

/** Your comms first (always, even empty), then one area per agent with mailboxes of its own, by name. */
export const areaGroups = (mailboxes: readonly MailboxView[], agents: readonly Pick<AgentSpec, "id" | "name" | "color">[]): { readonly team: AreaGroup; readonly agents: readonly AreaGroup[] } => {
  const team = mailboxes.filter((one) => areaOf(one.owner).kind === "team");
  const byAgent = new Map<string, MailboxView[]>();
  for (const one of mailboxes) {
    const area = areaOf(one.owner);
    if (area.kind === "agent") byAgent.set(area.id, [...(byAgent.get(area.id) ?? []), one]);
  }
  const groups = [...byAgent].map(([id, list]): AreaGroup => {
    const agent = agents.find((one) => one.id === id);
    return { key: areaKey({ kind: "agent", id }), label: agent?.name ?? id, ...(agent ? { color: agent.color } : {}), mailboxes: list };
  });
  return { team: { key: "team", label: "Your comms", mailboxes: team }, agents: groups.sort((a, b) => a.label.localeCompare(b.label)) };
};

const STORAGE = "dash.comms.selection";

/** Each person's ticked mailboxes, per area, remembered in this browser. Empty means all of them. */
export const loadSelection = (): Record<string, string[]> => {
  try {
    const raw = window.localStorage.getItem(STORAGE);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
};

export const saveSelection = (selection: Readonly<Record<string, readonly string[]>>): void => {
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(selection));
  } catch {
    /* A browser that keeps nothing still works; it just forgets. */
  }
};

/** The mailboxes ticked in an area: what is remembered and still there, or all of them. */
export const ticked = (group: AreaGroup, remembered: readonly string[] | undefined): string[] => {
  const ids = group.mailboxes.map((one) => one.id);
  const kept = (remembered ?? []).filter((id) => ids.includes(id));
  return kept.length > 0 ? kept : ids;
};

/** Tick or untick one; the last one ticked cannot be unticked (none would mean all). */
export const toggle = (current: readonly string[], id: string): string[] =>
  current.includes(id) ? (current.length > 1 ? current.filter((one) => one !== id) : [...current]) : [...current, id];

/** As someone types: what already shows that answers the query. Enter asks every mailbox. */
export const filterShown = <T extends MailMessage>(messages: readonly T[], text: string): T[] => {
  const query = parseMailQuery(text);
  return messages.filter((one) => matchesMailQuery(one, query));
};

/** "9:41 AM" today, "Tue" this week, "Oct 3" this year, else the date. */
export const when = (iso: string, now = new Date()): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6 && days >= 0) return date.toLocaleDateString(undefined, { weekday: "short" });
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
