import type { AgentSpec } from "@freebirdai/dash-spec";
import { agentOf, ORDERS } from "../workflows/testing.js";

/**
 * The worlds a sandbox can boot: seeded records and agents, by name. A
 * scenario's `world.workspace` adds its own on top.
 *
 * These are small hand-written seeds. Worlds booted from the bench's mock
 * providers and record/replay recordings come later, so a sandbox sees the
 * API errors and partial reads real connections give.
 */

export interface WorldSeed {
  readonly records: readonly Record<string, unknown>[];
  readonly agents: readonly AgentSpec[];
}

const WORLDS: Readonly<Record<string, (seed?: string) => WorldSeed>> = {
  /** Nothing: the scenario brings everything. */
  empty: () => ({ records: [], agents: [] }),
  /** A property manager: three work orders on the `pms` connection, and a front desk agent that reads and updates them. */
  "property-maintenance": () => ({
    records: ORDERS,
    agents: [agentOf({ id: "desk", name: "Front desk", role: "You are the front desk of a property management company." })],
  }),
};

export const WORLD_NAMES = Object.keys(WORLDS);

export const worldSeed = (provider: string, seed?: string): WorldSeed => {
  const make = WORLDS[provider];
  if (!make) throw new Error(`No sandbox world is called "${provider}". Known: ${WORLD_NAMES.join(", ")}.`);
  return make(seed);
};
