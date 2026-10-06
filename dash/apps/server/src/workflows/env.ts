import type { CommitResult, WriteIntent, WriteReview } from "@freebirdai/connect";
import type { RecordReader, WriteOnBehalfOf, WriteVia } from "@freebirdai/connect/host";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { AgentSpec, Principal } from "@freebirdai/dash-spec";
import type { Policy } from "../identity/policy.js";
import type { CalendarStore, ProposalStore, WorkflowStore } from "./store.js";

/**
 * Everything a workflow run reaches for, in one place, so the runner, a
 * person's "Run now", an agent's tool and the tests all run the same code.
 */

/** The two steps of a reviewed change, as a workflow uses them. */
export interface WorkflowWrites {
  prepare(
    principal: Principal,
    intent: WriteIntent,
    options: { readonly via: WriteVia; readonly onBehalfOf?: WriteOnBehalfOf },
  ): Promise<WriteReview>;
  commit(principal: Principal, pendingId: string, digest: string): Promise<CommitResult>;
  discard(principal: Principal, pendingId: string): void;
}

/** Something that happened, for the server's log and whatever listens. */
export type WorkflowEvent =
  | { readonly type: "workflow.run"; readonly workflow: string; readonly run: string; readonly status: string; readonly matched: number }
  | { readonly type: "workflow.parked"; readonly workflow: string; readonly reason: string }
  | { readonly type: "proposal.created"; readonly proposal: string; readonly kind: string; readonly workflow?: string | undefined; readonly agent?: string | undefined };

export interface WorkflowEnv {
  readonly workspaceId: string;
  readonly store: WorkflowStore;
  readonly proposals: ProposalStore;
  readonly calendar: CalendarStore;
  readonly agents: { get(id: string): Promise<AgentSpec | null> };
  readonly policy: Policy;
  /** The single read, at background priority: a person's open board is never slowed. */
  readonly read: RecordReader;
  readonly writes: WorkflowWrites;
  /** The field that tells a record type's rows apart, where the catalog knows it. */
  readonly rowKeyField?: (connection: string, record: string) => string | undefined;
  readonly connectionTitle?: (connection: string) => string;
  /** The model the `think` step runs on (task `workflow`); null when no AI key is set. */
  readonly llm?: () => LlmAdapter | null;
  /** Wraps a run so its model calls count against the spend cap. */
  readonly withBudget?: <T>(run: () => Promise<T>) => Promise<T>;
  readonly onEvent?: (event: WorkflowEvent) => void;
  readonly now: () => number;
  readonly newId: () => string;
}

/** A workflow is stopped by itself — access lost — until a person turns it back on. */
export class ParkWorkflow extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ParkWorkflow";
  }
}
