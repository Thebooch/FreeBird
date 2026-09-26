/**
 * Every change made to a connected account, as one record.
 *
 * The event log that keeps these — what was there before, what was sent,
 * what came back, who did it — is not built yet. What is built is the one
 * place every write passes through handing it a complete event, so the log
 * is a matter of storing what already arrives rather than of finding every
 * write and teaching it to report.
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

export interface WriteEventKey {
  readonly id?: string | undefined;
  readonly parents?: Readonly<Record<string, string>> | undefined;
}

export interface WriteEvent {
  readonly id: string;
  /** ISO timestamp. */
  readonly at: string;
  readonly actor: { readonly userId: string; readonly workspaceId: string };
  /** Where the change was asked for. */
  readonly via: "form" | "chat";
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

/** Where write events go. */
export interface WriteJournal {
  record(event: WriteEvent): void | Promise<void>;
}

/** Nowhere, yet. The open-source default until the event log exists. */
export const nullJournal: WriteJournal = { record: () => undefined };

/** Kept in memory, for tests and for anything that wants the last few. */
export class MemoryJournal implements WriteJournal {
  readonly events: WriteEvent[] = [];
  record(event: WriteEvent): void {
    this.events.push(event);
  }
}
