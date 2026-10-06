import { agentSchema, type Principal } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { AgentService } from "../agents/service.js";
import { MemoryAgentStore } from "../agents/store.js";
import { ownerPolicy, type Policy } from "../identity/policy.js";
import { agentActions, agentKnowledge, type AgentChatOps } from "./agent-actions.js";

const owner: Principal = { userId: "o", workspaceId: "acme", role: "owner", kind: "member" };
const ctxFor = (principal: Principal | null) => ({ auth: { extra: principal ? { principal } : {} } }) as never;

const build = async (policy: Policy = ownerPolicy) => {
  const service = new AgentService({ store: new MemoryAgentStore(), policy: ownerPolicy, hasConnection: (id) => id === "pms" });
  await service.create(owner, { name: "Scout", color: 2, reach: [{ permission: "records.read", scope: { connection: "pms" } }] });
  const ops: AgentChatOps = {
    roster: await service.list(),
    mayManage: async (principal) => (await policy.can(principal, "agents.manage", {})).ok,
    create: (principal, input) => service.create(principal, input),
    update: (principal, id, input) => service.update(principal, id, input),
    archive: (id) => service.setArchived(id, true),
  };
  const actions = agentActions(ops);
  const action = (id: string) => actions.find((one) => one.id === id)!;
  return { service, ops, action };
};

describe("agent chat actions", () => {
  it("offers three actions, none exposed to an outside agent", async () => {
    const { action } = await build();
    for (const id of ["create_agent", "update_agent", "archive_agent"]) {
      expect(action(id).requiresConfirmation).toBe("preview");
      expect(action(id).mcp).toEqual({ expose: false });
    }
  });

  it("is refused to somebody who may not manage agents, and to nobody signed in", async () => {
    const { action } = await build({ can: () => ({ ok: false, reason: "no" }) });
    const args = { name: "Ghost" } as never;
    expect(await action("create_agent").authorize!(args, ctxFor(owner))).toMatchObject({ ok: false, status: 403 });
    expect(await action("create_agent").authorize!(args, ctxFor(null))).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses an agent id it never listed", async () => {
    const { action } = await build();
    expect(await action("update_agent").authorize!({ agentId: "scout" } as never, ctxFor(owner))).toBe(true);
    expect(await action("update_agent").authorize!({ agentId: "ghost" } as never, ctxFor(owner))).toMatchObject({ ok: false, status: 404 });
    expect(await action("archive_agent").authorize!({ agentId: "ghost" } as never, ctxFor(owner))).toMatchObject({ ok: false, status: 404 });
  });

  it("creates an agent, picking a colour when none is named", async () => {
    const { action, service } = await build();
    const result = (await action("create_agent").handler!(
      { name: "Lease Scout", reach: [{ permission: "records.read", connection: "pms", entity: "property" }] } as never,
      ctxFor(owner),
    )) as { agentId: string; color: number };
    expect(result.agentId).toBe("lease-scout");
    expect(result.color).toBeGreaterThanOrEqual(1);
    expect((await service.get("lease-scout"))?.reach).toEqual([
      { permission: "records.read", scope: { connection: "pms", entity: "property" } },
    ]);
  });

  it("renames an agent and keeps everything it was not asked to change", async () => {
    const { action, service } = await build();
    await action("update_agent").handler!({ agentId: "scout", name: "Lease Scout" } as never, ctxFor(owner));
    const after = agentSchema.parse(await service.get("scout"));
    expect(after).toMatchObject({ name: "Lease Scout", color: 2, reach: [{ permission: "records.read", scope: { connection: "pms" } }] });
  });

  it("says a refused reach in words", async () => {
    const { action } = await build();
    await expect(
      action("create_agent").handler!({ name: "X", reach: [{ permission: "records.read", connection: "ghost" }] } as never, ctxFor(owner)),
    ).rejects.toThrow(/ghost/);
  });

  it("archives an agent", async () => {
    const { action, service } = await build();
    await action("archive_agent").handler!({ agentId: "scout" } as never, ctxFor(owner));
    expect((await service.get("scout"))?.archived).toBe(true);
  });

  it("tells the assistant which agents exist, by id", async () => {
    const { ops } = await build();
    expect(agentKnowledge(ops)[0]?.text).toMatch(/Scout.*id: scout.*colour 2/);
    expect(agentKnowledge({ ...ops, roster: [] })[0]?.text).toContain("none yet");
  });
});
