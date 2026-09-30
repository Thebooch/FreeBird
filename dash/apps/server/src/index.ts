import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env.js";
import { TASKS } from "./models.js";
import { createLocalPlatform } from "./platform/local.js";
import { buildServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));

// Before anything reads configuration. Anchored to this file rather than the
// working directory, so `.env` is found the same way however the server is
// launched — from the repo root, from apps/server, or from an editor.
const envFile = loadEnvFile({ startDir: here });

/* Every plug-in point, built for this machine: see `platform/local.ts`. */
let local: Awaited<ReturnType<typeof createLocalPlatform>>;
try {
  local = await createLocalPlatform(here);
} catch (error) {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const { platform, root, stateDir, host, modelFor, llm, search } = local;
const app = buildServer(platform);
const port = Number(process.env.PORT ?? 4600);
/*
 * Close the embedded databases on the way out. A process killed while one is
 * open can leave its files damaged — the failure both database notices above
 * describe — and Ctrl+C or a service manager's stop is the ordinary way this
 * server ends. A hard kill still cannot be caught; this covers every stop that
 * can be.
 */
let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal}: closing`);
  void (async () => {
    await app.close().catch(() => undefined);
    await local.close();
    process.exit(0);
  })();
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

app
  .listen({ port, host })
  .then(() => {
    app.log.info(
      `dash server on :${port} — specs in ${root}, secrets in ${stateDir} (gitignored)`,
    );
    // Names only. A value here is a secret and never reaches the log.
    app.log.info(
      envFile.path
        ? `loaded ${envFile.path} (${envFile.applied.length} set${
            envFile.skipped.length > 0
              ? `, ${envFile.skipped.length} already in the environment: ${envFile.skipped.join(", ")}`
              : ""
          })`
        : "no .env file found — copy .env.example to .env to set keys",
    );
    /*
     * Named per task rather than as one model, because that is now what is
     * true — and a boot line claiming a single model would be the first thing
     * to mislead somebody debugging why one action behaves differently.
     */
    const byModel = new Map<string, string[]>();
    for (const task of TASKS) {
      const model = modelFor(task.id) ?? "none";
      byModel.set(model, [...(byModel.get(model) ?? []), task.id]);
    }
    app.log.info(
      llm("chat")
        ? `assistant enabled (${[...byModel]
            .map(([model, tasks]) => `${model}: ${tasks.join(", ")}`)
            .join(" · ")})`
        : "assistant disabled — set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable it",
    );
    const active = search();
    app.log.info(
      active
        ? `discovery search enabled (${active.name} web search)`
        : "discovery search disabled — the same AI key above enables it",
    );
  })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
