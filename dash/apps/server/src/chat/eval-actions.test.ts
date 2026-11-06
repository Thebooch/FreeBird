import type { ActionContext } from "@freebirdai/core";
import { describe, expect, it } from "vitest";
import { EvalService } from "../evals/service.js";
import { MemoryEvalRunStore } from "../evals/store.js";
import { PERSONAS } from "../evals/workflow-pack.js";
import { agentOf, byHand, fake, node, owner, workflowOf } from "../workflows/testing.js";
import { evalActions } from "./eval-actions.js";

/** The chat's Dash Evals tools: test a workflow (and against outside personas), save a task as a test, say why a check failed. */

const ctx = { auth: { extra: { principal: owner } } } as unknown as ActionContext<unknown>;

const setup = async (workflow: ReturnType<typeof workflowOf>) => {
  const f = fake({ sender: true });
  f.agents.set("maint", agentOf());
  await f.env.store.put(workflow);
  const evals = new EvalService({ env: f.env, runs: new MemoryEvalRunStore() });
  const actions = evalActions({
    mayManage: async () => true,
    test: (id, personas) => evals.test(id, personas),
    saveTask: (id) => evals.saveTask(id),
    task: (id) => f.env.tasks.get(id),
    run: (id) => evals.run(id),
    personas: PERSONAS,
  });
  const action = (id: string) => actions.find((one) => one.id === id)!;
  return { f, evals, action };
};

describe("the chat's eval tools", () => {
  it("tests a workflow an email starts against pushy and injecting senders, and says what failed", async () => {
    const forward = workflowOf({
      trigger: { kind: "message_received", channels: ["email"] },
      nodes: [
        node("read", "think.extract", { prompt: "What should change?", from: "{{ text }}", fields: ["invoice", "status"] }),
        node("update", "update.record", { connection: "pms", entity: "work_order", recordId: "{{ steps.read.values.invoice }}", values: { status: "{{ steps.read.values.status }}" } }),
      ],
    });
    const { action } = await setup(forward);
    const result = (await action("run_scenarios").handler({ workflowId: "wf", personas: ["injector-observe-only", "pushy-assistant"] }, ctx)) as { runs: Array<{ scenario: string; failed: unknown[] }> };
    expect(result.runs.map((run) => run.scenario)).toEqual(["wf-basic", "wf-pushy-assistant", "wf-injector-observe-only"]);
    /* The mark held the update for a person: the injector set nothing off unattended. */
    expect(result.runs.find((run) => run.scenario === "wf-injector-observe-only")?.failed).toEqual([]);
    await expect(action("run_scenarios").handler({ workflowId: "wf", personas: ["nobody"] }, ctx)).rejects.toThrow(/No persona is called nobody/);
  });

  it("explains a task's failed check and what a person changed, and saves its case as a test", async () => {
    const checks = [{ kind: "rule", id: "to-dana", dimension: "correctness", says: "Emails go to Dana.", where: 'base == "outreach"', expect: "all", expr: 'body.to == "dana@example.com"' }];
    const workflow = workflowOf({ trigger: { kind: "manual" }, checks, nodes: [node("say", "outreach.email", { agentId: "maint", to: "sam@example.com", subject: "Hi", purpose: "Hi", content: "fixed", wording: "Hello" }, { mode: "auto" })] });
    const { f, action } = await setup(workflow);
    await byHand(f, workflow);
    const [task] = await f.env.tasks.list();
    expect(await action("explain_eval").handler({ taskId: task!.id }, ctx)).toMatchObject({ checks: [{ check: "to-dana", result: "fail", why: "Emails go to Dana." }] });
    const saved = (await action("save_task_as_scenario").handler({ taskId: task!.id }, ctx)) as { saved: string; checks: string[] };
    expect(saved.checks).toContain("Emails go to Dana.");
    expect(action("save_task_as_scenario").requiresConfirmation).toBe("preview");
  });

  it("refuses someone who may not manage workflows", async () => {
    const workflow = workflowOf({ trigger: { kind: "manual" }, nodes: [node("n", "create.note", { text: "x" })] });
    const { f } = await setup(workflow);
    const actions = evalActions({ mayManage: async () => false, test: async () => [], saveTask: async () => ({}) as never, task: (id) => f.env.tasks.get(id), run: async () => null, personas: [] });
    expect(await actions[0]!.authorize!({ workflowId: "wf" }, ctx)).toMatchObject({ ok: false, status: 403 });
  });
});
