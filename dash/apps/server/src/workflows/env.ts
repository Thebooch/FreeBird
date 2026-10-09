import type { CommitResult, WriteIntent, WriteReview } from "@freebirdai/connect";
import type { RecordReader, WriteOnBehalfOf, WriteVia } from "@freebirdai/connect/host";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { ActionModelTask, AgentSpec, Booking, BookingEvent, Contact, Principal, SharedAgentKnowledge } from "@freebirdai/dash-spec";
import type { BookingLinks } from "../bookings/links.js";
import type { BookingService } from "../bookings/service.js";
import type { Policy } from "../identity/policy.js";
import type { CalendarStore, CaseStore, SignalStore, TaskStore, TemplateStore, WorkflowStore } from "./store.js";

/**
 * Everything a workflow reaches for, in one place, so the runner, a person's
 * "Run now", an approval, an agent's tool and the tests all run the same code.
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
  | { readonly type: "workflow.run"; readonly workflow: string; readonly run: string; readonly status: string; readonly cases: number }
  | { readonly type: "workflow.parked"; readonly workflow: string; readonly reason: string }
  | { readonly type: "case.finished"; readonly workflow: string; readonly case: string; readonly status: string }
  | { readonly type: "case.error"; readonly case: string; readonly message: string }
  | { readonly type: "task.waiting"; readonly task: string; readonly workflow?: string | undefined; readonly agent?: string | undefined };

/** Sends Outreach. Comms supplies the real one; until then nothing leaves Dash. */
export interface OutreachSender {
  send(message: {
    readonly channel: "text" | "call" | "email";
    readonly to: string;
    readonly subject?: string | undefined;
    readonly text: string;
    readonly agent: Pick<AgentSpec, "id" | "name">;
    /** At most once: the same key is never sent twice. */
    readonly key: string;
  }): Promise<{ readonly status: "queued" | "sent" | "delivered" | "failed" | "not_sent"; readonly detail?: string; readonly conversation?: string }>;
}

export const notConnectedSender: OutreachSender = {
  send: async () => ({ status: "not_sent", detail: "Texts, calls and email are not connected yet, so nothing was sent." }),
};

export interface WorkflowEnv {
  readonly workspaceId: string;
  readonly store: WorkflowStore;
  readonly cases: CaseStore;
  readonly tasks: TaskStore;
  readonly calendar: CalendarStore;
  readonly templates: TemplateStore;
  /** Things that happened, kept until a waiting case takes them. */
  readonly signals: SignalStore;
  readonly agents: { get(id: string): Promise<AgentSpec | null>; shared?(): Promise<SharedAgentKnowledge> };
  readonly policy: Policy;
  /** The single read, at background priority. */
  readonly read: RecordReader;
  readonly writes: WorkflowWrites;
  readonly outreach?: OutreachSender;
  /**
   * Posts a webhook: the SSRF guard applies. `key` is the step's operation id,
   * sent as `Idempotency-Key` so a receiver that honours it ignores a repeat.
   * Absent: Send to a system is not available.
   */
  readonly post?: (url: string, body: unknown, options?: { readonly key?: string }) => Promise<{ readonly status: number; readonly body: unknown }>;
  /** The field that tells a record type's rows apart, where the catalog knows it. */
  readonly rowKeyField?: (connection: string, record: string) => string | undefined;
  readonly connectionTitle?: (connection: string) => string;
  /** A model for one kind of call; a step may name its own. Null when no AI key is set. */
  readonly llm?: (task: ActionModelTask, model?: string) => LlmAdapter | null;
  /** Wraps a model call so it counts against the spend cap. */
  readonly withBudget?: <T>(run: () => Promise<T>) => Promise<T>;
  /** Where a webhook wait's address starts, e.g. https://dash.example.com. */
  readonly publicOrigin?: string;
  readonly onEvent?: (event: WorkflowEvent) => void;
  /** Bookings, for the Schedule steps, Approve a booking and the booking waits. Absent: those steps cannot run here. */
  readonly bookings?: () => WorkflowBookings | undefined;
  readonly now: () => number;
  readonly newId: () => string;
}

/** What workflow steps do with bookings (`bookings/service.ts`, `bookings/row.ts`). */
export interface WorkflowBookings {
  readonly service: BookingService;
  /** The booking shaped for steps: `when`, `link`, `contact.*`, `type.*`, `host.name`. A link already handed out is passed in rather than minted again. */
  row(booking: Booking, known?: { readonly link?: string }): Promise<Record<string, unknown>>;
  /** Someone turned away, shaped for steps: `contact.*`, `type.*`, `request.*` (their answers), `answersText`, `reason`, `via`. */
  turnedAwayRow(event: BookingEvent): Promise<Record<string, unknown>>;
  /** A time as the contact reads it: "Tue, Oct 13, 9:00 AM CDT". */
  when(at: number | string, contact: string): Promise<string>;
  contact(id: string): Promise<Contact | null>;
  /** Approval links and the team's notices. Absent: members answer in Waiting for you only. */
  readonly links?: BookingLinks;
}

/**
 * A request that did not get an answer, and whether it left: `no` when it
 * never went out (refused by the guard, nobody at the address, no such
 * name), `unknown` when it may have arrived (the connection dropped or timed
 * out after sending began).
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly sent: "no" | "unknown",
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

/** Failures that happen before a request's first byte leaves: no connection, no such name, a certificate refused. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** The system error code on an error or its cause. */
const codeOf = (error: unknown): string | undefined => {
  const own = (error as { code?: unknown } | null)?.code;
  if (typeof own === "string") return own;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === "string" ? cause : undefined;
};

/**
 * Whether a failed request left, from what the error says structurally: its
 * system error code, or the caller's own knowledge that it was refused before
 * sending (the address guard). Anything else may have arrived.
 */
export const deliveryErrorOf = (error: unknown, refusedBeforeSending: (error: unknown) => boolean = () => false): DeliveryError => {
  if (error instanceof DeliveryError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const code = codeOf(error);
  return new DeliveryError(text, refusedBeforeSending(error) || (code !== undefined && NOT_SENT_CODES.has(code)) ? "no" : "unknown");
};

/** A workflow is stopped by itself — access lost — until a person turns it back on. */
export class ParkWorkflow extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ParkWorkflow";
  }
}
