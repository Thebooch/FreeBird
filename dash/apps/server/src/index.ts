import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import { CatalogStore } from "./catalog.js";
import { openChatDb } from "./chat/db.js";
import type { SearchProvider } from "./discovery/search.js";
import { searchFromEnv } from "./discovery/search.js";
import { loadEnvFile } from "./env.js";
import { defaultModelId, llmForModel, modelForTask } from "./llm.js";
import { TASKS, isTask, providerFor } from "./models.js";
import { buildPartRegistry } from "./parts.js";
import { buildServer } from "./server.js";
import { NarrowingStore } from "./narrowings.js";
import { SettingsStore } from "./settings.js";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";

const here = dirname(fileURLToPath(import.meta.url));

// Before anything reads configuration. Anchored to this file rather than the
// working directory, so `.env` is found the same way however the server is
// launched — from the repo root, from apps/server, or from an editor.
const envFile = loadEnvFile({ startDir: here });

const root = resolve(process.env.DASH_ROOT ?? process.cwd());
const stateDir = join(root, ".dash");

const store = new SpecStore(
  join(root, "dashboards"),
  join(root, "connections"),
  join(root, "reports"),
);
const vault = LocalAesVault.fromEnvOrDevFile(join(stateDir, "master-key"));
const keys = new KeyStore(vault, join(stateDir, "vault.json"));

// The repo seed lives at the workspace root; the overlay is per-instance.
const repoRoot = resolve(here, "..", "..", "..");
const catalog = new CatalogStore(
  process.env.DASH_CATALOG_DIR ?? join(repoRoot, "catalog"),
  join(stateDir, "catalog"),
);

const settings = new SettingsStore(join(stateDir, "settings.json"));

/*
 * Answers the user has confirmed about their own data — which categories
 * count as "maintenance" here. Beside the vault rather than in the catalog:
 * the catalog is the shareable artifact and these words belong to one account.
 */
const narrowings = new NarrowingStore(join(stateDir, "narrowings"));

// Self-hosted: code parts come off the operator's own disk. A hosted build
// sets `allowCode: false` and falls back to the shipped defaults instead.
const parts = buildPartRegistry({ stateDir, projectDir: join(repoRoot, "parts") });

/**
 * Which model runs one action: an env pin, an explicit choice, or the default
 * for that action's tier. `modelForTask` owns the whole order — see it there.
 *
 * A missing task name means a caller outside the table, which still deserves a
 * working model rather than an error, so it falls back to the plain default.
 */
const modelFor = (task?: string): string | null =>
  task && isTask(task) ? modelForTask(task, settings.read()) : (settings.read().model ?? defaultModelId());

// Resolved per request, so picking a different model in the UI takes effect on
// the next action rather than the next restart.
const llm = (label?: string): LlmAdapter | null => {
  const model = modelFor(label);
  // The label names the action both in routing and in the per-call cost line.
  return model ? llmForModel(model, label) : null;
};

// Search follows discovery's model: reading docs through an OpenAI model should
// not leave the web search beside it quietly going through Anthropic.
const search = (): SearchProvider | null => {
  const provider = providerFor(modelFor("discover") ?? "");
  return searchFromEnv(provider ?? undefined);
};

/*
 * Chat storage. `DATABASE_URL` picks a hosted Postgres; without it an embedded
 * one is started under `.dash/` so a fresh clone has working chat with nothing
 * to install.
 *
 * A failure here costs chat, and nothing else. It used to be unguarded, on the
 * reasoning that a clear boot error beats a 500 on somebody's first message —
 * right about the diagnosis, wrong about the severity. `buildServer` already
 * treats chat as optional, so an embedded database left damaged by a hard
 * crash was taking down dashboards, connections and queries along with it.
 * Every one of those reads files that were never involved.
 *
 * Said loudly, because silently losing chat is its own kind of confusing, and
 * the fix is usually deleting one directory that holds only chat history.
 */
const chatDir = join(stateDir, "chat-db");
let chat: Awaited<ReturnType<typeof openChatDb>> | undefined;
try {
  chat = await openChatDb({ dataDir: chatDir });
} catch (cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  console.error(
    [
      "",
      "  Chat storage could not be opened, so the assistant is unavailable.",
      "  Everything else — dashboards, connections, queries — is unaffected.",
      "",
      `    ${reason}`,
      "",
      `  The database lives at ${chatDir}.`,
      "",
      "  It holds chat history and any half-finished widget setups, and nothing",
      "  else. Two things cause this, and they need different fixes:",
      "",
      "    A second instance has it open. Only one process can, so stop the other",
      "    one — nothing is wrong with the database.",
      "",
      "    A process was killed while holding it. Stop this server, move the",
      "    directory aside, and start again; a fresh one is created and the chat",
      "    history is the only loss.",
      "",
      "  Deleting `postmaster.pid` alone is worth trying first and often is not",
      "  enough: a hard kill mid-write damages the data files themselves. Never",
      "  remove that file while another instance is running — it is how a merely",
      "  locked database becomes a damaged one.",
      "",
    ].join("\n"),
  );
}

const app = buildServer({
  store,
  keys,
  catalog,
  settings,
  narrowings,
  parts,
  llm,
  search,
  chat,
  logger: true,
});
const port = Number(process.env.PORT ?? 4600);

app
  .listen({ port, host: "127.0.0.1" })
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
