/**
 * Which model can actually do this, measured rather than argued about.
 *
 * Run by hand, never as a test. It spends real money and its answers are not
 * deterministic — a vitest file that costs dollars and fails on a coin-flip is
 * worse than no coverage at all. This exists because the last two "why did it
 * choose badly" investigations both ended at the model after a prompt rewrite
 * had already been tried, and the third one should start with a table.
 *
 *   pnpm eval:models                        both defaults
 *   pnpm eval:models claude-haiku-4-5,claude-sonnet-5
 *
 * It reads the connection, report and map already on disk and calls only the
 * two authoring calls, so it spends **model tokens and zero upstream requests**
 * — it can be run against an account whose credentials have been rate-limited,
 * or one whose key is not in the vault at all.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConciergeContext, ConciergeDraft, DraftPatch } from "@freebirdai/dash-agent";
import { newDraft, readiness, revise } from "@freebirdai/dash-agent";
import type { CapabilityReport, CatalogEntry, ConnectionSpec } from "@freebirdai/dash-spec";
import { buildConciergeContext } from "../concierge/context.js";
import { proposeSetup } from "../concierge/propose.js";
import { loadEnvFile } from "../env.js";
import { llmForModel, llmSpend, resetLlmSpend } from "../llm.js";
import { TIER_MODELS } from "../models.js";
import { formatUsd } from "../pricing.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile({ startDir: here });

const root = resolve(process.env.DASH_ROOT ?? join(here, "..", ".."));

/* ── scenarios ────────────────────────────────────────────────────────────
 *
 * Each asserts a *property* of the answer rather than one exact answer. A
 * model that binds a different but equally good field has not regressed, and
 * an eval that says it has will be ignored within a week.
 *
 * All three are things that were seen to fail by hand. Nothing speculative is
 * in here: an assertion nobody has watched fail is a guess about what matters.
 */

interface Outcome {
  readonly patch: DraftPatch;
  readonly draft: ConciergeDraft;
  readonly context: ConciergeContext;
  /** Every question still standing between this and a widget. */
  readonly questions: readonly string[];
}

interface Scenario {
  readonly name: string;
  readonly intent: string;
  /** What good looks like. Return null to pass, or a sentence saying why not. */
  readonly check: (outcome: Outcome) => string | null;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "counts records rather than plotting a number field",
    intent: "How many listings per month?",
    /*
     * The original report: this asked which numeric field to plot and offered
     * Rent or Deposit, for a question about how many records there are. The
     * shape is what fixed it; a model that does not state a count brings the
     * question straight back.
     */
    check: ({ patch, questions }) => {
      const measures = patch.shape?.measures ?? [];
      if (!measures.some((measure) => measure.agg === "count")) {
        return `no count measure — measures: ${JSON.stringify(measures)}`;
      }
      if (!(patch.shape?.groupBy ?? []).some((group) => Boolean(group.bucket))) {
        return "nothing is bucketed, so there is no per-month axis";
      }
      const asked = questions.find((question) => /value|number|plot|amount/i.test(question));
      return asked ? `still asks: "${asked}"` : null;
    },
  },
  {
    name: "picks the nested applications collection, not the applicants",
    intent: "Graph listings vs applications received per month",
    /*
     * Haiku 4.5 answered `applicants` — the people — where Sonnet 5 answered
     * `applicantapplications`. Counting the parents of a thing is not counting
     * the thing, and the widget renders perfectly either way, which is what
     * makes this worth an assertion rather than an eyeball.
     *
     * Asserted on the shape of the answer rather than one endpoint id: any
     * second series whose endpoint is about applications passes.
     */
    check: ({ patch }) => {
      const second =
        patch.seriesWith?.[0]?.endpoint ??
        patch.offerSeries?.endpoint ??
        patch.joinWith?.endpoint ??
        null;
      if (!second) return "only one endpoint — nothing to compare against";
      return /application/i.test(second) ? null : `second endpoint is "${second}"`;
    },
  },
  {
    name: "binds a nested field when the useful one is nested",
    intent: "Show me current listings",
    /*
     * Every top-level field on a listing is an id or a flag; the address a
     * person would identify it by is two levels down. Haiku left the title
     * unbound rather than reaching for one.
     */
    check: ({ patch }) => {
      const bound = Object.values(patch.roles ?? {}).flat();
      if (bound.length === 0) return "nothing bound to any role";
      return bound.some((field) => field.includes("."))
        ? null
        : `only top-level fields bound: ${bound.join(", ")}`;
    },
  },
];

/* ── the fixtures on disk ─────────────────────────────────────────────── */

const readJson = <T,>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const readDir = <T,>(dir: string): T[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<T>(join(dir, name)));
  } catch {
    return [];
  }
};

const buildContext = (): ConciergeContext => {
  const connections = readDir<ConnectionSpec>(join(root, "connections"));
  const reports = readDir<CapabilityReport>(join(root, "reports"));
  const maps = readDir<CatalogEntry>(join(root, ".dash", "catalog"));

  if (connections.length === 0) {
    throw new Error(
      `no connections under ${join(root, "connections")} — connect an API in the UI first, ` +
        "or point DASH_ROOT at an instance that has one",
    );
  }
  return buildConciergeContext({ connections, reports, maps });
};

/* ── one run ──────────────────────────────────────────────────────────── */

const run = async (
  model: string,
  scenario: Scenario,
  context: ConciergeContext,
): Promise<{ ok: boolean; why: string; usd: number }> => {
  const llm = llmForModel(model, "widget");
  if (!llm) return { ok: false, why: `no key for ${model}`, usd: 0 };

  const before = llmSpend().usd;

  try {
    const proposed = await proposeSetup({ llm, intent: scenario.intent, context });

    /*
     * Put through the real machine, not inspected as a bare patch.
     *
     * Half of what this is measuring is whether the answer *survives* — a
     * nested role the model got right and `revise` then rejected as "not one
     * of the choices" is the exact bug this harness would have caught, and it
     * is invisible in the patch alone.
     */
    const draft = newDraft("eval", scenario.intent, "assisted");
    const revised = revise(draft, proposed.patch, context);
    const state = readiness(revised.draft, context);

    const outcome: Outcome = {
      patch: proposed.patch,
      draft: revised.draft,
      context,
      questions: state.missing.map((piece) => piece.stepId),
    };

    const why = scenario.check(outcome);
    const rejected = revised.rejected.map((entry) => `${entry.stepId}=${entry.value}`);
    return {
      ok: why === null,
      why:
        why ??
        (rejected.length > 0 ? `passed, but ${rejected.length} rejected: ${rejected.join(", ")}` : ""),
      usd: llmSpend().usd - before,
    };
  } catch (cause) {
    return {
      ok: false,
      why: cause instanceof Error ? cause.message : String(cause),
      usd: llmSpend().usd - before,
    };
  }
};

/* ── the table ────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  const models = (process.argv[2] ?? `${TIER_MODELS.anthropic.fast},${TIER_MODELS.anthropic.capable}`)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const context = buildContext();
  console.info(
    `${context.ops.length} endpoints, ${context.children.length} nested collections, ` +
      `${Object.keys(context.shapes).length} shapes — from ${root}\n`,
  );

  resetLlmSpend();
  const failures: string[] = [];

  for (const model of models) {
    console.info(`── ${model} ${"─".repeat(Math.max(0, 56 - model.length))}`);
    let total = 0;
    for (const scenario of SCENARIOS) {
      const result = await run(model, scenario, context);
      total += result.usd;
      const mark = result.ok ? "PASS" : "FAIL";
      console.info(
        `  ${mark}  ${scenario.name.padEnd(52)} ${formatUsd(result.usd).padStart(9)}` +
          (result.why ? `\n        ${result.why}` : ""),
      );
      if (!result.ok) failures.push(`${model}: ${scenario.name}`);
    }
    console.info(`  ${" ".repeat(58)}${formatUsd(total).padStart(9)}\n`);
  }

  const spend = llmSpend();
  console.info(
    `${formatUsd(spend.usd)} across ${spend.calls} calls` +
      (spend.unpriced > 0 ? ` (${spend.unpriced} unpriced)` : ""),
  );

  /*
   * A non-zero exit on failure, and no apology for it.
   *
   * This is not run in CI and must not be — but somebody running it from a
   * script deserves to know, and a harness that always exits 0 teaches people
   * to stop reading its output.
   */
  if (failures.length > 0) {
    console.info(`\n${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
};

await main();
