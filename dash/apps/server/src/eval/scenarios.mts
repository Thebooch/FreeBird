/**
 * `pnpm eval:scenarios [--pack outbound] [--split dev|heldout|all] [--json]`
 * `pnpm eval:scenarios --live [--k 3] [--pack inbound] [--only <id>,<id>]`
 *
 * Plays the built-in scenario packs in a sandbox and scores each run. See
 * `dash/bench/PROTOCOL.md` ("Agent-behaviour scenarios").
 *
 * - Scripted (the default): the persona and the model are scripted, so a
 *   run spends nothing and reaches nothing. CI runs it on every pull
 *   request, and it exits 1 when any rule check fails. Judge checks are
 *   `unsure` here: they need a model, and judges never gate.
 * - `--live`: the configured model runs the workflows' own steps and
 *   another call plays the persona, k times each; it reports each check's
 *   pass rate and never fails the run. It spends real tokens and is run by
 *   hand or nightly, never in CI.
 */
import { scenarioSchema, type EvalRun } from "@freebirdai/dash-spec";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../env.js";
import { PACKS } from "../evals/packs/index.js";
import { describeRun, runLive, runScenario } from "../evals/runner.js";
import { defaultModelId, llmForModel } from "../llm.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const packName = flag("pack");
const split = flag("split") ?? "dev";
if (split !== "dev" && split !== "heldout" && split !== "all") throw new Error(`unknown split "${split}"`);
if (packName && !PACKS[packName]) throw new Error(`no pack "${packName}". Known: ${Object.keys(PACKS).join(", ")}`);
const json = args.includes("--json");
const live = args.includes("--live");
const k = Math.max(1, Number(flag("k") ?? 3) || 3);
const only = flag("only")?.split(",").map((one) => one.trim());

const scenarios = Object.entries(PACKS)
  .filter(([name]) => !packName || name === packName)
  .flatMap(([, pack]) => pack.map((input) => scenarioSchema.parse(input)))
  .filter((scenario) => (split === "all" || scenario.split === split) && (!only || only.includes(scenario.id)));

if (live) {
  loadEnvFile({ startDir: here });
  const id = defaultModelId(null);
  const system = id ? llmForModel(id, "think") : null;
  const persona = id ? llmForModel(id, "think") : null;
  if (!system || !persona) {
    console.error("--live needs an AI key (ANTHROPIC_API_KEY or OPENAI_API_KEY).");
    process.exit(2);
  }
  const results: Array<{ scenario: string; passRate: Record<string, number> }> = [];
  for (const scenario of scenarios) {
    const { passRate } = await runLive(scenario, { k, live: { system, persona } });
    results.push({ scenario: scenario.id, passRate });
    if (!json) {
      console.log(`${scenario.name} (${scenario.id}), ${k} live run${k === 1 ? "" : "s"}`);
      for (const [check, rate] of Object.entries(passRate)) console.log(`  ${Number.isNaN(rate) ? "unsure".padEnd(8) : `${Math.round(rate * 100)}%`.padEnd(8)} ${check}`);
      console.log("");
    }
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

const runs: EvalRun[] = [];
let failed = 0;
for (const scenario of scenarios) {
  const run = await runScenario(scenario);
  runs.push(run);
  failed += run.verdicts.filter((verdict) => verdict.result === "fail").length;
  if (!json) console.log(`${describeRun(run, scenario)}\n`);
}

if (json) console.log(JSON.stringify(runs, null, 2));
else console.log(`${runs.length} scenario${runs.length === 1 ? "" : "s"}, ${failed} failed check${failed === 1 ? "" : "s"}.`);
process.exit(failed > 0 ? 1 : 0);
