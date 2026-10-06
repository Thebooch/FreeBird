import type { Principal } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { ownerPolicy, type Policy } from "../identity/policy.js";
import { WorkflowService } from "../workflows/service.js";
import { MemoryWorkflowStore } from "../workflows/store.js";
import { workflowActions, workflowKnowledge, type WorkflowChatOps } from "./workflow-actions.js";

const owner: Principal = { userId: "o", workspaceId: "acme", role: "owner", kind: "member" };
const ctxFor = (principal: Principal | null) => ({ auth: { extra: principal ? { principal } : {} } }) as never;

const build = async (policy: Policy = ownerPolicy, writes: Policy = ownerPolicy) => {
  const service = new WorkflowService({ store: new MemoryWorkflowStore(), policy: writes, agents: { list: async () => [] }, hasConnection: (id) => id === "pms" });
  const ops: WorkflowChatOps = {
    roster: await service.list(),
    mayManage: async (principal) => (await policy.can(principal, "workflows.manage", {})).ok,
    create: (principal, input) => service.create(principal, input),
    update: (principal, id, input) => service.update(principal, id, input),
  };
  const actions = workflowActions(ops);
  return { service, ops, action: (id: string) => actions.find((one) => one.id === id)! };
};

const overdue = {
  name: "New work orders",
  trigger: "record_created",
  connection: "pms",
  record: "work_order",
  steps: [
    { kind: "calendar", title: "Due: {{ unit }}", at: "{{ due_date }}", deadline: true },
    { kind: "propose_change", mode: "auto", when: "cost < 500", entity: "work_order", change: "update", values: [{ field: "vendor", value: "v1" }] },
    { kind: "propose_change", when: "cost >= 500", entity: "work_order", change: "update", values: [{ field: "vendor", value: "v1" }] },
  ],
};

describe("workflow chat actions", () => {
  it("offers two actions, confirmed on a card and not exposed to outside agents", async () => {
    const { action } = await build();
    for (const id of ["create_workflow", "update_workflow"]) {
      expect(action(id).requiresConfirmation).toBe("preview");
      expect(action(id).mcp).toEqual({ expose: false });
    }
    expect(await action("create_workflow").authorize!(overdue as never, ctxFor(null))).toMatchObject({ ok: false, status: 401 });
  });

  it("drafts a workflow from flat fields, with a path of auto and approve, and shows it in words", async () => {
    const { action, service } = await build();
    const card = action("create_workflow").preview!(overdue as never, ctxFor(owner)) as { rows: Array<{ label: string; value: string }> };
    expect(card.rows.map((row) => row.value)).toEqual(
      expect.arrayContaining(["When a new work_order appears on pms", "Change a record (auto), when cost < 500", "Change a record (approve), when cost >= 500"]),
    );
    const made = (await action("create_workflow").handler!(overdue as never, ctxFor(owner))) as { workflowId: string; enabled: boolean };
    expect(made).toMatchObject({ workflowId: "new-work-orders", enabled: false });
    const held = await service.get("new-work-orders");
    expect(held?.steps.map((step) => [step.kind, step.mode])).toEqual([
      ["calendar", "auto"],
      ["propose_change", "auto"],
      ["propose_change", "approve"],
    ]);
    expect(held?.steps[1]).toMatchObject({ recordId: "{{ id }}", values: { vendor: "v1" } });
  });

  it("refuses an automatic change the person may not make, as the Workflows section does", async () => {
    const readOnly: Policy = { can: (_who, permission) => (permission === "records.update" ? { ok: false, reason: "Viewers cannot change records." } : { ok: true }) };
    const { action } = await build(ownerPolicy, readOnly);
    await expect(action("create_workflow").handler!(overdue as never, ctxFor(owner))).rejects.toThrow(/cannot set this change to automatic/);
  });

  it("changes only what is sent", async () => {
    const { action, service } = await build();
    await action("create_workflow").handler!(overdue as never, ctxFor(owner));
    const { action: again } = await (async () => {
      const ops: WorkflowChatOps = {
        roster: await service.list(),
        mayManage: async () => true,
        create: (principal, input) => service.create(principal, input),
        update: (principal, id, input) => service.update(principal, id, input),
      };
      const actions = workflowActions(ops);
      expect(workflowKnowledge(ops)[0]?.text).toContain('"New work orders" (id: new-work-orders, off');
      return { action: (id: string) => actions.find((one) => one.id === id)! };
    })();
    await again("update_workflow").handler!({ workflowId: "new-work-orders", criteria: 'status == "open"', enabled: true } as never, ctxFor(owner));
    expect(await service.get("new-work-orders")).toMatchObject({ enabled: true, criteria: 'status == "open"', trigger: { kind: "record_created", record: "work_order" } });
    expect((await service.get("new-work-orders"))?.steps).toHaveLength(3);
  });
});
