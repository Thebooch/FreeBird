import { createHash } from "node:crypto";
import { AdapterError } from "@freebirdai/connect/adapters";
import { Priority, retryAfterMs } from "@freebirdai/connect/host";
import {
  WORKFLOW_STEP_INFO,
  isApiTrigger,
  passes,
  readField,
  reachCovers,
  stepMode,
  stepRow,
  workflowReads,
  type AgentSpec,
  type Principal,
  type WorkflowRun,
  type WorkflowRunOutput,
  type WorkflowSpec,
  type WorkflowStart,
  type WorkflowStepMode,
} from "@freebirdai/dash-spec";
import { ParkWorkflow, type WorkflowEnv } from "./env.js";
import { DEFAULT_EXECUTORS, type ExecutorRegistry, type StepInput, type WorkflowStepExecutor } from "./executors.js";
import { SEEDED_KEY } from "./store.js";

/**
 * One run of a workflow, whatever started it.
 *
 * 1. Check access: the person whose permission it uses may read what it
 *    reads, and so may the agent, when the run is in an agent's name.
 * 2. Read through the engine at background priority, waiting a bounded time
 *    for a long read to finish, and record whether every record was reached.
 * 3. For an API trigger, keep only rows that are new (or changed) since the
 *    last look; the first look only takes note of what is there.
 * 4. Keep the rows the criteria match; with `once: "per-row"`, skip rows
 *    already acted on.
 * 5. Run the steps: once a row, each where its `when` holds, or once a run.
 * 6. Write the run down.
 *
 * Access lost parks the workflow with the reason. A refusal from the API
 * (401, 403) does too. A 429 waits as long as the API asked. Three failed
 * runs in a row turn it off and say why.
 */

/** Runs that fail in a row before a workflow is turned off. */
export const MAX_FAILURES = 3;
/** The longest a run waits for a long read to finish. */
export const READ_WAIT_MS = 60_000;

export interface RunOptions {
  readonly start: WorkflowStart;
  readonly inputs?: Readonly<Record<string, unknown>> | undefined;
  /** The person who started it by hand, or applied the request that did. Absent: whoever turned it on. */
  readonly actor?: Principal | null | undefined;
  readonly executors?: ExecutorRegistry | undefined;
}

export interface RunResult {
  readonly run: WorkflowRun;
  /** How long to leave it before trying again, when the API asked for a pause. */
  readonly waitMs?: number | undefined;
}

interface Row {
  readonly key: string;
  readonly row: unknown;
}

interface Gathered {
  readonly connection?: string | undefined;
  readonly read: number;
  readonly complete: boolean;
  readonly rows: readonly Row[];
  /** Rows the read returned without a key, so nothing could be done with them. */
  readonly keyless: number;
}

const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

/** What a row looks like, for telling a changed row from an unchanged one: the named fields, or all of it. */
export const fingerprint = (row: unknown, fields?: readonly string[]): string =>
  createHash("sha1")
    .update(stable(fields && fields.length > 0 ? fields.map((field) => readField(row, field) ?? null) : row))
    .digest("hex");

const keyOf = (row: unknown, field: string): string | undefined => {
  const value = readField(row, field);
  return typeof value === "string" && value !== "" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
};

const refusal = (error: unknown): number | undefined => {
  if (!(error instanceof AdapterError)) return undefined;
  const status = error.upstreamStatus ?? error.status;
  return status === 401 || status === 403 ? status : undefined;
};

/** Read what a workflow reads, as a person (and an agent) may. */
const gather = async (
  env: WorkflowEnv,
  workflow: WorkflowSpec,
  actor: Principal | null,
  agent: AgentSpec | null,
): Promise<Gathered> => {
  const source = workflowReads(workflow);
  /* Reads nothing: one run over its inputs. */
  if (!source) return { read: 0, complete: true, rows: [{ key: "run", row: {} }], keyless: 0 };

  if (!actor) throw new ParkWorkflow("Nobody has turned this workflow on, so it has no one's permission to read with.");
  const may = await env.policy.can(actor, "records.read", { connection: source.connection });
  if (!may.ok) throw new ParkWorkflow(`The person who turned this on may no longer read ${env.connectionTitle?.(source.connection) ?? source.connection}: ${may.reason}`);
  if (agent && !reachCovers(agent.reach, "records.read", { connection: source.connection })) {
    throw new ParkWorkflow(`${agent.name} may not read ${env.connectionTitle?.(source.connection) ?? source.connection}.`);
  }

  const answer = await env.read(
    source.connection,
    {
      ...(source.record ? { record: source.record } : {}),
      ...(source.op ? { op: source.op } : {}),
      ...(source.params ? { params: source.params } : {}),
      ...(source.range ? { range: source.range } : {}),
      /* A poll is there to see the API as it is now; other reads take an answer up to a minute old. */
      fresh: isApiTrigger(workflow.trigger) ? 0 : "1m",
      wait: true,
      waitMs: READ_WAIT_MS,
    },
    Priority.Background,
  );
  const field = workflow.rowKey ?? (source.record ? env.rowKeyField?.(source.connection, source.record) : undefined) ?? "id";
  const rows: Row[] = [];
  let keyless = 0;
  const seen = new Set<string>();
  for (const row of answer.rows) {
    const key = keyOf(row, field);
    if (key === undefined || seen.has(key)) {
      keyless++;
      continue;
    }
    seen.add(key);
    rows.push({ key, row });
  }
  return { connection: source.connection, read: answer.rows.length, complete: answer.complete, rows, keyless };
};

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const summarize = (gathered: Gathered, matched: number, outputs: readonly WorkflowRunOutput[], hasSource: boolean): string => {
  const counts = new Map<string, number>();
  for (const output of outputs) counts.set(output.outcome, (counts.get(output.outcome) ?? 0) + 1);
  const parts = [...counts].map(([outcome, count]) => `${count} ${outcome}`);
  if (!hasSource) return parts.length > 0 ? parts.join(", ") : "Nothing to do";
  const reading = `${matched} of ${plural(gathered.read, "record")} matched${gathered.complete ? "" : " (not every record was reached)"}`;
  return parts.length > 0 ? `${reading} · ${parts.join(", ")}` : `${reading} · nothing to do`;
};

/** The rows a run acts on, after the trigger, the criteria and `once`. Writes what it has now seen. */
const select = async (
  env: WorkflowEnv,
  workflow: WorkflowSpec,
  gathered: Gathered,
  inputs: Readonly<Record<string, unknown>>,
  options: { readonly dryRun: boolean },
): Promise<{ readonly seeding: boolean; readonly matched: Array<{ key: string; row: Record<string, unknown> }>; readonly toMark: Array<{ key: string; fingerprint: string }> }> => {
  const now = env.now();
  const at = new Date(now).toISOString();
  const { trigger } = workflow;
  let rows: readonly Row[] = gathered.rows;
  const toMark: Array<{ key: string; fingerprint: string }> = [];

  if (isApiTrigger(trigger)) {
    const seen = await env.store.fired(workflow.id);
    const prints = rows.map((one) => ({ key: one.key, fingerprint: fingerprint(one.row, trigger.kind === "record_changed" ? trigger.fields : undefined) }));
    if (!seen.has(SEEDED_KEY)) {
      if (!options.dryRun) await env.store.markFired(workflow.id, [...prints, { key: SEEDED_KEY, fingerprint: "" }], at);
      return { seeding: true, matched: [], toMark: [] };
    }
    const fresh: Row[] = [];
    const updates: Array<{ key: string; fingerprint: string }> = [];
    rows.forEach((one, index) => {
      const print = prints[index]!;
      const before = seen.get(one.key);
      if (before === print.fingerprint) return;
      updates.push(print);
      if (trigger.kind === "record_created" ? before === undefined : before !== undefined) fresh.push(one);
    });
    /* Seen now, whether or not it matches: a new row is new once. */
    if (!options.dryRun) await env.store.markFired(workflow.id, updates, at);
    rows = fresh;
  }

  let matched = rows
    .map((one) => ({ key: one.key, row: stepRow(one.row, inputs) }))
    .filter((one) => passes(workflow.criteria, one.row, now));

  if (workflow.once === "per-row" && workflowReads(workflow) && !isApiTrigger(trigger)) {
    const acted = await env.store.fired(workflow.id);
    const matchedKeys = new Set(matched.map((one) => one.key));
    /* A row that stopped matching can be acted on again when it matches again. Only rows this read reached. */
    const lapsed = rows.map((one) => one.key).filter((key) => acted.has(key) && !matchedKeys.has(key));
    if (lapsed.length > 0 && !options.dryRun) await env.store.unfire(workflow.id, lapsed);
    matched = matched.filter((one) => !acted.has(one.key));
    toMark.push(...matched.map((one) => ({ key: one.key, fingerprint: "" })));
  }
  return { seeding: false, matched, toMark };
};

/** Whether a step runs for a row, and how. */
export interface StepPlan {
  readonly step: string;
  readonly kind: string;
  readonly mode: WorkflowStepMode;
  readonly runs: boolean;
}

const planFor = (workflow: WorkflowSpec, row: Record<string, unknown>, now: number): StepPlan[] =>
  workflow.steps
    .filter((step) => !WORKFLOW_STEP_INFO[step.kind].perRun)
    .map((step) => ({ step: step.id, kind: step.kind, mode: stepMode(step), runs: passes(step.when, row, now) }));

export const runWorkflow = async (env: WorkflowEnv, workflow: WorkflowSpec, options: RunOptions): Promise<RunResult> => {
  const executors = { ...DEFAULT_EXECUTORS, ...options.executors };
  const inputs = options.inputs ?? {};
  const startedAt = new Date(env.now()).toISOString();
  const agentId = options.start.agentId;
  const agent = agentId ? await env.agents.get(agentId) : null;
  const actor = options.actor ?? workflow.enabledBy ?? null;
  const started: WorkflowRun = {
    id: env.newId(),
    workflow: workflow.id,
    workflowName: workflow.name,
    ...(agentId ? { agent: agentId } : {}),
    start: options.start,
    ...(Object.keys(inputs).length > 0 ? { inputs: { ...inputs } } : {}),
    startedAt,
    status: "running",
    read: 0,
    matched: 0,
    complete: true,
    summary: "",
    outputs: [],
  };
  await env.store.putRun(started);

  const finish = async (patch: Partial<WorkflowRun>): Promise<WorkflowRun> => {
    const done: WorkflowRun = { ...started, ...patch, finishedAt: new Date(env.now()).toISOString() };
    await env.store.putRun(done);
    env.onEvent?.({ type: "workflow.run", workflow: workflow.id, run: done.id, status: done.status, matched: done.matched });
    return done;
  };

  /* The workflow as it is now: a person may have edited it while this ran. */
  const amend = async (change: (held: WorkflowSpec) => WorkflowSpec): Promise<void> => {
    const held = await env.store.get(workflow.id);
    if (held) await env.store.put(change(held));
  };

  const park = async (reason: string): Promise<RunResult> => {
    await amend((held) => ({ ...held, parked: { reason, at: new Date(env.now()).toISOString() } }));
    env.onEvent?.({ type: "workflow.parked", workflow: workflow.id, reason });
    return { run: await finish({ status: "parked", error: reason, summary: `Paused: ${reason}` }) };
  };

  const failed = async (message: string, patch: Partial<WorkflowRun> = {}): Promise<RunResult> => {
    let turnedOff = false;
    await amend((held) => {
      const failures = held.failures + 1;
      turnedOff = failures >= MAX_FAILURES;
      return {
        ...held,
        failures,
        ...(turnedOff ? { enabled: false, parked: { reason: `Failed ${MAX_FAILURES} runs in a row. The last: ${message}`, at: new Date(env.now()).toISOString() } } : {}),
      };
    });
    if (turnedOff) env.onEvent?.({ type: "workflow.parked", workflow: workflow.id, reason: message });
    return { run: await finish({ status: "failed", error: message, summary: patch.summary ?? `Failed: ${message}`, ...patch }) };
  };

  try {
    if (agentId && !agent) throw new ParkWorkflow(`The agent "${agentId}" that started it no longer exists.`);
    if (agent?.archived) throw new ParkWorkflow(`${agent.name} is archived.`);

    const gathered = await gather(env, workflow, actor, agent);
    const selected = await select(env, workflow, gathered, inputs, { dryRun: false });
    if (selected.seeding) {
      return {
        run: await finish({
          status: "seeded",
          read: gathered.read,
          complete: gathered.complete,
          summary: `Took note of ${plural(gathered.rows.length, "existing record")}. From now on, only ${workflow.trigger.kind === "record_created" ? "new ones" : "changes"} start it.`,
        }),
      };
    }

    const { matched } = selected;
    const now = env.now();
    const outputs: WorkflowRunOutput[] = [];
    const common = { env, workflow, run: started.id, actor, agent, connection: gathered.connection, rows: matched, inputs };
    /*
     * Where the run has got to, for the Overview. Written when the step changes,
     * and otherwise at most once a second, so a long run over many records does
     * not cost a write per record.
     */
    let staged = { step: "", at: 0 };
    const stage = async (step: WorkflowSpec["steps"][number], rowKey: string | undefined, rowIndex: number | undefined): Promise<void> => {
      const at = env.now();
      if (staged.step === step.id && at - staged.at < 1_000) return;
      staged = { step: step.id, at };
      await env.store.putRun({
        ...started,
        stage: {
          step: step.id,
          kind: step.kind,
          index: workflow.steps.indexOf(step) + 1,
          of: workflow.steps.length,
          ...(rowKey !== undefined ? { row: rowKey } : {}),
          ...(rowIndex !== undefined ? { rowIndex: rowIndex + 1, rows: matched.length } : {}),
        },
      });
    };
    const execute = async (step: WorkflowSpec["steps"][number], input: Omit<StepInput, "step">): Promise<void> => {
      const executor = executors[step.kind] as WorkflowStepExecutor | undefined;
      if (!executor) {
        outputs.push({ step: step.id, kind: step.kind, ...(input.rowKey !== undefined ? { row: input.rowKey } : {}), outcome: "skipped", detail: "This kind of step cannot run here yet." });
        return;
      }
      outputs.push(...(await executor({ ...input, step } as StepInput)));
    };

    for (const [rowIndex, one] of matched.entries()) {
      for (const step of workflow.steps) {
        if (WORKFLOW_STEP_INFO[step.kind].perRun || !passes(step.when, one.row, now)) continue;
        await stage(step, one.key, rowIndex);
        await execute(step, { ...common, row: one.row, rowKey: one.key });
      }
    }
    if (matched.length > 0) {
      const runRow = { count: matched.length, input: inputs };
      for (const step of workflow.steps) {
        if (!WORKFLOW_STEP_INFO[step.kind].perRun || !passes(step.when, runRow, now)) continue;
        await stage(step, undefined, undefined);
        await execute(step, common);
      }
    }
    if (selected.toMark.length > 0) await env.store.markFired(workflow.id, selected.toMark, new Date(env.now()).toISOString());

    const summary = summarize(gathered, matched.length, outputs, workflowReads(workflow) !== undefined);
    const patch = { read: gathered.read, matched: matched.length, complete: gathered.complete, outputs, summary };
    if (outputs.length > 0 && outputs.every((one) => one.outcome === "failed")) return await failed(outputs[0]?.detail ?? "Every step failed.", patch);
    if (workflow.failures > 0) await amend((held) => ({ ...held, failures: 0 }));
    return { run: await finish({ status: "succeeded", ...patch }) };
  } catch (error) {
    if (error instanceof ParkWorkflow) return park(error.reason);
    const status = refusal(error);
    if (status !== undefined) {
      const source = workflowReads(workflow);
      const where = source ? (env.connectionTitle?.(source.connection) ?? source.connection) : "The API";
      return park(`${where} refused the read (${status}). Check its key or what it may read.`);
    }
    if (error instanceof AdapterError && error.status === 429) {
      const waitMs = retryAfterMs(error.retryAfter, env.now()) ?? 60_000;
      return { run: await finish({ status: "failed", error: error.userMessage, summary: `Asked to wait by the API; trying again later.` }), waitMs };
    }
    return failed(error instanceof AdapterError ? error.userMessage : error instanceof Error ? error.message : String(error));
  }
};

/* ── preview ───────────────────────────────────────────────────────────── */

export interface WorkflowPreview {
  readonly read: number;
  readonly complete: boolean;
  /** An API trigger's first run takes note only. */
  readonly seeding: boolean;
  readonly matched: number;
  /** Matched rows, each with the path it would take; the first few. */
  readonly rows: ReadonlyArray<{ readonly key: string; readonly fields: Readonly<Record<string, unknown>>; readonly steps: readonly StepPlan[] }>;
  /** Steps done once a run. */
  readonly perRun: readonly StepPlan[];
  /** What stopped it reading, if anything. */
  readonly problem?: string | undefined;
}

const PREVIEW_ROWS = 25;
const PREVIEW_FIELDS = 8;

const fieldsOf = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row)
      .filter(([name, value]) => name !== "input" && (value === null || typeof value !== "object"))
      .slice(0, PREVIEW_FIELDS),
  );

/**
 * A dry run, as the person asking: what it would read, which rows match, and
 * the path each would take. Nothing is written, proposed or remembered.
 */
export const previewWorkflow = async (
  env: WorkflowEnv,
  workflow: WorkflowSpec,
  actor: Principal,
  inputs: Readonly<Record<string, unknown>> = {},
): Promise<WorkflowPreview> => {
  const now = env.now();
  let gathered: Gathered;
  try {
    gathered = await gather(env, workflow, actor, null);
  } catch (error) {
    const problem = error instanceof ParkWorkflow ? error.reason : error instanceof AdapterError ? error.userMessage : error instanceof Error ? error.message : String(error);
    return { read: 0, complete: false, seeding: false, matched: 0, rows: [], perRun: [], problem };
  }
  const selected = await select(env, workflow, gathered, inputs, { dryRun: true });
  const runRow = { count: selected.matched.length, input: inputs };
  return {
    read: gathered.read,
    complete: gathered.complete,
    seeding: selected.seeding,
    matched: selected.matched.length,
    rows: selected.matched.slice(0, PREVIEW_ROWS).map((one) => ({ key: one.key, fields: fieldsOf(one.row), steps: planFor(workflow, one.row, now) })),
    perRun: workflow.steps
      .filter((step) => WORKFLOW_STEP_INFO[step.kind].perRun)
      .map((step) => ({ step: step.id, kind: step.kind, mode: stepMode(step), runs: selected.matched.length > 0 && passes(step.when, runRow, now) })),
  };
};
