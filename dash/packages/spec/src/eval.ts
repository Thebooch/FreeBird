import { idSchema } from "@freebirdai/connect-spec";
import { parseExpr } from "@freebirdai/expr";
import { z } from "zod";
import { agentSchema } from "./agent.js";
import { workflowSchema } from "./workflow.js";

/**
 * Dash Evals: scenarios that put a workflow or an agent through a situation
 * in a sandbox, and checks that score what it did.
 *
 * A run produces ordinary tasks (`workflow.ts`), and checks read those tasks:
 * nothing evaluates model output directly. Scenarios, live tasks and the
 * graduation from trial all use the same checks.
 *
 * Built to be stepped, not only run: a sandbox is a session with an id, a run
 * is an append-only log of events that every view is read from, and inputs
 * arrive only as turns, so a replay matches.
 */

/* ── vocabulary ────────────────────────────────────────────────────────── */

/** What a check scores. Dimensions are never merged into one number (`bench/PROTOCOL.md`). */
export const EVAL_DIMENSIONS = ["completion", "correctness", "authority", "disclosure", "resistance", "honesty", "friction", "tone"] as const;
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

/** `dev` is tuned against; `heldout` is written by someone who reads neither the prompts nor the rules, and never tuned against. */
export const EVAL_SPLITS = ["dev", "heldout"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

/** Who plays the other side. `person` is reserved: a person typing the other side's turns needs no schema change. */
export const PERSONA_DRIVERS = ["script", "model", "person"] as const;
export type PersonaDriver = (typeof PERSONA_DRIVERS)[number];

export const TURN_KINDS = ["message", "booking", "record", "clock"] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

/** A check's expression must parse: `@freebirdai/expr` is safe by construction, so a check needs no code review. */
const exprSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .superRefine((source, ctx) => {
    try {
      parseExpr(source);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error) });
    }
  });

/* ── turns and personas ────────────────────────────────────────────────── */

/**
 * One thing that happens to the sandbox, in order: an email arrives, a
 * booking changes, records change, or the clock moves. Payloads by kind:
 *
 * - `message`: `{ from, subject, text, mailbox? }`, an email as `message_received` workflows see it.
 * - `booking`: `{ event, type?, row }`, a booking event; `row` is the booking shaped for steps.
 * - `record`: `{ add?: rows[], update?: { id, values }[] }`, the connection's records change.
 * - `clock`: `{ ms }`, time moves on.
 */
export const turnSchema = z.object({
  id: idSchema,
  kind: z.enum(TURN_KINDS),
  payload: z.record(z.unknown()).default({}),
  /** The turn it follows, when the order matters to the reader. Must be an earlier turn. */
  after: idSchema.optional(),
});
export type Turn = z.infer<typeof turnSchema>;

export const personaSchema = z.object({
  id: idSchema,
  kind: z.enum(["human", "agent"]),
  /** What they want, in plain words: "reschedule twice, then ask for a refund". */
  goal: z.string().trim().min(1).max(1000),
  style: z.string().trim().max(500).default(""),
  adversarial: z.enum(["injection", "pressure", "impersonation", "overreach"]).optional(),
  driver: z.enum(PERSONA_DRIVERS).default("script"),
  /** For `driver: "script"`: the persona's turns, played after the scenario's own. */
  script: z.array(turnSchema).max(100).optional(),
});
export type Persona = z.infer<typeof personaSchema>;

/* ── worlds and sessions ───────────────────────────────────────────────── */

/** The settings a world boots with: the agents, the workflows and the records a connection reads. */
export const worldWorkspaceSchema = z.object({
  agents: z.array(agentSchema).max(50).default([]),
  workflows: z.array(workflowSchema).max(50).default([]),
  /** Rows the connection's reads return. Added to the provider's own seed. */
  records: z.array(z.record(z.unknown())).max(5000).default([]),
});
export type WorldWorkspace = z.infer<typeof worldWorkspaceSchema>;

/** The seed and settings a session boots from. `provider` names a world the server knows. */
export const worldRefSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  seed: z.string().max(200).optional(),
  workspace: worldWorkspaceSchema.default({}),
});
export type WorldRef = z.infer<typeof worldRefSchema>;

export const SANDBOX_STATUSES = ["running", "waiting", "paused", "ended"] as const;
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

/**
 * A live sandbox with an id: CI, the runner and the Test button all use one
 * API (start, step, run until waiting, snapshot, restore, stop). A sandbox
 * cannot reach the world: nothing it does is sent, written or charged.
 */
export const sandboxSessionSchema = z.object({
  id: z.string(),
  world: worldRefSchema,
  /** The session's own clock, in epoch milliseconds. */
  clock: z.number(),
  status: z.enum(SANDBOX_STATUSES),
});
export type SandboxSession = z.infer<typeof sandboxSessionSchema>;

/** A model reply the scripted model gives, in order: text, or a tool call's arguments. */
export const scriptedReplySchema = z.union([z.object({ text: z.string() }), z.object({ args: z.unknown() })]);
export type ScriptedReply = z.infer<typeof scriptedReplySchema>;

/* ── checks ────────────────────────────────────────────────────────────── */

/**
 * One assertion over the tasks a run produced.
 *
 * A rule picks tasks with `where` (all of them when absent) and asks `expr`
 * of each: `all` passes when at least one task is picked and every one
 * holds; `some` when at least one holds; `one` when exactly one holds;
 * `none` when none does. Only rules
 * gate (graduate a step, hold a message). A judge only informs.
 */
export const checkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule"),
    id: idSchema,
    dimension: z.enum(EVAL_DIMENSIONS),
    /** What it checks, in plain words, for the person reading a failure. */
    says: z.string().trim().max(300).optional(),
    where: exprSchema.optional(),
    expect: z.enum(["all", "some", "one", "none"]).default("all"),
    expr: exprSchema,
  }),
  z.object({
    kind: z.literal("judge"),
    id: idSchema,
    dimension: z.enum(EVAL_DIMENSIONS),
    says: z.string().trim().max(300).optional(),
    rubric: z.string().trim().min(1).max(4000),
    model: z.string().max(120).optional(),
  }),
]);
export type Check = z.infer<typeof checkSchema>;

/* ── scenarios ─────────────────────────────────────────────────────────── */

export const evalTargetSchema = z.union([
  z.object({ workflow: idSchema }),
  z.object({ agent: idSchema }),
  z.object({ surface: z.enum(["email", "booking", "mcp"]) }),
]);
export type EvalTarget = z.infer<typeof evalTargetSchema>;

/** A situation to put an agent or workflow through. Written once, versioned, kept in a split. */
export const scenarioSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(120),
    version: z.number().int().min(1).default(1),
    split: z.enum(EVAL_SPLITS).default("dev"),
    direction: z.enum(["outbound", "inbound"]),
    target: evalTargetSchema,
    world: worldRefSchema,
    persona: personaSchema.optional(),
    /** What arrives, in order. */
    turns: z.array(turnSchema).max(200).default([]),
    /** Fixed before any run, like the bench's answer keys. */
    checks: z.array(checkSchema).min(1).max(50),
    /** Scripted mode: the model's replies, in order. Absent: no model is reachable in the sandbox. */
    scriptedModel: z.array(scriptedReplySchema).max(200).optional(),
  })
  .superRefine((scenario, ctx) => {
    const turns = [...scenario.turns, ...(scenario.persona?.script ?? [])];
    const seen = new Set<string>();
    for (const [index, turn] of turns.entries()) {
      if (seen.has(turn.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["turns", index, "id"], message: `Turn "${turn.id}" is there twice.` });
      if (turn.after !== undefined && !seen.has(turn.after)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["turns", index, "after"], message: `Turn "${turn.id}" follows "${turn.after}", which does not come before it.` });
      seen.add(turn.id);
    }
    const checks = new Set<string>();
    for (const [index, check] of scenario.checks.entries()) {
      if (checks.has(check.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "id"], message: `Check "${check.id}" is there twice.` });
      checks.add(check.id);
    }
  });
export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioInput = z.input<typeof scenarioSchema>;

/* ── runs ──────────────────────────────────────────────────────────────── */

export const VERDICT_RESULTS = ["pass", "fail", "unsure"] as const;
export type VerdictResult = (typeof VERDICT_RESULTS)[number];

/**
 * One check's answer. `said` mirrors the bench's "wrong, and not said": for a
 * failure, whether every task it points at was put in front of a person
 * (asked for approval, or ended failed) rather than finished as if all was well.
 */
export const verdictSchema = z.object({
  check: z.string(),
  dimension: z.enum(EVAL_DIMENSIONS),
  result: z.enum(VERDICT_RESULTS),
  said: z.boolean(),
  /** The tasks it is about. */
  evidence: z.array(z.string()).default([]),
  note: z.string().optional(),
});
export type Verdict = z.infer<typeof verdictSchema>;

export const RUN_EVENT_KINDS = ["turn", "step", "task", "verdict", "waiting", "snapshot", "ended"] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

/** Everything a run does, in order, as it happens. */
export const runEventSchema = z.object({
  seq: z.number().int().min(0),
  /** The session's clock. */
  at: z.number(),
  turn: z.string().optional(),
  kind: z.enum(RUN_EVENT_KINDS),
  data: z.unknown(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

/** One execution of one scenario version against one target version, in one session. */
export const evalRunSchema = z.object({
  id: z.string(),
  scenario: z.string(),
  scenarioVersion: z.number().int(),
  target: evalTargetSchema,
  /** The workflow's `version`, where the target is a workflow. */
  targetVersion: z.number().int().optional(),
  session: z.string(),
  driver: z.enum(PERSONA_DRIVERS),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** Append-only: tasks, verdicts and every view are read from it. */
  events: z.array(runEventSchema),
  verdicts: z.array(verdictSchema),
});
export type EvalRun = z.infer<typeof evalRunSchema>;

/** A run's verdicts by dimension: how many passed, failed silently, failed and said, or were unsure. */
export const verdictsByDimension = (verdicts: readonly Verdict[]): Partial<Record<EvalDimension, { pass: number; fail: number; silent: number; unsure: number }>> => {
  const out: Partial<Record<EvalDimension, { pass: number; fail: number; silent: number; unsure: number }>> = {};
  for (const one of verdicts) {
    const row = (out[one.dimension] ??= { pass: 0, fail: 0, silent: 0, unsure: 0 });
    if (one.result === "pass") row.pass++;
    else if (one.result === "unsure") row.unsure++;
    else if (one.said) row.fail++;
    else row.silent++;
  }
  return out;
};
