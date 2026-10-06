/**
 * Who may change what, as the write service asks it.
 *
 * The engine never decides this itself: every review and every commit asks
 * the host first. Dash answers with its roles and grants; another host
 * answers however its own accounts work.
 */

/** Who is asking: enough to keep one person's reviews their own. */
export interface WriteActor {
  readonly userId: string;
  readonly workspaceId: string;
}

/** The change being asked about. */
export type WritePermission = "records.create" | "records.update" | "records.delete" | "records.act";

/** Where it would land: a connection, or one record type on it. */
export interface WriteScope {
  readonly connection?: string | undefined;
  readonly entity?: string | undefined;
}

/** The answer carries a reason, because "you can't" with no reason reads as a bug. */
export type PolicyDecision = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface WritePolicy {
  can(actor: WriteActor, permission: WritePermission, scope?: WriteScope): PolicyDecision | Promise<PolicyDecision>;
}
