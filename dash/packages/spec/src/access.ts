import { z } from "zod";
import { idSchema } from "@freebirdai/connect-spec";

/**
 * Who is asking, and what they may do — the vocabulary, before the system.
 *
 * The open-source build has one person in it: whoever runs the server owns
 * everything on it, and there is nothing to decide. A managed build will have
 * a workspace, a lead user who invites people into it, and a say over what
 * each of them can do. None of that is built yet. What is built is the shape
 * every request already carries — a principal — and the one question every
 * change already asks — may this principal do this, here? — so that when the
 * managed build arrives it answers that question differently instead of
 * finding the places it should have been asked.
 *
 * Kept in the spec package so the server, the browser and a managed service
 * spell these the same way.
 */

/**
 * `owner` is the lead user: the person who made the workspace, who invites
 * everybody else and decides what they may do. The open-source build only
 * ever produces an owner.
 */
export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/**
 * What a principal may be allowed to do.
 *
 * `records.*` are changes to a connected account — the API's own data, which
 * is the part that matters most because it is not ours to lose. The rest are
 * changes to this product: boards, connections, who is in the workspace and
 * the agents it has.
 */
export const PERMISSIONS = [
  "records.read",
  "records.create",
  "records.update",
  "records.delete",
  "records.act",
  "boards.edit",
  "connections.manage",
  "members.manage",
  "agents.manage",
] as const;
export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

/**
 * What each role may do before any grant: the owner and an admin everything,
 * an editor boards and records, a viewer only reading records. A member's
 * grants add to this, each where its scope says.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  editor: ["records.read", "records.create", "records.update", "records.delete", "records.act", "boards.edit"],
  viewer: ["records.read"],
};

/**
 * Where a permission applies. Empty is everywhere; a connection narrows it to
 * one account, and a record type within it narrows it further — "may edit
 * properties on this account" and nothing else.
 */
export const scopeSchema = z.object({
  connection: idSchema.optional(),
  entity: idSchema.optional(),
});
export type Scope = z.infer<typeof scopeSchema>;

/**
 * A scope spelled as a capability string, the way approvals already spell
 * reach (`connection:<id>`, `op:<connection>/<op>` in `@freebirdai/core`'s
 * grants), so a permission and an approval can be compared as sets.
 */
export const scopeCapability = (permission: Permission, scope: Scope = {}): string => {
  if (scope.connection && scope.entity) return `${permission}:${scope.connection}/${scope.entity}`;
  if (scope.connection) return `${permission}:${scope.connection}`;
  return permission;
};

/** The person behind one request. */
export const principalSchema = z.object({
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  role: roleSchema,
  /**
   * `local-owner` is the open-source build's only principal: nobody signed in,
   * because whoever can reach the server already controls it. `member` is a
   * signed-in person in a managed workspace.
   */
  kind: z.enum(["local-owner", "member"]),
});
export type Principal = z.infer<typeof principalSchema>;

/* ── the managed build's shapes, defined now so the seams have a target ── */

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  /** The lead user. */
  ownerId: z.string().min(1),
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** One permission, somewhere. A member's grants refine what their role allows. */
export const scopedPermissionSchema = z.object({
  permission: permissionSchema,
  scope: scopeSchema.default({}),
});

export const memberSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  email: z.string().email(),
  role: roleSchema,
  grants: z.array(scopedPermissionSchema).default([]),
  invitedBy: z.string().optional(),
  joinedAt: z.string(),
});
export type Member = z.infer<typeof memberSchema>;

/**
 * An invitation the lead user sent. The token itself is never stored — only
 * its hash, so a leaked store cannot be used to join a workspace.
 */
export const inviteSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  email: z.string().email(),
  role: roleSchema,
  grants: z.array(scopedPermissionSchema).default([]),
  invitedBy: z.string().min(1),
  expiresAt: z.string(),
  tokenHash: z.string().min(1),
});
export type Invite = z.infer<typeof inviteSchema>;
