import { createHash } from "node:crypto";
import { AdapterError } from "@freebirdai/connect/adapters";
import { Priority, retryAfterMs } from "@freebirdai/connect/host";
import {
  actionVariant,
  durationMs,
  firstNode,
  isApiTrigger,
  nextNode,
  nodeMode,
  nodeName,
  passes,
  readField,
  renderText,
  stepRow,
  workflowReads,
  type AgentSpec,
  type Principal,
  type WorkflowRun,
  type WorkflowSpec,
  type WorkflowStart,
  type WorkflowStepMode,
} from "@freebirdai/dash-spec";
import type { WorkflowEngine } from "./engine.js";
import { ParkWorkflow, type WorkflowEnv } from "./env.js";
import { mayRead } from "./reads.js";
import { SEEDED_KEY, type FiredRow } from "./store.js";

/**
 * One pass of a workflow's trigger: read what it reads, keep the records that
 * are new (or changed) and match its criteria, and open a case for each.
 *
 * The cases do the work (`engine.ts`). A run only decides which records start
 * one, within the trigger's limits: how many cases one record may open, how
 * long it rests in between, and when the trigger expires. Each record is
 * claimed before its case opens, and the claim only succeeds if nobody else
 * claimed it since this run looked, so two runs never open a case for the
 * same record. A record whose case could not open is given back.
 *
 * A trigger on new records first takes note of what is already there, and
 * keeps taking note until one read has reached every record: a record first
 * seen later is new only once the baseline is whole.
 *
 * Access lost parks the workflow with the reason, as does a 401 or 403 from
 * the API; a 429 waits as long as the API asked.
 */

export const MAX_FAILURES = 3;
export const READ_WAIT_MS = 60_000;

export interface RunOptions {
  readonly start: WorkflowStart;
  readonly inputs?: Readonly<Record<string, unknown>> | undefined;
  /** The person who started it by hand, or approved the request that did. Absent: whoever turned it on. */
  readonly actor?: Principal | null | undefined;
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
  readonly read: number;
  readonly complete: boolean;
  readonly rows: readonly Row[];
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

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const caseIdFor = (workflow: string, key: string, count: number): string => createHash("sha1").update(`${workflow}\u0000${key}\u0000${count}`).digest("hex").slice(0, 24);

/** Read what a workflow reads, as a person (and an agent) may. */
const gather = async (env: WorkflowEnv, workflow: WorkflowSpec, actor: Principal | null, agent: AgentSpec | null): Promise<Gathered> => {
  const source = workflowReads(workflow);
  if (!source) return { read: 0, complete: true, rows: [{ key: "", row: {} }] };
  await mayRead(env, { actor, agent }, source.connection);

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
  const seen = new Set<string>();
  for (const row of answer.rows) {
    const key = keyOf(row, field);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, row });
  }
  return { read: answer.rows.length, complete: answer.complete, rows };
};

interface Selected {
  readonly seeding: boolean;
  /** Still seeding after this run: not every record has been reached yet. */
  readonly baselinePartial?: boolean;
  readonly expired: boolean;
  readonly matched: Array<{ key: string; row: Record<string, unknown> }>;
  /** What each record's claim will write, and what it must find there first, by key. */
  readonly marks: Map<string, { readonly before: FiredRow | undefined; readonly next: FiredRow }>;
  /** Seen whatever happens: new or changed records that did not match. */
  readonly seen: Array<{ key: string } & FiredRow>;
}

/** The records a run opens cases for, after the trigger, its limits, the criteria and `once`. */
const select = async (env: WorkflowEnv, workflow: WorkflowSpec, gathered: Gathered, inputs: Readonly<Record<string, unknown>>, dryRun: boolean): Promise<Selected> => {
  const now = env.now();
  const at = new Date(now).toISOString();
  const { trigger, triggerLimits: limits } = workflow;
  const marks = new Map<string, { before: FiredRow | undefined; next: FiredRow }>();
  const seenOnly: Array<{ key: string } & FiredRow> = [];
  if (limits.expiresAt && Date.parse(limits.expiresAt) <= now) return { seeding: false, expired: true, matched: [], marks, seen: seenOnly };
  if (!workflowReads(workflow)) {
    return { seeding: false, expired: false, matched: [{ key: "", row: {} }], marks, seen: seenOnly };
  }

  const fired = await env.store.fired(workflow.id);
  const cooldownMs = durationMs(limits.cooldown) ?? 0;
  /* Within its limits: not too many cases for one record, and not too soon after the last. */
  const allowed = (key: string): boolean => {
    const held = fired.get(key);
    if (!held) return true;
    if (limits.maxPerRecord !== undefined && held.count >= limits.maxPerRecord) return false;
    if (cooldownMs > 0 && held.lastAt && Date.parse(held.lastAt) + cooldownMs > now) return false;
    return true;
  };

  let rows: readonly Row[] = gathered.rows;
  const prints = new Map<string, string>();
  if (isApiTrigger(trigger)) {
    for (const one of rows) prints.set(one.key, fingerprint(one.row, trigger.kind === "record_changed" ? trigger.fields : undefined));
    if (!fired.has(SEEDED_KEY)) {
      /* The baseline grows with each read, and is whole only once one read reached every record. */
      const noted = [...prints].map(([key, print]) => ({ key, fingerprint: print, count: fired.get(key)?.count ?? 0, ...(fired.get(key)?.lastAt ? { lastAt: fired.get(key)!.lastAt } : {}) }));
      if (!dryRun) await env.store.markFired(workflow.id, gathered.complete ? [...noted, { key: SEEDED_KEY, fingerprint: "", count: 0 }] : noted);
      return { seeding: true, ...(gathered.complete ? {} : { baselinePartial: true }), expired: false, matched: [], marks, seen: seenOnly };
    }
    rows = rows.filter((one) => {
      const before = fired.get(one.key);
      const print = prints.get(one.key)!;
      if (before?.fingerprint === print) return false;
      /* A new record is new once; a changed one counts only if it was there before. */
      if (trigger.kind === "record_created" ? before !== undefined : before === undefined) {
        seenOnly.push({ key: one.key, fingerprint: print, count: before?.count ?? 0, ...(before?.lastAt ? { lastAt: before.lastAt } : {}) });
        return false;
      }
      return true;
    });
  }

  let matched = rows.map((one) => ({ key: one.key, row: one.row as Record<string, unknown> })).filter((one) => passes(workflow.criteria, stepRow(one.row, inputs), now));
  const matchedKeys = new Set(matched.map((one) => one.key));
  if (isApiTrigger(trigger)) {
    /* Changed or new but not a match: seen all the same, so it is not new again next time. */
    for (const one of rows) {
      if (matchedKeys.has(one.key)) continue;
      const before = fired.get(one.key);
      seenOnly.push({ key: one.key, fingerprint: prints.get(one.key)!, count: before?.count ?? 0, ...(before?.lastAt ? { lastAt: before.lastAt } : {}) });
    }
  } else if (workflow.once === "per-row") {
    /* A record that stopped matching can open a case again when it matches again. Only records this read reached. */
    const lapsed = rows.map((one) => one.key).filter((key) => fired.get(key)?.fingerprint === "acted" && !matchedKeys.has(key));
    if (lapsed.length > 0 && !dryRun) await env.store.unfire(workflow.id, lapsed);
    matched = matched.filter((one) => fired.get(one.key)?.fingerprint !== "acted");
  }

  matched = matched.filter((one) => allowed(one.key));
  for (const one of matched) {
    const before = fired.get(one.key);
    const print = isApiTrigger(trigger) ? prints.get(one.key)! : workflow.once === "per-row" ? "acted" : (before?.fingerprint ?? "");
    marks.set(one.key, { before, next: { fingerprint: print, count: (before?.count ?? 0) + 1, lastAt: at } });
  }
  return { seeding: false, expired: false, matched, marks, seen: seenOnly };
};

/** Run a workflow's trigger once: open a case for each record it should act on. */
export const runTrigger = async (env: WorkflowEnv, engine: WorkflowEngine, workflow: WorkflowSpec, options: RunOptions): Promise<RunResult> => {
  const inputs = options.inputs ?? {};
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
    startedAt: new Date(env.now()).toISOString(),
    status: "running",
    read: 0,
    matched: 0,
    cases: [],
    complete: true,
    summary: "",
  };
  await env.store.putRun(started);
  const finish = async (patch: Partial<WorkflowRun>): Promise<WorkflowRun> => {
    const done: WorkflowRun = { ...started, ...patch, finishedAt: new Date(env.now()).toISOString() };
    await env.store.putRun(done);
    env.onEvent?.({ type: "workflow.run", workflow: workflow.id, run: done.id, status: done.status, cases: done.cases.length });
    return done;
  };
  const amend = async (change: (held: WorkflowSpec) => WorkflowSpec): Promise<void> => {
    const held = await env.store.get(workflow.id);
    if (held) await env.store.put(change(held));
  };
  const countFailure = async (message: string): Promise<void> => {
    let turnedOff = false;
    await amend((held) => {
      const failures = held.failures + 1;
      turnedOff = failures >= MAX_FAILURES;
      return { ...held, failures, ...(turnedOff ? { enabled: false, parked: { reason: `Failed ${MAX_FAILURES} runs in a row. The last: ${message}`, at: new Date(env.now()).toISOString() } } : {}) };
    });
    if (turnedOff) env.onEvent?.({ type: "workflow.parked", workflow: workflow.id, reason: message });
  };

  try {
    if (agentId && !agent) throw new ParkWorkflow(`The agent "${agentId}" that started it no longer exists.`);
    if (agent?.archived) throw new ParkWorkflow(`${agent.name} is archived.`);
    const gathered = await gather(env, workflow, actor, agent);
    const selected = await select(env, workflow, gathered, inputs, false);
    if (selected.seen.length > 0) await env.store.markFired(workflow.id, selected.seen);
    if (selected.seeding) {
      return {
        run: await finish({
          status: "seeded",
          read: gathered.read,
          complete: gathered.complete,
          summary: selected.baselinePartial
            ? `Took note of ${plural(gathered.rows.length, "existing record")}, but not every record was reached. It keeps taking note until one read reaches them all; nothing starts it until then.`
            : `Took note of ${plural(gathered.rows.length, "existing record")}. From now on, only ${workflow.trigger.kind === "record_created" ? "new ones" : "changes"} start it.`,
        }),
      };
    }
    if (selected.expired) return { run: await finish({ status: "succeeded", summary: "The trigger has expired, so nothing was started." }) };

    const cases: string[] = [];
    let failedCases = 0;
    for (const one of selected.matched) {
      const mark = one.key ? selected.marks.get(one.key) : undefined;
      /* Claimed first: another run that got here first has it, and this one leaves it. */
      if (mark && !(await env.store.claimFired(workflow.id, one.key, mark.before, mark.next))) continue;
      let opened: Awaited<ReturnType<WorkflowEngine["open"]>>;
      try {
        opened = await engine.open(workflow, {
          /* One id per claim: opening again after an interruption opens the same case. */
          ...(mark ? { id: `c-${caseIdFor(workflow.id, one.key, mark.next.count)}` } : {}),
          row: one.row,
          ...(one.key ? { rowKey: one.key } : {}),
          inputs: { ...inputs },
          start: options.start,
          run: started.id,
          actor,
        });
      } catch (error) {
        /* Not opened: the record is given back, to be tried again next time. */
        if (mark) {
          if (mark.before === undefined) await env.store.unfire(workflow.id, [one.key]);
          else await env.store.claimFired(workflow.id, one.key, mark.next, mark.before);
        }
        throw error;
      }
      cases.push(opened.id);
      if (opened.status === "failed") failedCases++;
    }

    const summary = workflowReads(workflow)
      ? `${selected.matched.length} of ${plural(gathered.read, "record")} matched${gathered.complete ? "" : " (not every record was reached)"} · ${plural(cases.length, "case")} opened`
      : `${plural(cases.length, "case")} opened`;
    const patch = { read: gathered.read, matched: selected.matched.length, cases, complete: gathered.complete, summary };
    if (cases.length > 0 && failedCases === cases.length) {
      await countFailure("Every case failed.");
      return { run: await finish({ status: "failed", error: "Every case failed.", ...patch }) };
    }
    if (workflow.failures > 0) await amend((held) => ({ ...held, failures: 0 }));
    return { run: await finish({ status: "succeeded", ...patch }) };
  } catch (error) {
    if (error instanceof ParkWorkflow) {
      await amend((held) => ({ ...held, parked: { reason: error.reason, at: new Date(env.now()).toISOString() } }));
      env.onEvent?.({ type: "workflow.parked", workflow: workflow.id, reason: error.reason });
      return { run: await finish({ status: "parked", error: error.reason, summary: `Paused: ${error.reason}` }) };
    }
    const status = refusal(error);
    if (status !== undefined) {
      const source = workflowReads(workflow);
      const reason = `${source ? (env.connectionTitle?.(source.connection) ?? source.connection) : "The API"} refused the read (${status}). Check its key or what it may read.`;
      await amend((held) => ({ ...held, parked: { reason, at: new Date(env.now()).toISOString() } }));
      env.onEvent?.({ type: "workflow.parked", workflow: workflow.id, reason });
      return { run: await finish({ status: "parked", error: reason, summary: `Paused: ${reason}` }) };
    }
    if (error instanceof AdapterError && error.status === 429) {
      const waitMs = retryAfterMs(error.retryAfter, env.now()) ?? 60_000;
      return { run: await finish({ status: "failed", error: error.userMessage, summary: "Asked to wait by the API; trying again later." }), waitMs };
    }
    const message = error instanceof AdapterError ? error.userMessage : error instanceof Error ? error.message : String(error);
    await countFailure(message);
    return { run: await finish({ status: "failed", error: message, summary: `Failed: ${message}` }) };
  }
};

/* ── preview ───────────────────────────────────────────────────────────── */

export interface PathStep {
  readonly node: string;
  readonly name: string;
  readonly mode: WorkflowStepMode;
  /** Why the known path ends here: it waits, or a model decides. */
  readonly stops?: string | undefined;
  readonly skipped?: boolean | undefined;
}

export interface WorkflowPreview {
  readonly read: number;
  readonly complete: boolean;
  readonly seeding: boolean;
  readonly matched: number;
  /** Matched records, each with the path it would take; the first few. */
  readonly rows: ReadonlyArray<{ readonly key: string; readonly fields: Readonly<Record<string, unknown>>; readonly path: readonly PathStep[] }>;
  readonly problem?: string | undefined;
}

const PREVIEW_ROWS = 25;
const PREVIEW_FIELDS = 8;
const PREVIEW_STEPS = 30;

/**
 * The path a record would take, as far as can be known without running it:
 * conditions and branches are worked out from the record; a wait, a question
 * or a model's choice is where the known path ends.
 */
export const pathFor = (workflow: WorkflowSpec, row: Record<string, unknown>, inputs: Readonly<Record<string, unknown>>, now: number): PathStep[] => {
  const scope = { ...row, input: inputs, steps: {}, vars: {} };
  const path: PathStep[] = [];
  let at = firstNode(workflow);
  const visits = new Map<string, number>();
  while (at && path.length < PREVIEW_STEPS) {
    const node = workflow.nodes.find((one) => one.id === at);
    if (!node) break;
    const count = (visits.get(node.id) ?? 0) + 1;
    visits.set(node.id, count);
    const mode = nodeMode(node, workflow.trial > 0);
    if (count > 2) {
      path.push({ node: node.id, name: nodeName(node), mode, stops: "loops back here" });
      break;
    }
    if (node.when && !passes(node.when, scope, now)) {
      path.push({ node: node.id, name: nodeName(node), mode, skipped: true });
      at = nextNode(workflow, node.id, "next");
      continue;
    }
    const variant = actionVariant(node.action);
    let outcome = "next";
    if (variant?.id === "branch.if") outcome = passes(String(node.settings["condition"] ?? ""), scope, now) ? "yes" : "no";
    else if (variant?.id === "branch.switch") {
      let value = "";
      try {
        value = renderText(String(node.settings["value"] ?? ""), scope, now);
      } catch {
        /* Not known before it runs. */
      }
      const cases = ((node.settings["cases"] as string[] | undefined) ?? []).map((one) => one.trim());
      outcome = cases.find((one) => one.toLowerCase() === value.trim().toLowerCase()) ?? "otherwise";
    } else if (variant && (variant.base === "wait" || variant.base === "ask" || variant.id === "think.classify")) {
      path.push({ node: node.id, name: nodeName(node), mode, stops: variant.base === "think" ? "a model decides" : variant.base === "ask" ? "waits for an answer" : "waits" });
      break;
    }
    path.push({ node: node.id, name: nodeName(node), mode });
    at = nextNode(workflow, node.id, outcome);
  }
  return path;
};

const fieldsOf = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row)
      .filter(([, value]) => value === null || typeof value !== "object")
      .slice(0, PREVIEW_FIELDS),
  );

/** A dry run, as the person asking: what it would read, which records match, and the path each would take. Nothing is written. */
export const previewWorkflow = async (env: WorkflowEnv, workflow: WorkflowSpec, actor: Principal, inputs: Readonly<Record<string, unknown>> = {}): Promise<WorkflowPreview> => {
  let gathered: Gathered;
  try {
    gathered = await gather(env, workflow, actor, null);
  } catch (error) {
    const problem = error instanceof ParkWorkflow ? error.reason : error instanceof AdapterError ? error.userMessage : error instanceof Error ? error.message : String(error);
    return { read: 0, complete: false, seeding: false, matched: 0, rows: [], problem };
  }
  const selected = await select(env, workflow, gathered, inputs, true);
  const now = env.now();
  return {
    read: gathered.read,
    complete: gathered.complete,
    seeding: selected.seeding,
    matched: selected.matched.length,
    rows: selected.matched.slice(0, PREVIEW_ROWS).map((one) => ({ key: one.key, fields: fieldsOf(one.row), path: pathFor(workflow, one.row, inputs, now) })),
  };
};
