/**
 * `pnpm bench [--integrator agent|baseline] [--split dev|heldout] [--checkpoint <name>] [--live] [--only a,b]`
 *
 * Runs the onboarding benchmark and writes its report to `dash/bench/results/`.
 * See `dash/bench/PROTOCOL.md` for what is measured and when each split runs.
 *
 * - The dev split with scripted choices is what CI runs, offline and free.
 * - The held-out split runs only at a checkpoint, and must be named as one.
 * - `--live` swaps each provider's scripted model for the configured one.
 *   It spends real tokens and is run by hand.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../env.js";
import { defaultModelId, llmForModel } from "../llm.js";
import { agentIntegrator, baselineIntegrator } from "./integrator.js";
import { reportMarkdown, runSuite } from "./run.js";
import type { Split } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const split = (flag("split") ?? "dev") as Split;
if (split !== "dev" && split !== "heldout" && split !== "real") throw new Error(`unknown split "${split}"`);
const checkpoint = flag("checkpoint");
if (split === "heldout" && !checkpoint) {
  console.error(
    "The held-out split runs only at a checkpoint. Name it: --checkpoint \"<name>\". See dash/bench/PROTOCOL.md.",
  );
  process.exit(2);
}
const live = args.includes("--live");
/* The integrator chooses the endpoint and the measure itself, through the product's brief path. */
const unscripted = args.includes("--unscripted");
const which = flag("integrator") ?? "agent";
if (which !== "agent" && which !== "baseline") throw new Error(`unknown integrator "${which}"`);
const only = flag("only")?.split(",");
/* Real APIs are documented in prose, read with a model, and reached over the network: by hand, with a model. */
if (split === "real" && !live) {
  console.error("The real split reads real documentation with a model: run it with --live. It reaches the network.");
  process.exit(2);
}

let llm = null;
let model = "scripted per provider";
if (live) {
  loadEnvFile({ startDir: here });
  const id = defaultModelId(null);
  llm = id ? llmForModel(id, "discover") : null;
  if (!llm) {
    console.error("--live needs an AI key (ANTHROPIC_API_KEY or OPENAI_API_KEY).");
    process.exit(2);
  }
  model = id!;
}

const scores = await runSuite({
  split,
  integrator: () => (which === "agent" ? agentIntegrator() : baselineIntegrator()),
  scripted: !unscripted,
  ...(live ? { llm } : {}),
  ...(only ? { only } : {}),
});

const date = new Date().toISOString();
const report = reportMarkdown(scores, {
  split,
  integrator: which,
  scripted: !unscripted,
  model,
  date,
  ...(checkpoint ? { checkpoint } : {}),
});
const results = resolve(here, "..", "..", "..", "..", "bench", "results");
mkdirSync(results, { recursive: true });
/*
 * A run of some providers says so in its name, and no run replaces another's
 * file: a result is a record, and a second run the same day — or a partial one
 * — once overwrote the only copy of a checkpoint's run.
 */
const base = `${date.slice(0, 10)}-${split}-${which}${checkpoint ? `-${checkpoint.replace(/[^a-z0-9]+/gi, "-")}` : ""}${
  only ? `-only-${only.join("-").replace(/[^a-z0-9-]+/gi, "-")}` : ""
}${unscripted ? "-unscripted" : ""}${live ? "-live" : ""}`;
let stem = base;
for (let copy = 2; existsSync(join(results, `${stem}.md`)) || existsSync(join(results, `${stem}.json`)); copy++)
  stem = `${base}-${copy}`;
writeFileSync(join(results, `${stem}.md`), report);
writeFileSync(join(results, `${stem}.json`), JSON.stringify(scores, null, 2));
console.log(report);
console.log(`Written to ${join(results, `${stem}.md`)}`);
