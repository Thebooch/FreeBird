import type { ActionContext, ActionDefinition } from "@freebirdai/core";
import type { EvalRun, Principal, ScenarioInput, Task } from "@freebirdai/dash-spec";
import { z } from "zod";
import { principalOf } from "./screens/common.js";

/**
 * The chat's Dash Evals tools, on the workflows screen: test a workflow
 * (against outside personas too), save a task as a test, and say why a
 * check failed. Tests play in a sandbox: nothing is sent, written or charged
 * beyond the model calls a judge makes.
 */

export interface EvalChatOps {
  mayManage(principal: Principal): Promise<boolean>;
  /** Plays the workflow's pack, and the named outside personas against it. Kept like the Test button's runs. */
  test(workflowId: string, personas?: readonly string[]): Promise<EvalRun[]>;
  saveTask(taskId: string): Promise<ScenarioInput>;
  task(taskId: string): Promise<Task | null>;
  run(runId: string): Promise<EvalRun | null>;
  /** The outside personas a workflow an email starts can be tested against. */
  readonly personas: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/** A run in a few lines the model can retell: each check's result, and why for a failure. */
const runWords = (run: EvalRun) => ({
  scenario: run.scenario,
  run: run.id,
  version: run.targetVersion,
  passed: run.verdicts.filter((one) => one.result === "pass").length,
  failed: run.verdicts
    .filter((one) => one.result === "fail")
    .map((one) => ({ check: one.check, dimension: one.dimension, why: one.note ?? one.check, told: one.said ? "a person was asked" : "nobody was told" })),
  unsure: run.verdicts.filter((one) => one.result === "unsure").map((one) => ({ check: one.check, why: one.note ?? "" })),
});

export const evalActions = (ops: EvalChatOps): ActionDefinition<any, unknown, unknown>[] => {
  const mayManage = async (ctx: ActionContext<unknown>) => {
    const principal = principalOf(ctx);
    if (!principal) return { ok: false as const, reason: "Nobody is signed in.", status: 401 };
    return (await ops.mayManage(principal)) || { ok: false as const, reason: "Your role here does not allow testing workflows.", status: 403 };
  };

  const runScenarios: ActionDefinition<{ workflowId: string; personas?: string[] }, unknown, unknown> = {
    id: "run_scenarios",
    description:
      "Test a workflow in a sandbox: what starts it is played against a copy of it, and its checks scored. Nothing is sent or changed. " +
      `For a workflow an email starts, also against outside personas (${ops.personas.map((one) => `${one.id}: ${one.name}`).join("; ")}), e.g. "test it against pushy customers" is ["pushy-assistant"]. ` +
      "Say which checks failed and why, in plain words; a failure nobody was told about is the worse kind.",
    schema: z.object({
      workflowId: z.string().describe("A workflow from WORKFLOWS."),
      personas: z.array(z.string()).max(10).optional().describe("Outside personas to play against it, by id."),
    }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: (_args, ctx) => mayManage(ctx),
    handler: async (args) => {
      const unknown = (args.personas ?? []).filter((id) => !ops.personas.some((one) => one.id === id));
      if (unknown.length > 0) throw new Error(`No persona is called ${unknown.join(", ")}. They are: ${ops.personas.map((one) => one.id).join(", ")}.`);
      const runs = await ops.test(args.workflowId, args.personas);
      return { workflow: args.workflowId, runs: runs.map(runWords) };
    },
  };

  const saveTask: ActionDefinition<{ taskId: string }, unknown, unknown> = {
    id: "save_task_as_scenario",
    description:
      "Keep a finished task's case as a test of its workflow, with its people replaced by stand-ins. A declined, edited or reversed step gets a check that it never runs unattended in that situation again. The test runs with the workflow's others from then on.",
    schema: z.object({ taskId: z.string().describe("A task's id, from the Overview or Waiting for you.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: (_args, ctx) => mayManage(ctx),
    preview: (args) => ({ title: "Save as a test", summary: "This task's case becomes a test of its workflow, its people replaced by stand-ins.", rows: [{ label: "Task", value: args.taskId }] }),
    handler: async (args) => {
      const saved = await ops.saveTask(args.taskId);
      return { saved: saved.id, name: saved.name, checks: saved.checks.map((one) => ("says" in one && one.says) || one.id) };
    },
  };

  const explain: ActionDefinition<{ taskId?: string; runId?: string }, unknown, unknown> = {
    id: "explain_eval",
    description:
      "Why a task's check failed, or what a test run found: each check, its result and why, what a person did about the task (approved as proposed, edited, declined, reversed), and what was changed. Answer \"why did this fail?\" from this, in plain words.",
    schema: z.object({ taskId: z.string().optional(), runId: z.string().optional() }).refine((one) => Boolean(one.taskId || one.runId), "Name a task or a run."),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: (_args, ctx) => mayManage(ctx),
    handler: async (args) => {
      if (args.runId) {
        const run = await ops.run(args.runId);
        if (!run) throw new Error(`There is no test run "${args.runId}".`);
        return runWords(run);
      }
      const task = await ops.task(args.taskId!);
      if (!task) throw new Error(`There is no task "${args.taskId}".`);
      return {
        task: task.title,
        workflow: task.workflowName,
        status: task.status,
        checks: (task.eval ?? []).map((one) => ({ check: one.check, dimension: one.dimension, result: one.result, why: one.note ?? one.check })),
        ...(task.eval?.length ? {} : { note: "Its workflow has no standing checks, so nothing scored it." }),
        ...(task.reason ? { why: task.reason } : {}),
        ...(task.edited ? { edited: task.edited.changes.map((one) => ({ setting: one.key, proposed: one.before, sent: one.after })) } : {}),
        ...(task.reversal?.reversedAt ? { reversed: { by: task.reversal.reversedBy, at: task.reversal.reversedAt } } : {}),
      };
    },
  };

  return [runScenarios, saveTask, explain];
};

export const evalKnowledge = (): Array<{ text: string }> => [
  { text: "Tests (Dash Evals): run_scenarios plays a workflow in a sandbox and scores its checks; explain_eval says why a check failed; save_task_as_scenario keeps a real case as a test." },
];
