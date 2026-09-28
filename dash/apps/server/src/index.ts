import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import { CatalogStore } from "./catalog.js";
import { openChatDb } from "./chat/db.js";
import { DbEvidenceStore, type EvidenceStore } from "./evidence/store.js";
import { openDashDb } from "./platform/db.js";
import { DbWriteJournal } from "./writes/journal-db.js";
import { DbCredentialMetaStore } from "./auth/credential-meta.js";
import type { SearchProvider } from "./discovery/search.js";
import { searchFromEnv } from "./discovery/search.js";
import { loadEnvFile } from "./env.js";
import { defaultModelId, llmForModel, modelForTask } from "./llm.js";
import { TASKS, isTask, providerFor } from "./models.js";
import { buildPartRegistry } from "./parts.js";
import { buildServer } from "./server.js";
import { NarrowingStore } from "./narrowings.js";
import { RhythmStore } from "./rhythm-store.js";
import { SettingsStore } from "./settings.js";
import { SpecStore } from "./store.js";
import { GrantStore } from "./grants.js";
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

// Which saved widgets a person has approved, bound to the digest of what they
// approved. Beside the vault: it is instance state, not a shareable artifact.
const grants = new GrantStore(join(stateDir, "grants.json"));

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

/* How often each endpoint is asked again, and anything the user moved. */
const rhythms = new RhythmStore(join(stateDir, "rhythm"));

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
const modelFor = (task?: string): string | null => {
  const chosen = settings.read();
  if (task && isTask(task)) return modelForTask(task, chosen);
  // Outside the table, so there is no tier to resolve — but the provider
  // above it still applies, or a caller nobody named would quietly ignore it.
  return chosen.model ?? defaultModelId(chosen);
};

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

/*
 * Dash's own relational state — evidence about each endpoint, for now. The
 * same arrangement as chat (Postgres when DATABASE_URL is set, embedded
 * otherwise), in its own directory so losing one never costs the other. If
 * it cannot open, evidence is kept in memory for this run and said so: the
 * checks still work, they are just not remembered across a restart.
 */
const dashDir = join(stateDir, "dash-db");
let evidence: EvidenceStore | undefined;
let dashDb: Awaited<ReturnType<typeof openDashDb>> | undefined;
try {
  dashDb = await openDashDb({ dataDir: dashDir });
  evidence = new DbEvidenceStore(dashDb);
} catch (cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  console.error(
    [
      "",
      "  Dash's database could not be opened, so what connection checks observe is",
      "  kept in memory for this run only.",
      "",
      `    ${reason}`,
      "",
      `  It lives at ${dashDir}. The same two causes as chat's apply: a second`,
      "  instance holding it, or a process killed while it was open.",
      "",
    ].join("\n"),
  );
}

const app = buildServer({
  // The keeper: see `keeper/keeper.ts`. On here, off in tests.
  keeper: true,
  // Every connection can change records; one whose write endpoints were never
  // read has them read from its published specification. Off in tests.
  autoReadWrites: true,
  // A connection is checked by itself once its key is saved. Off in tests.
  autoIntegrate: true,
  rhythms,
  store,
  keys,
  catalog,
  grants,
  settings,
  narrowings,
  parts,
  llm,
  search,
  chat,
  ...(evidence ? { evidence } : {}),
  // Every change, and every read that might not be one, kept in Dash's database.
  ...(dashDb ? { journal: new DbWriteJournal(dashDb) } : {}),
  // When each OAuth token expires, so it is renewed before it does.
  ...(dashDb ? { credentialMeta: new DbCredentialMetaStore(dashDb) } : {}),
  logger: true,
});
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
    await chat?.close().catch(() => undefined);
    await dashDb?.close().catch(() => undefined);
    process.exit(0);
  })();
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

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
