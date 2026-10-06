import type { WriteIntent } from "@freebirdai/connect";
import { WriteError } from "@freebirdai/connect/host";
import { changePermission, reachCovers, type AgentSpec, type Principal, type Proposal, type WorkflowRunOutput, type WorkflowStepMode } from "@freebirdai/dash-spec";
import { ParkWorkflow, type WorkflowEnv } from "./env.js";

/**
 * A change to a record, from a workflow: proposed for a person (approve), or
 * made in the run (auto).
 *
 * Either way it is the one reviewed path every change takes: `prepare` reads
 * the record fresh and builds the request, `commit` sends it only if the
 * record has not moved since. An auto change is both, inside the run, as the
 * person who turned the workflow on; an approve change is stored as an intent
 * and prepared fresh when somebody opens it.
 *
 * Done in an agent's name, a change must also be within that agent's reach.
 */

export type ChangeKind = "create" | "update" | "action";

export interface ChangeContext {
  readonly env: WorkflowEnv;
  readonly workflow: { readonly id: string; readonly name: string };
  readonly run: string;
  /** Whose permission an auto change uses. */
  readonly actor: Principal | null;
  /** The agent the run is in the name of, when there is one. */
  readonly agent: AgentSpec | null;
  readonly mode: WorkflowStepMode;
  readonly step: string;
  readonly stepKind: string;
  readonly rowKey?: string | undefined;
  readonly reason?: string | undefined;
}

const VERB: Readonly<Record<WriteIntent["kind"], string>> = { create: "Create", update: "Update", delete: "Delete", action: "Run" };

/** One line: "Update work order 7 on Rentvine: vendor". */
export const describeIntent = (intent: WriteIntent, connectionTitle?: (id: string) => string): string => {
  const where = connectionTitle?.(intent.connection) ?? intent.connection;
  const what = intent.kind === "action" ? `${intent.action ?? "an action"} on ${intent.entity}` : intent.entity.replace(/[_-]+/g, " ");
  const which = intent.id ? ` ${intent.id}` : "";
  const fields = Object.keys(intent.values ?? {});
  return `${VERB[intent.kind]} ${what}${which} on ${where}${fields.length > 0 ? `: ${fields.join(", ")}` : ""}`;
};

/** Whether an agent's reach covers a change to this record type. */
export const agentMay = (agent: AgentSpec | null, kind: ChangeKind, connection: string, entity: string): boolean =>
  agent === null || reachCovers(agent.reach, changePermission(kind), { connection, entity });

export const makeChange = async (ctx: ChangeContext, kind: ChangeKind, intent: WriteIntent): Promise<WorkflowRunOutput> => {
  const { env } = ctx;
  const base = { step: ctx.step, kind: ctx.stepKind, ...(ctx.rowKey !== undefined ? { row: ctx.rowKey } : {}) };
  const title = describeIntent(intent, env.connectionTitle);
  const onBehalfOf = ctx.agent ? { kind: "agent" as const, id: ctx.agent.id } : undefined;

  if (!agentMay(ctx.agent, kind, intent.connection, intent.entity)) {
    throw new ParkWorkflow(`${ctx.agent?.name ?? "The agent"} may not ${kind} ${intent.entity} on ${intent.connection}. Widen what it may touch, or change the workflow.`);
  }

  if (ctx.mode === "approve") {
    const proposal: Proposal = {
      id: env.newId(),
      kind: "change",
      ...(ctx.agent ? { agent: ctx.agent.id } : {}),
      workflow: ctx.workflow.id,
      run: ctx.run,
      intent: { ...intent, ...(onBehalfOf ? { onBehalfOf } : {}) } as Record<string, unknown>,
      title,
      reason: ctx.reason ?? `From "${ctx.workflow.name}"${ctx.rowKey !== undefined ? ` for ${ctx.rowKey}` : ""}.`,
      status: "waiting",
      createdAt: new Date(env.now()).toISOString(),
    };
    await env.proposals.put(proposal);
    env.onEvent?.({ type: "proposal.created", proposal: proposal.id, kind: proposal.kind, workflow: ctx.workflow.id, agent: proposal.agent });
    return { ...base, outcome: "proposed", detail: title, proposal: proposal.id };
  }

  if (!ctx.actor) throw new ParkWorkflow("Nobody has turned this workflow on, so its automatic steps have no one's permission to use.");
  let pendingId: string | undefined;
  try {
    const review = await env.writes.prepare(ctx.actor, intent, { via: "workflow", ...(onBehalfOf ? { onBehalfOf } : {}) });
    pendingId = review.pendingId;
    /* The record type as the API names it, now that prepare has found it. */
    if (!agentMay(ctx.agent, kind, intent.connection, review.entity)) {
      env.writes.discard(ctx.actor, review.pendingId);
      throw new ParkWorkflow(`${ctx.agent?.name ?? "The agent"} may not ${kind} ${review.entityName.toLowerCase()} on ${review.connectionTitle}.`);
    }
    await env.writes.commit(ctx.actor, review.pendingId, review.digest);
    return { ...base, outcome: "done", detail: review.summary, journal: review.pendingId };
  } catch (error) {
    if (error instanceof ParkWorkflow) throw error;
    if (error instanceof WriteError) {
      if (error.code === "forbidden") throw new ParkWorkflow(`The person who turned this on may no longer make this change: ${error.message}`);
      if (error.code === "invalid" && /Nothing would change/.test(error.message)) return { ...base, outcome: "skipped", detail: `${title}: already so.` };
      return { ...base, outcome: "failed", detail: `${title}: ${error.message}`, ...(pendingId ? { journal: pendingId } : {}) };
    }
    return { ...base, outcome: "failed", detail: `${title}: ${error instanceof Error ? error.message : String(error)}` };
  }
};
