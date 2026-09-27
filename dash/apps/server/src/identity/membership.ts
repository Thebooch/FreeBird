import type { Invite, Member, Workspace } from "@freebirdai/dash-spec";

/**
 * Where a managed build keeps its workspaces, members and invitations.
 *
 * An interface and nothing more. The open-source build has one owner and no
 * members, so it has nothing to store and no implementation of this. It is
 * written down now so the managed build's lead-user flow — make a workspace,
 * invite people, decide what each may do — has a single named place to land,
 * and so the policy that reads it has a shape to be written against.
 *
 * What an invitation stores is a hash of its token, never the token.
 */
export interface MembershipStore {
  workspace(id: string): Promise<Workspace | null>;
  member(workspaceId: string, userId: string): Promise<Member | null>;
  members(workspaceId: string): Promise<readonly Member[]>;
  putMember(member: Member): Promise<void>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
  invite(workspaceId: string, tokenHash: string): Promise<Invite | null>;
  putInvite(invite: Invite): Promise<void>;
  revokeInvite(workspaceId: string, inviteId: string): Promise<void>;
}
