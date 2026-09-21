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
import { briefCandidates, writeBrief } from "@freebirdai/dash-agent";
import type {
  CatalogEntry,
  EntitySpec,
  ResourceSpec,
  WidgetBrief,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import { compileBrief } from "@freebirdai/dash-spec";
import { loadEnvFile } from "../env.js";
import { llmForModel, llmSpend, resetLlmSpend } from "../llm.js";
import { TIER_MODELS } from "../models.js";
import { formatUsd } from "../pricing.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile({ startDir: here });

const root = resolve(process.env.DASH_ROOT ?? join(here, "..", ".."));

/* ── the brief, which is how a widget is decided ──────────────────────────
 *
 * The only path there is. The model writes a *brief* over the record types an
 * API has been described as having, and a deterministic compiler turns it into
 * a widget — so what is being measured here is whether a model can name the
 * right records and say what the widget is for, never whether it can assemble
 * a pipeline.
 *
 * All three are the failures that started the rewrite, and none of them is
 * hypothetical:
 *
 *   - "tasks with a filter by category" was answered with a bar chart of task
 *     counts, because the older proposal had no way to say "a filter".
 *   - "how many X per Y" must still be a chart — the fix must not turn every
 *     request into a list.
 *   - "maintenance tasks" baked an invisible pipeline filter, so the reader
 *     could neither see the narrowing nor undo it.
 *
 * Properties, not exact answers, for the same reason as above: a model that
 * filters on a different but equally good category field has not regressed.
 */

interface BriefOutcome {
  readonly brief: WidgetBrief | null;
  readonly widget: WidgetSpec | null;
  readonly notes: readonly string[];
}

interface BriefScenario {
  readonly name: string;
  readonly intent: string;
  readonly check: (outcome: BriefOutcome) => string | null;
}

/** True where the pipeline turns records into buckets — i.e. a measurement. */
const aggregated = (widget: WidgetSpec | null): boolean =>
  (widget?.pipeline ?? []).some((step) => step.op === "group");

const BRIEF_SCENARIOS: readonly BriefScenario[] = [
  {
    name: "a filter means a filter, not a chart",
    intent: "show me tasks with a filter by category",
    check: ({ widget }) => {
      if (!widget) return "no widget was built";
      if (aggregated(widget)) return "answered a request for records with a measurement";
      const facets = widget.facets ?? [];
      if (facets.length === 0) return "records, but with no filter strip at all";
      return null;
    },
  },
  {
    name: "a count is still a count",
    intent: "how many tasks are there per category?",
    check: ({ widget }) => {
      if (!widget) return "no widget was built";
      // The fix for the case above must not swallow this one.
      return aggregated(widget) ? null : "answered a request for counts with a plain list";
    },
  },
  {
    name: "a narrowing phrase is visible and reversible",
    intent: "maintenance tasks",
    check: ({ widget }) => {
      if (!widget) return "no widget was built";
      if (aggregated(widget)) return "answered a request for records with a measurement";
      const preselected = (widget.facets ?? []).filter((facet) => (facet.default ?? []).length > 0);
      if (preselected.length > 0) return null;
      /*
       * The failure worth naming precisely. A baked `filter` step narrows the
       * widget invisibly — the reader sees a short list and no way to widen
       * it — which is what this path exists to stop.
       */
      const baked = widget.pipeline.some((step) => step.op === "filter");
      return baked
        ? "narrowed with an invisible pipeline filter instead of a preselected strip"
        : "not narrowed at all";
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

/**
 * The record types on disk, and the resource each sits on.
 *
 * Read from the catalog rather than from a connection: a brief is written over
 * what the API *is*, which is the shared artifact, and needs no account.
 */
const buildRoster = (): { entities: EntitySpec[]; resources: ResourceSpec[] } => {
  const maps = readDir<CatalogEntry>(join(root, ".dash", "catalog"));
  const described = maps.filter((entry) => (entry.entities?.length ?? 0) > 0);
  return {
    entities: described.flatMap((entry) => entry.entities ?? []),
    resources: described.flatMap((entry) => entry.resources),
  };
};

const runBrief = async (
  model: string,
  scenario: BriefScenario,
  roster: { entities: EntitySpec[]; resources: ResourceSpec[] },
): Promise<{ ok: boolean; why: string; usd: number }> => {
  const llm = llmForModel(model, "widget");
  if (!llm) return { ok: false, why: `no key for ${model}`, usd: 0 };

  const before = llmSpend().usd;
  try {
    const written = await writeBrief(llm, {
      intent: scenario.intent,
      candidates: briefCandidates([
        { connection: "eval", title: "the API", entities: roster.entities },
      ]),
    });
    if (!written.brief) {
      return { ok: false, why: written.error || "no brief was written", usd: llmSpend().usd - before };
    }

    const entity = roster.entities.find((one) => one.id === written.brief!.entity);
    const resource = entity
      ? roster.resources.find((one) => one.id === entity.resource)
      : undefined;
    if (!entity || !resource) {
      return {
        ok: false,
        why: `chose "${written.brief.entity}", which is not a record type this API has`,
        usd: llmSpend().usd - before,
      };
    }

    /*
     * Compiled, not inspected as a bare brief — for the same reason the older
     * scenarios go through `revise`. Half of what this measures is whether the
     * answer *survives* the compiler: a filter field the model got right and
     * `compileBrief` then dropped as unbindable is exactly the bug worth
     * catching, and it is invisible in the brief alone.
     */
    const compiled = compileBrief({
      brief: written.brief,
      entity,
      resource,
      connection: "eval",
      id: "eval",
    });

    const why = scenario.check({
      brief: written.brief,
      widget: compiled.widget,
      notes: compiled.notes,
    });
    return {
      ok: why === null,
      why:
        why ??
        (compiled.notes.length > 0 ? `passed, with notes: ${compiled.notes.join("; ")}` : ""),
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

  const roster = buildRoster();
  console.info(
    `${roster.entities.length} record types over ${roster.resources.length} resources — from ${root}
`,
  );
  if (roster.entities.length === 0) {
    console.info(
      "No record types are described, so there is nothing to write a brief over; describe an API first.",
    );
    return;
  }

  resetLlmSpend();
  const failures: string[] = [];

  for (const model of models) {
    console.info(`── ${model} ${"─".repeat(Math.max(0, 56 - model.length))}`);
    let total = 0;
    const report = (name: string, result: { ok: boolean; why: string; usd: number }): void => {
      total += result.usd;
      console.info(
        `  ${result.ok ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${formatUsd(result.usd).padStart(9)}` +
          (result.why ? `
        ${result.why}` : ""),
      );
      if (!result.ok) failures.push(`${model}: ${name}`);
    };

    for (const scenario of BRIEF_SCENARIOS) {
      report(scenario.name, await runBrief(model, scenario, roster));
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
