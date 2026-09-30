import { join, resolve } from "node:path";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import { CatalogStore } from "../catalog.js";
import { httpRegistry, syncRegistry } from "../registry/registry.js";
import { bindAllowed } from "../identity/guard.js";
import { DbMembershipStore, MemoryMembershipStore } from "../identity/members.js";
import { oidcJwtResolver } from "../identity/oidc.js";
import { rolePolicy } from "../identity/policy.js";
import { DbLeaseLock } from "./lease.js";
import { allowlistEgress, configureEgress, fetchPublicDocument } from "../safe-fetch.js";
import { openChatDb } from "../chat/db.js";
import { DbEvidenceStore, type EvidenceStore } from "../evidence/store.js";
import { openDashDb } from "./db.js";
import { DbWriteJournal } from "../writes/journal-db.js";
import { DbCredentialMetaStore } from "../auth/credential-meta.js";
import { DbSeenValueStore } from "../values/store.js";
import { DbShapeStore } from "../drift/store.js";
import { DbSnapshotStore } from "../history/store.js";
import type { SearchProvider } from "../discovery/search.js";
import { searchFromEnv } from "../discovery/search.js";
import { defaultModelId, llmForModel, modelForTask } from "../llm.js";
import { isTask, providerFor } from "../models.js";
import { buildPartRegistry } from "../parts.js";
import type { BuildServerOptions } from "../server.js";
import { NarrowingStore } from "../narrowings.js";
import { RhythmStore } from "../rhythm-store.js";
import { SettingsStore } from "../settings.js";
import { SpecStore } from "../store.js";
import { GrantStore } from "../grants.js";
import { KeyStore, LocalAesVault } from "../vault.js";


/**
 * Everything the server plugs in, built for one machine (plan, track G).
 *
 * `buildServer` takes every piece of infrastructure it depends on as an
 * option — the plug-in points in `PLATFORM.md` — and this is the open-source
 * build's answer for each: files under `DASH_ROOT`, the embedded databases,
 * the local vault. A hosted build writes its own `create…Platform` with the
 * same shape and hands it to the same `buildServer`; nothing else changes.
 */
export type DashPlatform = BuildServerOptions;

export interface LocalPlatform {
  readonly platform: DashPlatform;
  readonly root: string;
  readonly stateDir: string;
  /** Where to listen: this machine unless something signs every request in. */
  readonly host: string;
  readonly modelFor: (task?: string) => string | null;
  readonly llm: (label?: string) => LlmAdapter | null;
  readonly search: () => SearchProvider | null;
  /** Close what was opened, on the way out: an embedded database killed open can be damaged. */
  close(): Promise<void>;
}

/** `here` is the server's source directory, which the shipped catalog and parts are found beside. */
export const createLocalPlatform = async (here: string): Promise<LocalPlatform> => {
  /* Private addresses an operator allows connections to reach, when they opt in (plan, track F). */
  if (process.env.DASH_PRIVATE_EGRESS) configureEgress(allowlistEgress(process.env.DASH_PRIVATE_EGRESS));
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
  /*
   * A registry of entries somebody else already worked out, when one is named
   * (`DASH_CATALOG_REGISTRY`): pulled at start and once a day into a directory
   * the catalog reads beneath this instance's own entries. See `registry/`.
   */
  const registryUrl = process.env.DASH_CATALOG_REGISTRY;
  const registryDir = join(stateDir, "registry");
  const catalog = new CatalogStore(
    process.env.DASH_CATALOG_DIR ?? join(repoRoot, "catalog"),
    join(stateDir, "catalog"),
    registryUrl ? registryDir : undefined,
  );
  if (registryUrl) {
    const pull = async (): Promise<void> => {
      try {
        const result = await syncRegistry(
          httpRegistry(registryUrl, async (url) => {
            const response = await fetchPublicDocument(url);
            return { status: response.status, text: response.text, url: response.url };
          }),
          registryDir,
        );
        console.log(
          `catalog registry: ${result.listed} listed, ${result.pulled.length} pulled, ${result.unchanged} unchanged${result.skipped.length > 0 ? `, ${result.skipped.length} skipped (${result.skipped.slice(0, 3).map((one) => `${one.id}: ${one.why}`).join("; ")})` : ""}`,
        );
      } catch (error) {
        console.warn(`catalog registry could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    void pull();
    setInterval(() => void pull(), 24 * 60 * 60 * 1000).unref();
  }

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

  /*
   * Who is asking (plan, track G). The open-source build has one owner and no
   * sign-in, which is safe only on this machine. A hosted or shared instance
   * names an OpenID Connect issuer: every request then carries a token it
   * signed, the workspace's members say what each person may do, and the first
   * owner is named once (`DASH_OWNER_SUB`, `DASH_WORKSPACE`).
   */
  const host = process.env.DASH_HOST ?? "127.0.0.1";
  const issuer = process.env.DASH_OIDC_ISSUER;
  const audience = process.env.DASH_OIDC_AUDIENCE;
  const signsIn = Boolean(issuer && audience);
  const bind = bindAllowed(host, signsIn);
  if (!bind.ok) {
    console.error(`\n  ${bind.reason}\n`);
    throw new Error(bind.reason);
  }
  const memberships = signsIn ? (dashDb ? new DbMembershipStore(dashDb) : new MemoryMembershipStore()) : undefined;
  if (memberships && process.env.DASH_OWNER_SUB) {
    const workspaceId = process.env.DASH_WORKSPACE ?? "main";
    const now = new Date().toISOString();
    if (!(await memberships.workspace(workspaceId)))
      await memberships.putWorkspace({ id: workspaceId, name: workspaceId, ownerId: process.env.DASH_OWNER_SUB, createdAt: now });
    if (!(await memberships.member(workspaceId, process.env.DASH_OWNER_SUB)))
      await memberships.putMember({
        workspaceId,
        userId: process.env.DASH_OWNER_SUB,
        email: process.env.DASH_OWNER_EMAIL ?? "owner@localhost.localdomain",
        role: "owner",
        grants: [],
        joinedAt: now,
      });
  }
  const identity =
    signsIn && memberships
      ? oidcJwtResolver({
          issuer: issuer!,
          audience: audience!,
          memberships,
          fetchDocument: async (url) => {
            const response = await fetchPublicDocument(url);
            return { status: response.status, text: response.text, url: response.url };
          },
        })
      : undefined;

  const platform: DashPlatform = {
    ...(identity && memberships ? { identity, policy: rolePolicy(memberships) } : {}),
    /* Several servers on one shared database: one keeper per connection among them. */
    ...(dashDb && process.env.DATABASE_URL ? { leases: new DbLeaseLock(dashDb) } : {}),
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
    ...(dashDb ? { seenValues: new DbSeenValueStore(dashDb) } : {}),
    ...(dashDb ? { shapes: new DbShapeStore(dashDb) } : {}),
    ...(dashDb ? { snapshots: new DbSnapshotStore(dashDb) } : {}),
    logger: true,
  };
  return {
    platform,
    root,
    stateDir,
    host,
    modelFor,
    llm,
    search,
    close: async () => {
      await chat?.close().catch(() => undefined);
      await dashDb?.close().catch(() => undefined);
    },
  };
};
