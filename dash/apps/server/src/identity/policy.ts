import { ROLE_PERMISSIONS, type Permission, type Principal, type Scope } from "@freebirdai/dash-spec";
import type { MembershipStore } from "./membership.js";

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
/**
 * Each member's role, and the grants they were given on top of it: what a
 * hosted build's workspaces use. A grant scoped to one
 * connection, or one record type on it, allows only there; an unscoped one
 * everywhere. Somebody who is no longer a member may do nothing.
 */
export const rolePolicy = (memberships: MembershipStore): Policy => ({
  can: async (principal, permission, scope = {}) => {
    if (principal.kind === "local-owner") return ALLOWED;
    const member = await memberships.member(principal.workspaceId, principal.userId);
    if (!member) return { ok: false, reason: "You are no longer a member of this workspace." };
    if (ROLE_PERMISSIONS[member.role].includes(permission)) return ALLOWED;
    const granted = member.grants.some(
      (grant) =>
        grant.permission === permission &&
        (grant.scope.connection === undefined || grant.scope.connection === scope.connection) &&
        (grant.scope.entity === undefined || grant.scope.entity === scope.entity),
    );
    return granted ? ALLOWED : { ok: false, reason: `Your role here (${member.role}) does not allow this.` };
  },
});

export const ownerPolicy: Policy = {
  can: (principal) =>
    principal.role === "owner"
      ? ALLOWED
      : { ok: false, reason: "Only the workspace owner can do this here." },
};
