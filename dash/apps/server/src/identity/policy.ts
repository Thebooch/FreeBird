import type { Permission, Principal, Scope } from "@freebirdai/dash-spec";

/**
 * Whether one principal may do one thing, somewhere.
 *
 * Asked at every point where a change happens — today, every write to a
 * connected account and every change to what may be written — so that a
 * managed build can answer it differently without finding those places
 * first. The answer carries a reason, because "you can't" with no reason is
 * indistinguishable from a bug.
 */
export type PolicyDecision = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface Policy {
  can(principal: Principal, permission: Permission, scope?: Scope): PolicyDecision | Promise<PolicyDecision>;
}

const ALLOWED: PolicyDecision = Object.freeze({ ok: true as const });

/**
 * The owner may do everything; nobody else may do anything.
 *
 * All the open-source build needs, since the owner is the only principal it
 * ever produces. A managed build replaces this with one that reads each
 * member's role and grants — see `@freebirdai/dash-spec`'s `access.ts`.
 */
export const ownerPolicy: Policy = {
  can: (principal) =>
    principal.role === "owner"
      ? ALLOWED
      : { ok: false, reason: "Only the workspace owner can do this here." },
};
