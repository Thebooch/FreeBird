import { agentSchema, workflowSchema, type Principal } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { ownerPolicy, type Policy } from "../identity/policy.js";
import { explainDraft } from "../workflows/draft.js";
import { WorkflowService } from "../workflows/service.js";
import { MemoryTemplateStore, MemoryWorkflowStore } from "../workflows/store.js";
import { TemplateService } from "../workflows/templates.js";
import { BOOKING_RECIPES } from "../workflows/recipes.js";
import { CHAT_TRIAL_CASES, workflowActions, workflowKnowledge, type WorkflowChatOps } from "./workflow-actions.js";

const owner: Principal = { userId: "o", workspaceId: "acme", role: "owner", kind: "member" };
const ctxFor = (principal: Principal | null) => ({ auth: { extra: principal ? { principal } : {} } }) as never;
const at = "2026-10-06T00:00:00.000Z";
const agent = agentSchema.parse({ id: "maint", name: "Maintenance agent", color: 2, createdAt: at, updatedAt: at });

const build = async (policy: Policy = ownerPolicy) => {
  const store = new MemoryWorkflowStore();
  const service = new WorkflowService({ store, policy, agents: { list: async () => [agent] }, hasConnection: (id) => id === "pms" });
  const templates = new TemplateService({ templates: new MemoryTemplateStore(), workflows: store, newId: () => "x" });
  const opsFor = async (): Promise<WorkflowChatOps> => ({
    roster: await service.list(),
    templates: await templates.list(),
    mayManage: async (principal) => (await policy.can(principal, "workflows.manage", {})).ok,
    explain: (principal, workflow) => explainDraft(service, principal, workflow, [agent]),
    create: (principal, input) => service.create(principal, input),
    update: (principal, id, input) => service.update(principal, id, input),
    saveTemplate: (input) => templates.saveFrom(input),
    fromTemplate: async (principal, id, values, name) => service.create(principal, (await templates.workflowFrom(id, values, name)).input),
  });
  const action = async (id: string) => workflowActions(await opsFor()).find((one) => one.id === id)!;
  return { service, store, templates, action, opsFor };
};

const intake = {
  name: "New work orders",
  trigger: "record_created",
  connection: "pms",
  record: "work_order",
  steps: [{ id: "text", action: "outreach.text", settings: [{ key: "agentId", value: "maint" }, { key: "purpose", value: "Tell them it was received" }] }],
};

const complete = {
  ...intake,
  steps: [
    { id: "text", action: "outreach.text", settings: [{ key: "agentId", value: "maint" }, { key: "to", value: "{{ tenant_phone }}" }, { key: "purpose", value: "Tell them it was received" }] },
    { id: "wait", action: "wait.for", settings: [{ key: "event", value: "reply" }, { key: "step", value: "text" }, { key: "timeout", value: "2d" }] },
    { id: "again", action: "outreach.text", settings: [{ key: "agentId", value: "maint" }, { key: "to", value: "{{ tenant_phone }}" }, { key: "purpose", value: "Follow up" }] },
  ],
  arrows: [
    { from: "trigger", to: "text" },
    { from: "text", to: "wait" },
    { from: "wait", outcome: "timed_out", to: "again" },
  ],
};

describe("workflow chat actions", () => {
  it("drafts without saving, confirms the rest on a card, and keeps them from outside agents", async () => {
    const { action, store } = await build();
    expect((await action("draft_workflow")).requiresConfirmation).toBe("none");
    for (const id of ["create_workflow", "update_workflow", "save_workflow_template", "use_workflow_template"]) {
      expect((await action(id)).requiresConfirmation).toBe("preview");
      expect((await action(id)).mcp).toEqual({ expose: false });
    }
    await (await action("draft_workflow")).handler!(intake as never, ctxFor(owner));
    expect(await store.list()).toHaveLength(0);
    expect(await (await action("create_workflow")).authorize!(intake as never, ctxFor(null))).toMatchObject({ ok: false, status: 401 });
  });

  it("says what it picked, what is missing and what it suggests, three questions at most", async () => {
    const { action } = await build();
    const draft = (await (await action("draft_workflow")).handler!(intake as never, ctxFor(owner))) as { sentence: string; steps: Array<{ picked: string; mode: string }>; questions: Array<{ kind: string; question: string; default?: string }> };
    expect(draft.sentence).toBe("When a new work_order appears on pms, Maintenance agent texts them.");
    expect(draft.steps).toEqual([expect.objectContaining({ picked: "Outreach · Text", mode: "Approve" })]);
    expect(draft.questions).toEqual([
      expect.objectContaining({ kind: "missing", question: "Who should it reach? (a field on the record, or an address)" }),
      expect.objectContaining({ kind: "suggestion", question: expect.stringMatching(/follow-up/), default: "Yes, after 2 days" }),
    ]);
  });

  it("saves a complete workflow on, in trial, and one still missing something off", async () => {
    const { action, service } = await build();
    const made = (await (await action("create_workflow")).handler!(complete as never, ctxFor(owner))) as { workflowId: string; enabled: boolean; trial: number; sentence: string };
    expect(made).toMatchObject({ enabled: true, trial: CHAT_TRIAL_CASES });
    const held = await service.get(made.workflowId);
    expect(held?.edges.map((edge) => `${edge.from}:${edge.outcome}:${edge.to}`)).toEqual(["trigger:next:text", "text:next:wait", "wait:timed_out:again"]);
    const partial = (await (await action("create_workflow")).handler!({ ...intake, name: "Partial" } as never, ctxFor(owner))) as { enabled: boolean; stillMissing: string[] };
    expect(partial).toMatchObject({ enabled: false, stillMissing: ["Who should it reach? (a field on the record, or an address)"] });
  });

  it("refuses an automatic change the person may not make, as the builder does", async () => {
    const readOnly: Policy = { can: (_who, permission) => (permission === "records.update" ? { ok: false, reason: "Viewers cannot change records." } : { ok: true }) };
    const { action } = await build(readOnly);
    const args = { ...intake, steps: [{ id: "fix", action: "update.record", mode: "auto", settings: [{ key: "entity", value: "work_order" }, { key: "recordId", value: "{{ id }}" }, { key: "values", pairs: [{ field: "vendor", value: "v1" }] }] }] };
    await expect((await action("create_workflow")).handler!(args as never, ctxFor(owner))).rejects.toThrow(/cannot be automatic/);
  });

  it("tells the assistant the workflows, the templates and the catalog it picks from", async () => {
    const { store, opsFor } = await build();
    await store.put(workflowSchema.parse({ id: "w", name: "Intake", trigger: { kind: "manual" }, createdAt: at, updatedAt: at }));
    const [roster, catalog] = workflowKnowledge(await opsFor());
    expect(roster?.text).toContain('"Intake" (id: w, off, By hand, 0 steps)');
    expect(catalog?.text).toContain("outreach.text: Text a customer or anyone outside the team, in an agent's voice.");
    expect(catalog?.text).toContain("wait.for:");
  });
});

describe("booking templates from the chat", () => {
  it("scopes a turned-away follow-up to the type it names", async () => {
    const store = new MemoryWorkflowStore();
    const service = new WorkflowService({ store, policy: ownerPolicy, agents: { list: async () => [agent] }, hasConnection: () => false });
    const templates = new TemplateService({ templates: new MemoryTemplateStore(), workflows: store, newId: () => "x", builtIn: BOOKING_RECIPES });
    const ops: WorkflowChatOps = {
      roster: [],
      templates: await templates.list(),
      mayManage: async () => true,
      explain: (principal, workflow) => explainDraft(service, principal, workflow, [agent]),
      create: (principal, input) => service.create(principal, input),
      update: (principal, id, input) => service.update(principal, id, input),
      saveTemplate: (input) => templates.saveFrom(input),
      fromTemplate: async (principal, id, values, name, types) => service.create(principal, (await templates.workflowFrom(id, values, name, types ? [...types] : undefined)).input),
    };
    const use = workflowActions(ops).find((one) => one.id === "use_workflow_template")!;
    await use.handler(
      { templateId: "recipe-turned-away", blanks: [{ name: "agent", value: "maint" }, { name: "say", value: "Call us for 9 or more." }], types: ["showing"] } as never,
      ctxFor(owner),
    );
    const [made] = await service.list();
    expect(made?.trigger).toMatchObject({ kind: "booking", events: ["turned_away"], types: ["showing"] });
  });
});
