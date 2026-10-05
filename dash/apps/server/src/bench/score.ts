import {
  AdapterError,
  DependentAdapter,
  RestAdapter,
  isIncompleteNote,
  type FetchMeta,
  type FetchResult,
  type SourceAdapter,
} from "@freebirdai/connect/adapters";
import { OAuthRetryAdapter, RateLimitWaitAdapter } from "@freebirdai/connect/auth/retry-adapter";
import { ConnectorAdapter } from "@freebirdai/connect/connector/adapter";
import { LongReads } from "@freebirdai/connect/jobs/long-reads";
import { MemoryJobStore } from "@freebirdai/connect/jobs/store";
import { benchConnectors } from "./connectors.js";
import { executeWidget } from "@freebirdai/dash-runtime";
import { getOp, paramsForWidget, resolveRange, type ConnectionSpec, type OpSpec, type ResolvedParams } from "@freebirdai/dash-spec";
import type { BenchTransport } from "./transport.js";
import type {
  Completeness,
  IntegrationOutcome,
  InterventionKind,
  MockProvider,
  Objective,
  ScenarioScore,
} from "./types.js";

/**
 * Score one integration against its answer key.
 *
 * The widget is run here, by the benchmark, the same way for every
 * integrator: one read through the real REST adapter, then the real runtime.
 * What the integrator claimed about its own result is not taken on trust.
 */
/** A read carried on past its own limit, through `LongReads` itself, to its end. */
const carriedOn = async (input: {
  readonly connection: ConnectionSpec;
  readonly op: OpSpec;
  readonly overrides: Readonly<Record<string, string | number | boolean>>;
  readonly params: ResolvedParams;
  readonly first: FetchResult;
  readonly now: number;
  readonly adapter: SourceAdapter;
  readonly resolveSecret: (keyRef: string) => Promise<string | null>;
}): Promise<{ readonly result: FetchResult; readonly notes: readonly string[] }> => {
  if (!input.first.meta.continuation) return { result: input.first, notes: [] };
  let whole: FetchResult | null = null;
  const notes: string[] = [];
  const reads = new LongReads({
    store: new MemoryJobStore(),
    getConnection: () => input.connection,
    read: (connection, op, overrides, ctx) => input.adapter.fetch(connection, op, overrides, { ...ctx, resolveSecret: input.resolveSecret }),
    answer: async (_key, _connection, result) => {
      whole = result;
    },
    now: () => input.now,
    log: (line) => notes.push(line),
  });
  await reads.carryOn({ key: "bench", connection: input.connection, op: input.op, overrides: input.overrides, resolved: input.params, first: input.first });
  await reads.idle();
  /* Left waiting or blocked: what stopped it, for the report. */
  for (const left of await reads.list()) notes.push(`carrying on stopped (${left.status.state}): ${left.status.error ?? "no reason given"}`);
  reads.stop();
  return { result: whole ?? input.first, notes };
};

export const scoreOutcome = async (input: {
  provider: MockProvider;
  objective: Objective;
  integrator: string;
  outcome: IntegrationOutcome;
  transport: BenchTransport;
  now: number;
  startedAt: number;
}): Promise<ScenarioScore> => {
  const { provider, objective, outcome } = input;
  const interventions: Record<InterventionKind, number> = {
    technical: 0,
    intent: 0,
    consent: 0,
    account: 0,
  };
  for (const one of outcome.interventions) interventions[one.kind]++;

  const base = {
    provider: provider.id,
    objective: objective.id,
    split: provider.split,
    integrator: input.integrator,
    interventions,
    expected: objective.answer,
    records: objective.records,
    modelCalls: outcome.modelCalls,
  };
  const finish = (rest: Omit<ScenarioScore, keyof typeof base | "requests" | "ms" | "success">): ScenarioScore => {
    const score = {
      ...base,
      ...rest,
      requests: input.transport.apiRequests(),
      ms: Date.now() - input.startedAt,
    };
    const success =
      score.setup === "done" &&
      interventions.technical === 0 &&
      score.retrieval === "ok" &&
      score.completeness === "complete" &&
      score.metric === "correct";
    /* Kept on a failure, and wherever a model was used — how it got there is part of what it cost. */
    const keepLog = !success || outcome.modelCalls > 0;
    return { ...score, ...(keepLog ? { log: outcome.notes.slice(-40).map((line) => line.slice(0, 1_000)) } : {}), success };
  };

  if (!outcome.connection || !outcome.widget || outcome.stoppedAt) {
    return finish({
      setup: `stopped:${outcome.stoppedAt ?? "unknown"}`,
      retrieval: "none",
      completeness: "n/a",
      metric: "n/a",
      value: null,
      recordsRead: null,
      flagged: [],
      error: outcome.notes[outcome.notes.length - 1],
    });
  }

  const connection = outcome.connection;
  const source = outcome.widget.source;
  const op = source ? getOp(connection, source.op) : undefined;
  if (!op) {
    return finish({
      setup: "stopped:build",
      retrieval: "none",
      completeness: "n/a",
      metric: "n/a",
      value: null,
      recordsRead: null,
      flagged: [],
      error: "The widget reads an endpoint the connection does not carry.",
    });
  }

  /* The board's window, or the widget's own where its request named a time — as a board reads it. */
  const params = paramsForWidget(outcome.widget, { range: resolveRange({ preset: "30d", now: input.now }), filters: {} }, input.now);
  let body: unknown;
  let meta: FetchMeta;
  let ended: string | undefined;
  try {
    /*
     * Read the way a board does: through the connection's connector when it
     * has one — a fresh run, with no session kept from integrating — and a
     * live token for OAuth, renewed once after a refusal.
     */
    const kit = benchConnectors(input.now);
    const rest = connection.connector
      ? new ConnectorAdapter(input.transport.http, kit)
      : new RateLimitWaitAdapter(new RestAdapter(input.transport.http));
    /* An input another endpoint's records supply is read as the server reads it, outermost. */
    const adapter: SourceAdapter = new DependentAdapter(outcome.broker ? new OAuthRetryAdapter(rest, outcome.broker) : rest);
    /* With what the widget asks of the API, as a board sends it: a confirmed filter, say. */
    const overrides = source?.params ?? {};
    const resolveSecret = outcome.broker
      ? outcome.broker.resolve
      : async (keyRef: string) => outcome.secrets[keyRef] ?? null;
    const result = await adapter.fetch(connection, op, overrides, { params, now: input.now, resolveSecret });
    /*
     * Stopped at its own limit with more to read: carried on as the server
     * carries it on, from where it stopped, and the whole answer scored once
     * it reaches its end.
     */
    const whole = await carriedOn({ connection, op, overrides, params, first: result, now: input.now, adapter, resolveSecret });
    body = whole.result.body;
    meta = whole.result.meta;
    const how = (one: FetchMeta) => (one.completion ? `${one.completion.state}:${one.completion.reason}` : "unsaid");
    ended = [how(result.meta), ...(whole.notes.length > 0 || whole.result !== result ? [`carried on → ${how(meta)}`, ...whole.notes] : [])].join("; ");
  } catch (error) {
    return finish({
      setup: "done",
      retrieval: "error",
      completeness: "n/a",
      metric: "n/a",
      value: null,
      recordsRead: null,
      flagged: [],
      error:
        error instanceof AdapterError
          ? `${error.status}: ${error.userMessage ?? error.message}`
          : String(error),
    });
  }

  const executed = executeWidget(outcome.widget, body, { now: input.now, params });
  const extracted = executed.meta?.steps.find((step) => step.op === "extract")?.rowsOut ?? null;
  const said = meta.warnings.filter(isIncompleteNote);
  const flagged = meta.truncated && said.length === 0 ? ["Not every page was read."] : said;
  /*
   * A read the widget narrows through the API's own filter holds fewer records
   * than the collection by design. It is complete when nothing cut it short
   * and any count the API gave matches; whether it read the right records is
   * the answer key's to say (PROTOCOL.md).
   */
  /*
   * Or narrowed to the one record the request names, through an input another
   * list supplies — "the Marketing workspace" — settled by the check
   * (`ParamDef.valueFrom`). As with an API filter, the
   * read holds fewer records than the collection by design.
   */
  const settled = op.params.some((param) => param.valueFrom && !param.valueFrom.each && param.default !== undefined);
  const askedApi = Object.keys(source?.params ?? {}).length > 0 || settled;
  const wholeScope =
    askedApi &&
    extracted !== null &&
    !meta.truncated &&
    flagged.length === 0 &&
    (meta.reportedTotal === undefined || meta.reportedTotal === extracted);
  /*
   * The API's own count, where a read confirmed the endpoint counts these
   * records: one answer, complete when nothing cut it short (PROTOCOL.md).
   */
  const counted =
    connection.resources.some((resource) => resource.count?.op === op.id) &&
    !meta.truncated &&
    flagged.length === 0;
  /*
   * A read that went to its end over more records than the objective counts —
   * every issue, where the question is about one project's — holds every
   * record asked about; the widget narrows to them (PROTOCOL.md, 2026-10-03).
   */
  const throughWider =
    meta.completion?.state === "traversed" &&
    !meta.truncated &&
    flagged.length === 0 &&
    extracted !== null &&
    extracted >= objective.records;
  const completeness: Completeness =
    extracted === objective.records || wholeScope || counted || throughWider
      ? "complete"
      : flagged.length > 0
        ? "incomplete-flagged"
        : "incomplete-silent";
  const caveats = [
    ...(executed.meta?.warnings ?? []).filter((warning) => !isIncompleteNote(warning)),
    /* The tile's own sentence says a number is only what falls in the board's range. */
    ...(outcome.widget.metric?.window === "board" ? [outcome.widget.metric.says] : []),
  ];
  const raw = executed.rows[0]?.value;
  const value = typeof raw === "number" ? raw : null;

  return finish({
    setup: "done",
    retrieval: executed.ok ? "ok" : "error",
    completeness,
    metric: value !== null && Math.abs(value - objective.answer) <= objective.tolerance ? "correct" : "wrong",
    value,
    recordsRead: extracted,
    flagged,
    ...(caveats.length > 0 ? { said: caveats } : {}),
    ...(executed.ok ? {} : { error: executed.errors.join("; ") }),
    ...(ended ? { ended } : {}),
  });
};
