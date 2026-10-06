import type { WriteIntent, WriteReview } from "@freebirdai/connect";
import { WriteError } from "@freebirdai/connect/host";
import type { Principal, Proposal, ProposalStatus, WorkflowRun } from "@freebirdai/dash-spec";
import { agentMay } from "./changes.js";
import { startWorkflow, type Starter } from "./start.js";

/**
 * What waits for a person: "Waiting for you".
 *
 * A proposal holds an intent, never a review. When somebody opens one, the
 * change is prepared fresh, as that person — their permission, and the
 * agent's reach when it is in an agent's name — so what they approve is the
 * record as it is now. A record that has moved on so far that the change no
 * longer applies is marked stale and offered for dismissal. Nothing is ever
 * sent without a person's yes to the review in front of them.
 */

export class ProposalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: { readonly review?: WriteReview; readonly proposal?: Proposal } = {},
  ) {
    super(message);
    this.name = "ProposalError";
  }
}

const isChange = (proposal: Proposal): boolean => proposal.kind === "change";

const intentOf = (proposal: Proposal): WriteIntent => {
  const { onBehalfOf: _who, ...intent } = proposal.intent as unknown as WriteIntent & { onBehalfOf?: unknown };
  return intent;
};

const changeKind = (intent: WriteIntent): "create" | "update" | "action" =>
  intent.kind === "create" ? "create" : intent.kind === "update" ? "update" : "action";

export class ProposalService {
  constructor(private readonly starter: Starter) {}

  private get env() {
    return this.starter.env;
  }

  list(options: { status?: ProposalStatus; workflow?: string; limit?: number } = {}): Promise<Proposal[]> {
    return this.env.proposals.list(options);
  }

  private async held(id: string): Promise<Proposal> {
    const proposal = await this.env.proposals.get(id);
    if (!proposal) throw new ProposalError(`There is nothing waiting called "${id}".`, 404);
    return proposal;
  }

  private async decide(proposal: Proposal, status: ProposalStatus, principal: Principal, extra: Partial<Proposal> = {}): Promise<Proposal> {
    const next: Proposal = { ...proposal, status, decidedAt: new Date(this.env.now()).toISOString(), decidedBy: principal.userId, ...extra };
    await this.env.proposals.put(next);
    return next;
  }

  private async agentOf(proposal: Proposal) {
    return proposal.agent ? await this.env.agents.get(proposal.agent) : null;
  }

  /**
   * Open one: for a change, its review, prepared now, as this person. A change
   * that no longer applies comes back stale, with why.
   */
  async review(principal: Principal, id: string): Promise<{ readonly proposal: Proposal; readonly review?: WriteReview }> {
    const proposal = await this.held(id);
    if (proposal.status !== "waiting" || !isChange(proposal)) return { proposal };
    const intent = intentOf(proposal);
    const agent = await this.agentOf(proposal);
    if (proposal.agent && !agentMay(agent, changeKind(intent), intent.connection, intent.entity)) {
      throw new ProposalError(`${agent?.name ?? proposal.agent} may no longer make this change. Dismiss it, or widen what the agent may touch.`, 403);
    }
    try {
      const review = await this.env.writes.prepare(principal, intent, {
        via: "workflow",
        ...(proposal.agent ? { onBehalfOf: { kind: "agent" as const, id: proposal.agent } } : {}),
      });
      if (proposal.agent && !agentMay(agent, changeKind(intent), intent.connection, review.entity)) {
        this.env.writes.discard(principal, review.pendingId);
        throw new ProposalError(`${agent?.name ?? proposal.agent} may not change ${review.entityName.toLowerCase()} records.`, 403);
      }
      return { proposal, review };
    } catch (error) {
      if (error instanceof WriteError && (error.code === "not-found" || (error.code === "invalid" && /Nothing would change/.test(error.message)))) {
        const stale: Proposal = { ...proposal, status: "stale", error: error.message };
        await this.env.proposals.put(stale);
        return { proposal: stale };
      }
      if (error instanceof WriteError) throw new ProposalError(error.message, error.status);
      throw error;
    }
  }

  /**
   * Say yes. For a change, to the review this person opened (its pending id
   * and digest); if the record moved since, the fresh review comes back and
   * the proposal keeps waiting. For a request to start a workflow, the run
   * starts now, as this person.
   */
  async apply(
    principal: Principal,
    id: string,
    approval: { readonly pendingId?: string; readonly digest?: string } = {},
  ): Promise<{ readonly proposal: Proposal; readonly run?: WorkflowRun }> {
    const proposal = await this.held(id);
    if (proposal.status !== "waiting") throw new ProposalError(`This has already been ${proposal.status}.`, 409, { proposal });

    if (proposal.kind === "workflow_start") {
      const workflowId = String(proposal.intent["workflow"] ?? proposal.workflow ?? "");
      const workflow = await this.env.store.get(workflowId);
      if (!workflow) {
        return { proposal: await this.decide(proposal, "failed", principal, { error: "The workflow is gone." }) };
      }
      const inputs = (proposal.intent["inputs"] ?? {}) as Record<string, unknown>;
      const { run } = await startWorkflow(
        this.starter,
        workflow,
        { kind: "proposal", userId: principal.userId, ...(proposal.agent ? { agentId: proposal.agent } : {}), ...(proposal.conversation ? { conversation: proposal.conversation } : {}) },
        { inputs, actor: principal },
      );
      const status = run.status === "failed" || run.status === "parked" ? "failed" : "applied";
      return { proposal: await this.decide(proposal, status, principal, { startedRun: run.id, ...(run.error ? { error: run.error } : {}) }), run };
    }

    if (!isChange(proposal)) throw new ProposalError(`"${proposal.kind}" requests are applied where they came from.`, 409);
    if (!approval.pendingId || !approval.digest) throw new ProposalError("Open the change and approve the review first.", 400);
    try {
      const result = await this.env.writes.commit(principal, approval.pendingId, approval.digest);
      return { proposal: await this.decide(proposal, "applied", principal, { journalId: approval.pendingId, error: undefined, title: proposal.title || result.title }) };
    } catch (error) {
      if (error instanceof WriteError) {
        if (error.code === "stale") throw new ProposalError(error.message, 409, { ...(error.extra.review ? { review: error.extra.review } : {}), proposal });
        if (error.code === "upstream" && error.extra.outcome !== "not-sent") {
          return { proposal: await this.decide(proposal, "failed", principal, { error: error.message, journalId: approval.pendingId }) };
        }
        throw new ProposalError(error.message, error.status);
      }
      throw error;
    }
  }

  async dismiss(principal: Principal, id: string): Promise<Proposal> {
    const proposal = await this.held(id);
    if (proposal.status !== "waiting" && proposal.status !== "stale") throw new ProposalError(`This has already been ${proposal.status}.`, 409, { proposal });
    return this.decide(proposal, "dismissed", principal);
  }
}
