import type { Pool } from "@freebirdai/dash-spec";
import type { HostOption, Slot } from "./slots.js";

/**
 * Which host takes a slot several are free for.
 *
 * The slot's own terms come first: when it was offered as bookable without
 * approval, only hosts who can take it that way are considered, so what the
 * page said is what happens. Then, for a pool: a returning contact's last
 * host when `sticky`; the host the person picked; or the pool's rule — take
 * turns after whoever had the last one, the least busy in the window, or the
 * best priority. Ties go to the pool's own order.
 */

export interface AssignContext {
  readonly pool?: Pool;
  /** The contact's last host. */
  readonly preferred?: string;
  /** The host the person booking chose, for a pool where they pick. */
  readonly picked?: string;
  /** Bookings each host has in the pool's window, for "least busy". */
  readonly load?: ReadonlyMap<string, number>;
}

export const assignHost = (slot: Slot, context: AssignContext = {}): HostOption | null => {
  const fitting = slot.options.filter((option) => option.approval === slot.approval);
  const options = fitting.length > 0 ? fitting : slot.options;
  if (options.length === 0) return null;
  const byHost = new Map(options.map((option) => [option.host, option]));

  if (context.picked) return byHost.get(context.picked) ?? null;
  const pool = context.pool;
  if (!pool) return options[0]!;
  if (pool.sticky && context.preferred && byHost.has(context.preferred)) return byHost.get(context.preferred)!;

  const order = pool.members.filter((one) => one.active).map((one) => one.member);
  const rank = (host: string) => {
    const index = order.indexOf(host);
    return index === -1 ? order.length : index;
  };
  const free = [...byHost.keys()].sort((a, b) => rank(a) - rank(b));

  switch (pool.assign) {
    case "least_busy": {
      const load = (host: string) => context.load?.get(host) ?? 0;
      return byHost.get([...free].sort((a, b) => load(a) - load(b) || rank(a) - rank(b))[0]!)!;
    }
    case "priority": {
      const priority = (host: string) => pool.members.find((one) => one.member === host)?.priority ?? Number.MAX_SAFE_INTEGER;
      return byHost.get([...free].sort((a, b) => priority(a) - priority(b) || rank(a) - rank(b))[0]!)!;
    }
    default: {
      /* Take turns: the first free host after whoever had the last one, round the pool's order. */
      const after = pool.cursor ? rank(pool.cursor) : -1;
      const next = free.find((host) => rank(host) > after) ?? free[0]!;
      return byHost.get(next)!;
    }
  }
};
