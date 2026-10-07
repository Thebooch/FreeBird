import { randomUUID } from "node:crypto";
import type { WriteReviewView, WriteTarget } from "@freebirdai/connect-spec";
import type { WriteOnBehalfOf, WriteVia } from "./journal.js";

/**
 * A change somebody is looking at, and has not yet said yes to.
 *
 * Everything that will be sent is decided here, before the person sees it —
 * the body, the address, the record as it was — and the digest over it is
 * what their yes is given to. Nothing about the request can move between the
 * review and the send without the digest noticing.
 *
 * Held in memory, for ten minutes, for one person, and spent once: a review
 * cannot be replayed, cannot be confirmed by somebody else, and a second yes
 * to the same review is refused rather than sent twice.
 */

export const PENDING_TTL_MS = 10 * 60_000;

export interface WriteIntent {
  readonly connection: string;
  readonly entity: string;
  readonly kind: "create" | "update" | "delete" | "action";
  /** For an action: which one. */
  readonly action?: string | undefined;
  /** The record's own id, where it has one. */
  readonly id?: string | undefined;
  /** Ids of what the record lives under, by parameter. */
  readonly parents?: Readonly<Record<string, string>> | undefined;
  /** Request-body fields to set, by path. */
  readonly values?: Readonly<Record<string, unknown>> | undefined;
}

/** The review a person approves. Shared with the browser: see `@freebirdai/dash-spec`. */
export type WriteReview = WriteReviewView;

export interface PendingWrite {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId?: string | undefined;
  /** Digest of the intent, so the assistant asking twice gets the same review. */
  readonly intentDigest: string;
  readonly intent: WriteIntent;
  readonly via: WriteVia;
  readonly onBehalfOf?: WriteOnBehalfOf | undefined;
  readonly target: WriteTarget;
  /** Every path value, filled. */
  readonly params: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown> | undefined;
  /** The record as read immediately before the review; `null` when there is none yet. */
  readonly before: unknown;
  /** What the stale check compares: only the values this change reads, plus identity. */
  readonly beforeDigest: string | null;
  /** The mode the body was built for, after an upsert found out which it is. */
  readonly effectiveMode: "create" | "replace" | "merge" | "delete" | "action";
  readonly digest: string;
  readonly review: WriteReview;
  readonly createdAt: number;
  readonly expiresAt: number;
  consumed: boolean;
}

export class PendingWrites {
  private readonly held = new Map<string, PendingWrite>();

  constructor(private readonly now: () => number = Date.now) {}

  newId(): string {
    return randomUUID();
  }

  put(pending: PendingWrite): void {
    this.sweep();
    this.held.set(pending.id, pending);
  }

  /** A live review, or undefined once it has expired. */
  get(id: string): PendingWrite | undefined {
    const pending = this.held.get(id);
    if (!pending) return undefined;
    if (this.now() > pending.expiresAt) {
      this.held.delete(id);
      return undefined;
    }
    return pending;
  }

  /**
   * An unspent, unexpired review of the same change for the same person in
   * the same conversation. What stops the assistant preparing — and reading
   * the record for — the same change on every step of a turn.
   */
  reusable(userId: string, sessionId: string | undefined, intentDigest: string): PendingWrite | undefined {
    this.sweep();
    for (const pending of this.held.values()) {
      if (
        !pending.consumed &&
        pending.userId === userId &&
        pending.sessionId === sessionId &&
        pending.intentDigest === intentDigest
      ) {
        return pending;
      }
    }
    return undefined;
  }

  discard(id: string): void {
    this.held.delete(id);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, pending] of this.held) if (now > pending.expiresAt) this.held.delete(id);
  }
}
