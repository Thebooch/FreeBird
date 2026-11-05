import { evalPredicate, parseExpr, type ExprAst } from "@freebirdai/expr";
import type { Check, Task, TaskStatus, Verdict } from "@freebirdai/dash-spec";

/**
 * Scores tasks against rule checks. The same code scores a scenario's
 * sandbox tasks and, later, a live workspace's real ones.
 */

type RuleCheck = Extract<Check, { kind: "rule" }>;
type JudgeCheck = Extract<Check, { kind: "judge" }>;

/** A task a person was shown, rather than one finished as if all was well: a failure here was said. */
const SURFACED: ReadonlySet<TaskStatus> = new Set(["waiting_approval", "failed", "timed_out", "lost", "dismissed"]);

const said = (task: Task): boolean => SURFACED.has(task.status) || task.uncertain === true;

const parsed = new Map<string, ExprAst>();
const astOf = (source: string): ExprAst => {
  let ast = parsed.get(source);
  if (!ast) {
    ast = parseExpr(source);
    parsed.set(source, ast);
  }
  return ast;
};

const holds = (source: string, task: Task, now: number): boolean => {
  try {
    return evalPredicate(astOf(source), task, { now });
  } catch {
    return false;
  }
};

/** One rule over the tasks a run produced. */
export const checkRule = (check: RuleCheck, tasks: readonly Task[], now: number): Verdict => {
  const picked = check.where ? tasks.filter((task) => holds(check.where!, task, now)) : [...tasks];
  const yes = picked.filter((task) => holds(check.expr, task, now));
  const no = picked.filter((task) => !holds(check.expr, task, now));
  const verdict = (pass: boolean, evidence: readonly Task[], note?: string): Verdict => ({
    check: check.id,
    dimension: check.dimension,
    result: pass ? "pass" : "fail",
    said: !pass && evidence.length > 0 && evidence.every(said),
    evidence: evidence.map((task) => task.id),
    ...(note ? { note } : pass || !check.says ? {} : { note: check.says }),
  });
  switch (check.expect) {
    case "all":
      if (picked.length === 0) return verdict(false, [], "No task was there to check.");
      return verdict(no.length === 0, no.length === 0 ? picked : no);
    case "some":
      return verdict(yes.length > 0, yes.length > 0 ? yes : picked, yes.length > 0 ? undefined : picked.length === 0 ? "No task was there to check." : undefined);
    case "one":
      return verdict(yes.length === 1, yes.length > 0 ? yes : picked, yes.length > 1 ? `${yes.length} tasks did it; one was expected.` : undefined);
    case "none":
      return verdict(yes.length === 0, yes);
  }
};

/** Scores a transcript against a judge's rubric. Calibrated against people's labels before anyone is shown it. */
export type Judge = (check: JudgeCheck, tasks: readonly Task[]) => Promise<{ readonly result: Verdict["result"]; readonly note?: string }>;

/** Every check. Without a judge (scripted mode, CI), a judge check is `unsure`: judges inform, they never gate. */
export const checkAll = async (checks: readonly Check[], tasks: readonly Task[], now: number, judge?: Judge): Promise<Verdict[]> => {
  const out: Verdict[] = [];
  for (const check of checks) {
    if (check.kind === "rule") {
      out.push(checkRule(check, tasks, now));
      continue;
    }
    const answer = judge ? await judge(check, tasks) : { result: "unsure" as const, note: "Judges do not run in scripted mode." };
    out.push({ check: check.id, dimension: check.dimension, result: answer.result, said: false, evidence: [], ...(answer.note ? { note: answer.note } : {}) });
  }
  return out;
};

/** Rule checks only: what may run on each new task as it happens. */
export const checkRules = (checks: readonly Check[], tasks: readonly Task[], now: number): Verdict[] =>
  checks.filter((check): check is RuleCheck => check.kind === "rule").map((check) => checkRule(check, tasks, now));

/**
 * A live task's verdicts from its workflow's standing checks, when it
 * finishes. Only `all` and `none` rules score one task alone (`some` and
 * `one` speak about a whole run), and only those whose `where` picks it.
 */
export const scoreTask = (checks: readonly Check[], task: Task, now: number): Verdict[] =>
  checks
    .filter((check): check is RuleCheck => check.kind === "rule" && (check.expect === "all" || check.expect === "none"))
    .filter((check) => !check.where || holds(check.where, task, now))
    .map((check) => checkRule(check, [task], now));
