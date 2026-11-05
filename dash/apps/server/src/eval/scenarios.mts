/**
 * `pnpm eval:scenarios [--pack outbound] [--split dev|heldout|all] [--json]`
 *
 * Plays the built-in scenario packs in a sandbox, scripted, and scores each
 * run. Spends nothing and reaches nothing: CI runs it on every pull request.
 * See `dash/bench/PROTOCOL.md` ("Agent-behaviour scenarios").
 *
 * Exits 1 when any rule check fails. Judge checks are `unsure` here: they
 * need a model, and judges never gate.
 */
import { scenarioSchema, type EvalRun } from "@freebirdai/dash-spec";
import { PACKS } from "../evals/packs/index.js";
import { describeRun, runScenario } from "../evals/runner.js";

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

const runs: EvalRun[] = [];
let failed = 0;
for (const [name, pack] of Object.entries(PACKS)) {
  if (packName && name !== packName) continue;
  for (const input of pack) {
    const scenario = scenarioSchema.parse(input);
    if (split !== "all" && scenario.split !== split) continue;
    const run = await runScenario(scenario);
    runs.push(run);
    failed += run.verdicts.filter((verdict) => verdict.result === "fail").length;
    if (!json) console.log(`${describeRun(run, scenario)}\n`);
  }
}

if (json) console.log(JSON.stringify(runs, null, 2));
else console.log(`${runs.length} scenario${runs.length === 1 ? "" : "s"}, ${failed} failed check${failed === 1 ? "" : "s"}.`);
process.exit(failed > 0 ? 1 : 0);
