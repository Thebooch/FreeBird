import { inviteSchema, memberSchema, workspaceSchema, type Invite, type Member, type Workspace } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { MembershipStore } from "./membership.js";
import type { DashDb } from "../platform/db.js";

/**
 * Workspaces, members and invitations: the `MembershipStore`
 * a hosted build's role policy reads. In memory for tests, in Dash's database
 * otherwise. An invitation is kept by the hash of its token, never the token.
 */

export class MemoryMembershipStore implements MembershipStore {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly memberships = new Map<string, Member>();
  private readonly invites = new Map<string, Invite>();

  async putWorkspace(workspace: Workspace): Promise<void> {
    this.workspaces.set(workspace.id, workspaceSchema.parse(workspace));
  }
  async workspace(id: string): Promise<Workspace | null> {
    return this.workspaces.get(id) ?? null;
  }
  async member(workspaceId: string, userId: string): Promise<Member | null> {
    return this.memberships.get(`${workspaceId}\u0000${userId}`) ?? null;
  }
  async members(workspaceId: string): Promise<readonly Member[]> {
    return [...this.memberships.values()].filter((one) => one.workspaceId === workspaceId);
  }
  async putMember(member: Member): Promise<void> {
    this.memberships.set(`${member.workspaceId}\u0000${member.userId}`, memberSchema.parse(member));
  }
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    this.memberships.delete(`${workspaceId}\u0000${userId}`);
  }
  async invite(workspaceId: string, tokenHash: string): Promise<Invite | null> {
    return [...this.invites.values()].find((one) => one.workspaceId === workspaceId && one.tokenHash === tokenHash) ?? null;
  }
  async putInvite(invite: Invite): Promise<void> {
    this.invites.set(invite.id, inviteSchema.parse(invite));
  }
  async revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
    const held = this.invites.get(inviteId);
    if (held?.workspaceId === workspaceId) this.invites.delete(inviteId);
  }
}

const parsed = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

export class DbMembershipStore implements MembershipStore {
  constructor(private readonly db: DashDb) {}

  async putWorkspace(workspace: Workspace): Promise<void> {
    const one = workspaceSchema.parse(workspace);
    await sql`
      INSERT INTO dash_workspaces (id, record) VALUES (${one.id}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async workspace(id: string): Promise<Workspace | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_workspaces WHERE id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? workspaceSchema.parse(parsed(row.record)) : null;
  }
  async member(workspaceId: string, userId: string): Promise<Member | null> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_members WHERE workspace = ${workspaceId} AND user_id = ${userId}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? memberSchema.parse(parsed(row.record)) : null;
  }
  async members(workspaceId: string): Promise<readonly Member[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_members WHERE workspace = ${workspaceId} ORDER BY user_id
    `.execute(this.db.kysely);
    return result.rows.map((row) => memberSchema.parse(parsed(row.record)));
  }
  async putMember(member: Member): Promise<void> {
    const one = memberSchema.parse(member);
    await sql`
      INSERT INTO dash_members (workspace, user_id, record) VALUES (${one.workspaceId}, ${one.userId}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, user_id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await sql`DELETE FROM dash_members WHERE workspace = ${workspaceId} AND user_id = ${userId}`.execute(this.db.kysely);
  }
  async invite(workspaceId: string, tokenHash: string): Promise<Invite | null> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_invites WHERE workspace = ${workspaceId} AND token_hash = ${tokenHash}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? inviteSchema.parse(parsed(row.record)) : null;
  }
  async putInvite(invite: Invite): Promise<void> {
    const one = inviteSchema.parse(invite);
    await sql`
      INSERT INTO dash_invites (id, workspace, token_hash, record) VALUES (${one.id}, ${one.workspaceId}, ${one.tokenHash}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, token_hash = EXCLUDED.token_hash
    `.execute(this.db.kysely);
  }
  async revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
    await sql`DELETE FROM dash_invites WHERE workspace = ${workspaceId} AND id = ${inviteId}`.execute(this.db.kysely);
  }
}
