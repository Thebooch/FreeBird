import { AdapterError, RestAdapter, isIncompleteNote, type FetchMeta, type SourceAdapter } from "@freebirdai/dash-adapters";
import { OAuthRetryAdapter } from "../auth/retry-adapter.js";
import { ConnectorAdapter } from "../connector/adapter.js";
import { benchConnectors } from "./connectors.js";
import { executeWidget } from "@freebirdai/dash-runtime";
import { getOp, resolveRange } from "@freebirdai/dash-spec";
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

  const params = { range: resolveRange({ preset: "30d", now: input.now }), filters: {} };
  let body: unknown;
  let meta: FetchMeta;
  try {
    /*
     * Read the way a board does: through the connection's connector when it
     * has one — a fresh run, with no session kept from integrating — and a
     * live token for OAuth, renewed once after a refusal.
     */
    const kit = benchConnectors(input.now);
    const rest = connection.connector
      ? new ConnectorAdapter(input.transport.http, kit)
      : new RestAdapter(input.transport.http);
    const adapter: SourceAdapter = outcome.broker ? new OAuthRetryAdapter(rest, outcome.broker) : rest;
    const result = await adapter.fetch(connection, op, {}, {
      params,
      now: input.now,
      resolveSecret: outcome.broker
        ? outcome.broker.resolve
        : async (keyRef) => outcome.secrets[keyRef] ?? null,
    });
    body = result.body;
    meta = result.meta;
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
  const completeness: Completeness =
    extracted === objective.records ? "complete" : flagged.length > 0 ? "incomplete-flagged" : "incomplete-silent";
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
    ...(executed.ok ? {} : { error: executed.errors.join("; ") }),
  });
};
