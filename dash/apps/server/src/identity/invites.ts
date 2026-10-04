import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Invite, Member, Role } from "@freebirdai/dash-spec";
import type { MembershipStore } from "./membership.js";

/**
 * The lead user's invitations: a token handed to the person
 * invited once, and only its hash kept, so a leaked store cannot be used to
 * join. Accepting one is the hosted build's front door — after the identity
 * provider has said who the person is — through `acceptInvite`.
 */

export const tokenHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export const createInvite = async (
  store: MembershipStore,
  input: { readonly workspaceId: string; readonly email: string; readonly role: Role; readonly invitedBy: string; readonly now: number; readonly days?: number },
): Promise<{ readonly invite: Invite; readonly token: string }> => {
  /* The owner is who made the workspace; nobody is invited into that. */
  if (input.role === "owner") throw new Error("Nobody is invited as the owner.");
  const token = randomBytes(32).toString("base64url");
  const invite: Invite = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    email: input.email,
    role: input.role,
    grants: [],
    invitedBy: input.invitedBy,
    expiresAt: new Date(input.now + (input.days ?? 7) * 86_400_000).toISOString(),
    tokenHash: tokenHash(token),
  };
  await store.putInvite(invite);
  return { invite, token };
};

/** A signed-in person accepting an invitation: they become a member, and the invitation is used up. */
export const acceptInvite = async (
  store: MembershipStore,
  input: { readonly workspaceId: string; readonly token: string; readonly userId: string; readonly email: string; readonly now: number },
): Promise<Member | { readonly error: string }> => {
  const invite = await store.invite(input.workspaceId, tokenHash(input.token));
  if (!invite) return { error: "That invitation is not one this workspace sent, or it was already used." };
  if (Date.parse(invite.expiresAt) < input.now) return { error: "That invitation has expired. Ask for a new one." };
  if (invite.email.toLowerCase() !== input.email.toLowerCase())
    return { error: "That invitation was sent to another address." };
  const member: Member = {
    workspaceId: invite.workspaceId,
    userId: input.userId,
    email: input.email,
    role: invite.role,
    grants: invite.grants,
    invitedBy: invite.invitedBy,
    joinedAt: new Date(input.now).toISOString(),
  };
  await store.putMember(member);
  await store.revokeInvite(invite.workspaceId, invite.id);
  return member;
};
