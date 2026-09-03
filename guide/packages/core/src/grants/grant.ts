import { normalizeDeclaration, type Capability, type Declaration } from "./declaration.js";
import { addedCapabilities, widens } from "./widen.js";

/**
 * An approval, bound to the thing that was approved.
 *
 * The failure this prevents: something is approved once, edited afterwards,
 * and keeps running on the old decision. A grant therefore records not just
 * *that* approval happened but *what* it covered — the content digest and the
 * declared reach — and any later run has to match both.
 *
 * `evaluateGrant` is pure and does no I/O. Storage differs per product (Dash
 * writes files, Guide uses the DbAdapter), and none of that belongs in the
 * rule itself.
 */

export interface Grant {
  /** What was approved: a spec id, a widget name, an action ref. */
  readonly subject: string;
  /** Digest of the approved content at the moment of approval. */
  readonly digest: string;
  /** Reach the approver saw and accepted. Always normalized. */
  readonly declaration: Declaration;
  /** ISO timestamp. */
  readonly grantedAt: string;
  /** Whoever approved it, when the host tracks that. */
  readonly grantedBy?: string;
}

export type GrantVerdict =
  /** Digest and declaration both still hold. */
  | "valid"
  /** Content changed since approval — a new decision is required. */
  | "digest-changed"
  /** Content is unchanged but the declaration reaches further than approved. */
  | "widened"
  /** Nothing has ever been approved for this subject. */
  | "absent";

export interface EvaluateGrantInput {
  /** The stored grant, if there is one. */
  readonly existing: Grant | null | undefined;
  /** Digest of the content about to run. */
  readonly digest: string;
  /** Reach the content is asking for now. Normalized internally. */
  readonly declaration: Declaration;
}

export interface GrantEvaluation {
  readonly verdict: GrantVerdict;
  /** Populated only for `"widened"`: what the approver has not seen. */
  readonly added: Capability[];
}

/**
 * Decide whether a stored grant still authorizes this run.
 *
 * Digest is checked before declaration, and that order is the point: changed
 * content requires a fresh decision *even when the declaration shrank*. A spec
 * that quietly starts reading a different field of the same endpoint has not
 * widened its reach by any set comparison, and is still not the thing anyone
 * approved.
 */
export const evaluateGrant = (input: EvaluateGrantInput): GrantEvaluation => {
  const { existing, digest, declaration } = input;
  if (!existing) return { verdict: "absent", added: [] };
  if (existing.digest !== digest) return { verdict: "digest-changed", added: [] };

  const requested = normalizeDeclaration(declaration);
  if (widens(existing.declaration, requested)) {
    return { verdict: "widened", added: addedCapabilities(existing.declaration, requested) };
  }
  return { verdict: "valid", added: [] };
};

/** Convenience for the common `verdict === "valid"` check. */
export const isGranted = (input: EvaluateGrantInput): boolean =>
  evaluateGrant(input).verdict === "valid";

/** Build a grant record from what was just approved. */
export const createGrant = (input: {
  subject: string;
  digest: string;
  declaration: Declaration;
  grantedBy?: string;
  now?: Date;
}): Grant => ({
  subject: input.subject,
  digest: input.digest,
  declaration: normalizeDeclaration(input.declaration),
  grantedAt: (input.now ?? new Date()).toISOString(),
  ...(input.grantedBy === undefined ? {} : { grantedBy: input.grantedBy }),
});
