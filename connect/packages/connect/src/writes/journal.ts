/**
 * Every change made to a connected account, as one record.
 *
 * Every write passes through one place that hands it a complete event: what
 * was there before, what was sent, what came back, who did it. The open-source
 * build keeps them in Dash's own database (`DbWriteJournal`); a hosted build
 * keeps them wherever it keeps its audit trail.
 *
 * `before` and `sent` are what a reversal needs. `reversal` says which step
 * would undo this one, as far as the API allows it: a hint for whoever
 * reverses a change later, never something run on its own.
 */

export type WriteEventStatus =
  /** The API accepted it. */
  | "succeeded"
  /** The API refused it, or it could not be sent. Nothing changed. */
  | "failed"
  /** Stopped here before anything was sent: policy, access, or a stale review. */
  | "refused"
  /** Sent, and then the answer was lost. It may or may not have happened. */
  | "unknown";

export type WriteReversal =
  /** Put these values back. */
  | { readonly kind: "update"; readonly values: Readonly<Record<string, unknown>> }
  /** Remove the record this made. */
  | { readonly kind: "delete"; readonly key: WriteEventKey }
  /** Make it again from what it was. A new record, with a new id. */
  | { readonly kind: "create"; readonly values: Readonly<Record<string, unknown>> }
  /** Run the step that undoes this one. */
  | { readonly kind: "action"; readonly action: string };

/** Where a change was asked for. */
export type WriteVia = "form" | "chat" | "workflow" | "agent";

/** Who a change was made in the name of, beside the person who is its actor. */
export interface WriteOnBehalfOf {
  readonly kind: "agent";
  readonly id: string;
}

export interface WriteEventKey {
  readonly id?: string | undefined;
  readonly parents?: Readonly<Record<string, string>> | undefined;
}

export interface WriteEvent {
  readonly id: string;
  /** ISO timestamp. */
  readonly at: string;
  readonly actor: { readonly userId: string; readonly workspaceId: string };
  /**
   * Where the change was asked for: a form, the chat, a workflow (a step set
   * to run on its own, or a proposal a person applied), or an agent's tool.
   */
  readonly via: WriteVia;
  /** The agent the change was made in the name of, where there was one. The actor is still the person. */
  readonly onBehalfOf?: WriteOnBehalfOf | undefined;
  readonly connection: string;
  readonly entity: string;
  readonly key?: WriteEventKey | undefined;
  readonly kind: "create" | "update" | "delete" | "action";
  readonly action?: string | undefined;
  readonly opId: string;
  readonly method: string;
  /** The path as sent, parameters filled. Never the query string, which can carry a key. */
  readonly path: string;
  /** The record as it was read immediately before, where there was one. */
  readonly before?: unknown;
  /** The body sent. */
  readonly sent?: unknown;
  /** What the API answered with, where it answered with the record. */
  readonly after?: unknown;
  /** Labels of the fields that changed. */
  readonly changed: readonly string[];
  readonly status: WriteEventStatus;
  readonly upstreamStatus?: number | undefined;
  readonly error?: string | undefined;
  readonly reversal?: WriteReversal | undefined;
}

/**
 * A read sent with POST whose safety rests on a reading of the documentation
 * rather than on the protocol — a search, named like one. It should change
 * nothing; if it ever did, this is where somebody finds out when, and how
 * often it was sent.
 */
export interface ReadEvent {
  readonly id: string;
  /** ISO timestamp. */
  readonly at: string;
  readonly connection: string;
  readonly opId: string;
  readonly method: "POST";
  /** The path as sent. Never the query string, which can carry a key. */
  readonly path: string;
  /** Why it is believed to read: the op's `readSafety`. */
  readonly basis: string;
  /** Who sent it: a board somebody opened, or the connection's check. */
  readonly via: "board" | "check";
  readonly status: "succeeded" | "failed";
  readonly upstreamStatus?: number | undefined;
  readonly pages?: number | undefined;
}

/** Where write events go — and reads that might not be reads. */
export interface WriteJournal {
  record(event: WriteEvent): void | Promise<void>;
  recordRead?(event: ReadEvent): void | Promise<void>;
}

/** Nowhere: what a test gets. The real entry point keeps them in Dash's database. */
export const nullJournal: WriteJournal = { record: () => undefined };

/** Kept in memory, for tests and for anything that wants the last few. */
export class MemoryJournal implements WriteJournal {
  readonly events: WriteEvent[] = [];
  readonly reads: ReadEvent[] = [];
  record(event: WriteEvent): void {
    this.events.push(event);
  }
  recordRead(event: ReadEvent): void {
    this.reads.push(event);
  }
}
