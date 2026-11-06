import { FINAL_TASK_STATUSES, actionVariant, nodeName, taskLabel, type EvalRun, type Principal, type Task, type WorkflowNode, type WorkflowSpec } from "@freebirdai/dash-spec";
import type { WorkflowEnv } from "./env.js";

/**
 * Leaving trial on evidence, step by step (Dash Evals, behind
 * `DASH_EVAL_GRADUATION`): an outside step may run on Auto in trial once its
 * scenarios pass with no silent failure and enough live trial cases were
 * approved as proposed (one approved after editing does not count), with
 * none declined or reversed. Dash proposes it; a
 * person accepts it. A failed check or a reversal afterwards puts the step
 * back on Approve and says why.
 */

/** Clean trial cases a step needs before Dash proposes Auto, when the server sets no other number. */
export const DEFAULT_CLEAN_CASES = 5;

export interface StepGraduation {
  readonly node: string;
  readonly name: string;
  readonly mode: WorkflowNode["mode"];
  readonly graduated: boolean;
  readonly demoted?: { readonly at: string; readonly reason: string };
  /** Its scenarios: pass (every rule held), fail (a rule failed), or none run yet for this version. */
  readonly scenarios: "pass" | "fail" | "none";
  /** Trial tasks approved as proposed. */
  readonly clean: number;
  readonly needed: number;
  /** What stops it, in plain words. Empty: Dash proposes Auto. */
  readonly blockers: readonly string[];
  readonly ready: boolean;
}

const leavesDash = (node: WorkflowNode): boolean => actionVariant(node.action)?.leavesDash === true;

/** How each outside step stands, from the workflow's scenario runs and its tasks. */
export const graduationOf = (workflow: WorkflowSpec, runs: readonly EvalRun[], tasks: readonly Task[], needed = DEFAULT_CLEAN_CASES): StepGraduation[] => {
  const current = runs.filter((run) => "workflow" in run.target && run.target.workflow === workflow.id && run.targetVersion === workflow.version);
  const rules = current.flatMap((run) => run.verdicts.filter((verdict) => verdict.result !== "unsure"));
  const scenarios: StepGraduation["scenarios"] = current.length === 0 ? "none" : rules.some((verdict) => verdict.result === "fail") ? "fail" : "pass";
  return workflow.nodes.filter(leavesDash).map((node) => {
    /* Since it was last put back on Approve, if it was: what came before is what put it back. */
    const since = node.demoted?.at ?? "";
    const mine = tasks.filter((task) => task.workflow === workflow.id && task.node === node.id && FINAL_TASK_STATUSES.includes(task.status) && task.createdAt >= since);
    const labels = mine.map((task) => taskLabel(task));
    const clean = labels.filter((label) => label === "good").length;
    const blockers: string[] = [];
    if (scenarios === "none") blockers.push("Its scenarios have not run on this version. Press Test.");
    if (scenarios === "fail") blockers.push("A scenario check failed on this version.");
    if (clean < needed) blockers.push(`${clean} of ${needed} trial cases approved as proposed.`);
    if (labels.includes("wrong")) blockers.push("A person declined what it proposed.");
    if (labels.includes("wrong_shipped")) blockers.push("Something it did was reversed.");
    const graduated = node.graduated !== undefined;
    return {
      node: node.id,
      name: nodeName(node),
      mode: node.mode,
      graduated,
      ...(node.demoted ? { demoted: node.demoted } : {}),
      scenarios,
      clean,
      needed,
      blockers: graduated ? [] : blockers,
      ready: !graduated && blockers.length === 0,
    };
  });
};

/** A person accepts Auto for a step that is ready. A new version: open cases keep asking as they were. */
export const graduate = async (env: WorkflowEnv, workflow: WorkflowSpec, nodeId: string, by: Principal, step: StepGraduation | undefined): Promise<WorkflowSpec> => {
  if (!step) throw new Error("That step does not leave Dash, so it never asks.");
  if (step.graduated) return workflow;
  if (!step.ready) throw new Error(`"${step.name}" is not ready for Auto: ${step.blockers.join(" ")}`);
  const at = new Date(env.now()).toISOString();
  const next: WorkflowSpec = {
    ...workflow,
    nodes: workflow.nodes.map((one) => {
      if (one.id !== nodeId) return one;
      const { demoted: _demoted, ...rest } = one;
      return { ...rest, mode: "auto", graduated: { at, by: by.userId } };
    }),
    enabledBy: by,
    version: workflow.version + 1,
    updatedAt: at,
  };
  /* Every outside step graduated: the trial has nothing left to ask. */
  const done = next.nodes.filter(leavesDash).every((one) => one.graduated);
  await env.store.put(done ? { ...next, trial: 0 } : next);
  return (await env.store.get(workflow.id)) ?? next;
};

/** Back on Approve, with the reason, for a graduated step whose task failed a check or was reversed. Does nothing for a step that never graduated. */
export const demote = async (env: WorkflowEnv, workflowId: string | undefined, nodeId: string | undefined, reason: string): Promise<boolean> => {
  if (!workflowId || !nodeId) return false;
  const workflow = await env.store.get(workflowId);
  const node = workflow?.nodes.find((one) => one.id === nodeId);
  if (!workflow || !node?.graduated) return false;
  const at = new Date(env.now()).toISOString();
  await env.store.put({
    ...workflow,
    nodes: workflow.nodes.map((one) => {
      if (one.id !== nodeId) return one;
      const { graduated: _graduated, ...rest } = one;
      return { ...rest, mode: "approve", demoted: { at, reason } };
    }),
    version: workflow.version + 1,
    updatedAt: at,
  });
  env.onEvent?.({ type: "workflow.demoted", workflow: workflowId, node: nodeId, reason: `"${nodeName(node)}" is back on Approve: ${reason}` });
  return true;
};
