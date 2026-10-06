import type { LlmAdapter } from "@freebirdai/dash-agent";
import { benchTooling } from "./integrator.js";
import { PROVIDERS, providersIn } from "@freebirdai/connect-bench";
import { BENCH_NOW } from "@freebirdai/connect-bench";
import { scoreOutcome } from "./score.js";
import { benchTransport, liveTransport } from "@freebirdai/connect-bench";
import type { Integrator, MockProvider, ScenarioScore, Split } from "./types.js";

/**
 * A model that answers from a provider's script, by tool name.
 *
 * A call the script has no answer for gets no tool call at all, which every
 * caller already treats as the model declining — so an unscripted step fails
 * the way a real refusal would, rather than being handed some other answer.
 */
export const scriptedModel = (answers: Readonly<Record<string, unknown>>): LlmAdapter => {
  const generate: LlmAdapter["generate"] = async (opts) => {
    const name =
      typeof opts.toolChoice === "object" && opts.toolChoice
        ? (opts.toolChoice as { name: string }).name
        : Object.keys(opts.tools ?? {})[0];
    if (!name || !(name in answers)) return { text: "", toolCalls: [] };
    return { text: "", toolCalls: [{ id: `scripted_${name}`, name, args: answers[name] }] };
  };
  return {
    defaultModel: "scripted",
    generate,
    stream: async function* (opts) {
      const result = await generate(opts);
      for (const call of result.toolCalls) yield { toolCall: call };
    },
  };
};

export interface SuiteOptions {
  readonly split: Split;
  readonly integrator: (provider: MockProvider) => Integrator;
  /** Give the integrator each objective's scripted choice. CI does; a judgment run does not. */
  readonly scripted: boolean;
  /** A real model for live runs; otherwise each provider's script. */
  readonly llm?: LlmAdapter | null;
  readonly only?: readonly string[];
}

/**
 * The account address the scenario's person would type, when asked for one:
 * the provider's own, or its reference connection's — the address of the
 * account the answer key was computed from. An account value, allowed and
 * counted (PROTOCOL.md); nothing else of the reference reaches an integrator.
 */
const accountAddressOf = (provider: MockProvider): string | undefined => {
  if (provider.accountAddress) return provider.accountAddress;
  const baseUrl = provider.reference?.connection.baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
};

export const runSuite = async (options: SuiteOptions): Promise<ScenarioScore[]> => {
  const scores: ScenarioScore[] = [];
  const providers = providersIn(options.split).filter(
    (provider) => !options.only || options.only.includes(provider.id),
  );
  for (const provider of providers) {
    /* Documentation only a browser can read, and no browser here: skipped, and said — never downloaded. */
    if (provider.needs === "browser" && benchTooling.status().state !== "ready") {
      console.warn(`Skipped ${provider.id}: its documentation is drawn by scripts, and Playwright's Chromium is not installed here.`);
      continue;
    }
    /*
     * A real API's answer keys hold only while its data is what the snapshot
     * says. Checked once per provider, before anything is scored.
     */
    const stale = provider.live && provider.freshness ? await provider.freshness(liveTransport([provider]).http).catch((error: unknown) => `the freshness check failed: ${error instanceof Error ? error.message : String(error)}`) : null;
    for (const objective of provider.objectives) {
      provider.reset?.();
      /* Only this provider is reachable: nothing can leak between scenarios. */
      const transport = provider.live
        ? liveTransport([provider])
        : benchTransport(PROVIDERS.filter((one) => one.id === provider.id));
      if (stale) {
        scores.push(
          await scoreOutcome({
            provider,
            objective,
            integrator: options.integrator(provider).id,
            outcome: { connection: null, widget: null, secrets: {}, interventions: [], notes: [`Stale answer key: ${stale}`], stoppedAt: "stale-key", modelCalls: 0 },
            transport,
            now: BENCH_NOW,
            startedAt: Date.now(),
          }),
        );
        continue;
      }
      const integrator = options.integrator(provider);
      const llm = options.llm !== undefined ? options.llm : scriptedModel(provider.scriptedModel ?? {});
      const startedAt = Date.now();
      const outcome = await integrator.integrate(
        {
          provider: provider.id,
          docsUrl: provider.docsUrl,
          credentials: provider.credentials,
          ...(provider.credentialLabels ? { credentialLabels: provider.credentialLabels } : {}),
          ...(accountAddressOf(provider) ? { accountAddress: accountAddressOf(provider)! } : {}),
          objective: {
            id: objective.id,
            request: objective.request,
            ...(options.scripted ? { scripted: objective.scripted } : {}),
          },
        },
        { http: transport.http, fetchDocument: transport.fetchDocument, llm, now: BENCH_NOW },
      );
      scores.push(
        await scoreOutcome({
          provider,
          objective,
          integrator: integrator.id,
          outcome,
          transport,
          now: BENCH_NOW,
          startedAt,
        }),
      );
    }
  }
  return scores;
};

/** Float noise such as 3591.2400000000002 does not reach a report. */
const cell = (value: unknown): string =>
  (typeof value === "number" && !Number.isInteger(value)
    ? String(Math.round(value * 10_000) / 10_000)
    : String(value ?? "—")
  )
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

/** The report: every dimension in its own column, and no single blended score. */
export const reportMarkdown = (
  scores: readonly ScenarioScore[],
  context: { split: Split; integrator: string; scripted: boolean; checkpoint?: string; model: string; date: string },
): string => {
  const count = (test: (score: ScenarioScore) => boolean) => scores.filter(test).length;
  const lines = [
    `# Benchmark: ${context.integrator}, ${context.split} split${context.checkpoint ? ` — ${context.checkpoint}` : ""}`,
    "",
    `- Date: ${context.date}`,
    `- Choices: ${context.scripted ? "scripted (measures mechanics, not judgment — see PROTOCOL.md)" : "the integrator's own"}`,
    `- Model: ${context.model}`,
    "",
    "| | Count |",
    "|---|---|",
    `| Scenarios | ${scores.length} |`,
    `| Task success | ${count((one) => one.success)} |`,
    `| Setup done | ${count((one) => one.setup === "done")} |`,
    `| With a technical intervention | ${count((one) => one.interventions.technical > 0)} |`,
    `| Retrieval ok | ${count((one) => one.retrieval === "ok")} |`,
    `| Complete | ${count((one) => one.completeness === "complete")} |`,
    `| Incomplete, and said so | ${count((one) => one.completeness === "incomplete-flagged")} |`,
    `| Incomplete, silently | ${count((one) => one.completeness === "incomplete-silent")} |`,
    `| Metric correct | ${count((one) => one.metric === "correct")} |`,
    `| Wrong, and said why | ${count((one) => one.metric === "wrong" && (one.flagged.length > 0 || (one.said?.length ?? 0) > 0))} |`,
    `| Wrong, silently | ${count((one) => one.metric === "wrong" && one.flagged.length === 0 && (one.said?.length ?? 0) === 0)} |`,
    "",
    "| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...scores.map((one) =>
      [
        one.provider,
        one.objective,
        one.setup,
        one.interventions.technical,
        one.retrieval,
        one.completeness,
        `${one.recordsRead ?? "—"} / ${one.records}`,
        one.metric,
        `${cell(one.value)} / ${cell(one.expected)}`,
        one.requests,
        one.modelCalls,
        one.error ?? one.flagged[0] ?? one.said?.[0] ?? "",
      ]
        .map(cell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    ),
    "",
  ];
  return lines.join("\n");
};
