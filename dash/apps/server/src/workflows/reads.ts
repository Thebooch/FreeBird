import { Priority } from "@freebirdai/connect/host";
import { readField, reachCovers, type AgentSpec, type Principal } from "@freebirdai/dash-spec";
import { ParkWorkflow, type WorkflowEnv } from "./env.js";

/**
 * Every read a workflow makes in the background goes through here: the
 * trigger's, a Look up step's, an "Only if still" check, and a wait watching
 * a record. Each asks, at the time of the read, whether the person the
 * workflow runs as may still read that connection and whether the agent's
 * reach still covers it. Access taken away during a long wait stops the
 * workflow at its next read, with the reason, instead of reading on.
 */

/** Who a workflow reads as: the person, and the agent when it acts in one's name. */
export interface Reader {
  readonly actor: Principal | null;
  readonly agent: AgentSpec | null;
}

export const mayRead = async (env: WorkflowEnv, who: Reader, connection: string): Promise<void> => {
  const where = env.connectionTitle?.(connection) ?? connection;
  if (!who.actor) throw new ParkWorkflow("Nobody has turned this workflow on, so it has no one's permission to read with.");
  const may = await env.policy.can(who.actor, "records.read", { connection });
  if (!may.ok) throw new ParkWorkflow(`The person this workflow runs as may no longer read ${where}: ${may.reason}`);
  if (who.agent && !reachCovers(who.agent.reach, "records.read", { connection })) throw new ParkWorkflow(`${who.agent.name} may not read ${where}.`);
};

/**
 * One record, read fresh, as someone who may read it. `record` is null when
 * it was not found; `complete` says whether that means it is not there (every
 * record was reached) or only that it was not reached.
 */
export const readRecordAs = async (
  env: WorkflowEnv,
  who: Reader,
  target: { readonly connection: string; readonly entity: string; readonly id: string },
): Promise<{ readonly record: Record<string, unknown> | null; readonly complete: boolean }> => {
  await mayRead(env, who, target.connection);
  const answer = await env.read(target.connection, { record: target.entity, fresh: 0, waitMs: 30_000 }, Priority.Background);
  const field = env.rowKeyField?.(target.connection, target.entity) ?? "id";
  const found = answer.rows.find((row) => String(readField(row, field) ?? "") === target.id);
  return { record: (found as Record<string, unknown> | undefined) ?? null, complete: answer.complete };
};

/**
 * The agent a case or step names. No id: no agent, and nothing to check. An
 * id that no longer names an agent stops the workflow: acting in the name of
 * an agent that was removed would act with nobody's limits.
 */
export const agentNamed = async (env: WorkflowEnv, id: string | undefined): Promise<AgentSpec | null> => {
  if (!id) return null;
  const agent = await env.agents.get(id);
  if (!agent) throw new ParkWorkflow(`The agent "${id}" it acts for no longer exists.`);
  if (agent.archived) throw new ParkWorkflow(`${agent.name} is archived.`);
  return agent;
};
