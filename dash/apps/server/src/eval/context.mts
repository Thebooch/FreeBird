/**
 * What the assistant can see, and what it can go and read — against the real
 * boards on disk.
 *
 * Run by hand, never as a test. Two halves, both of which need a real
 * installation to mean anything:
 *
 *   pnpm eval:context             the registry: every widget, its anchor,
 *                                 what is citable, what carries knowledge
 *   pnpm eval:context read        also runs the context harness for real,
 *                                 with a scripted model so it spends ZERO
 *                                 model tokens - only upstream requests
 *
 * The read half is the one worth the trouble. Everything about the harness
 * except which source a model picks is deterministic, and that half is exactly
 * what unit tests cannot cover: whether a widget spec taken off disk really
 * executes server-side against a live API and produces the rows the tile shows.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConciergeContext } from "@freebirdai/dash-agent";
import { fakeLlm } from "@freebirdai/dash-agent";
import type {
  CapabilityReport,
  CatalogEntry,
  ConnectionSpec,
  DashboardSpec,
  ResolvedParams,
} from "@freebirdai/dash-spec";
import { getOp, queryKey, resolveRange } from "@freebirdai/dash-spec";
import { AdapterRegistry, RestAdapter } from "@freebirdai/dash-adapters";
import { extractRows, parsePath } from "@freebirdai/dash-expr";
import { buildChatRegistry } from "../chat/registry.js";
import { workspaceHandles } from "../chat/handles.js";
import { buildConciergeContext } from "../concierge/context.js";
import { nodeHttp } from "../server.js";
import { QueryCache } from "../cache/queryCache.js";
import { splitOpInputs } from "../query.js";
import { answerFromData } from "../context/tool.js";
import { buildCandidates } from "../context/candidates.js";
import { MemoryFocusStore } from "../context/focus.js";
import { KeyStore, LocalAesVault } from "../vault.js";
import { loadEnvFile } from "../env.js";
import { llmForModel, llmSpend } from "../llm.js";
import { TIER_MODELS } from "../models.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile({ startDir: here });
const root = resolve(process.env.DASH_ROOT ?? join(here, "..", ".."));

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

const connections = readDir<ConnectionSpec>(join(root, "connections"));
const reports = readDir<CapabilityReport>(join(root, "reports"));
const maps = readDir<CatalogEntry>(join(root, ".dash", "catalog"));
const dashboards = readDir<DashboardSpec>(join(root, "dashboards"));

if (dashboards.length === 0) {
  throw new Error(`no dashboards under ${join(root, "dashboards")}`);
}

const context: ConciergeContext = buildConciergeContext({ connections, reports, maps });
const current = dashboards[0]!;

/* ── half one: what is registered ─────────────────────────────────────── */

const registry = buildChatRegistry({
  dashboard: current,
  workspace: dashboards,
  reports,
  board: { getDashboard: () => current, putDashboard: () => {} },
});

const components = registry.list();
const widgets = components.filter((component) => component.domAnchor);
const withKnowledge = components.filter((c) => (c.knowledge?.length ?? 0) > 0);

console.log(`\nWORKSPACE  ${dashboards.length} tab(s), current = "${current.title}"`);
console.log(`  registered   ${components.length} component(s)`);
console.log(`  citable      ${widgets.length} (every widget carries a domAnchor)`);
console.log(`  knowledge    ${withKnowledge.length} (roster + the open tab's widgets)`);

for (const board of dashboards) {
  const mine = widgets.filter((component) =>
    component.domAnchor?.page === `#/d/${encodeURIComponent(board.id)}`,
  );
  console.log(`\n  ${board.title}${board.id === current.id ? "  (open)" : ""}`);
  for (const component of mine.slice(0, 8)) {
    const knows = (component.knowledge?.length ?? 0) > 0 ? "detail" : "name only";
    console.log(
      `    ${component.id.padEnd(38)} ${knows.padEnd(10)} ${component.domAnchor?.selector}`,
    );
  }
  if (mine.length > 8) console.log(`    … and ${mine.length - 8} more`);
}

const roster = (components[0]?.knowledge ?? []).map((item) => item.text).join("\n");
const rosterLine = roster.split("\n").find((line) => line.startsWith("WIDGETS"));
console.log(`\nROSTER (${roster.length} chars)`);
console.log(`  ${(rosterLine ?? "(none)").slice(0, 400)}`);

/* ── half two: reading, for real ──────────────────────────────────────── */

if (process.argv[2] !== "read") {
  console.log('\nPass "read" to also run the harness against the live API.\n');
  process.exit(0);
}

// The same vault, key store and guarded transport the server itself builds.
const vault = LocalAesVault.fromEnvOrDevFile(join(root, ".dash", "master-key"));
const keys = new KeyStore(vault, join(root, ".dash", "vault.json"));
const adapters = new AdapterRegistry().register(new RestAdapter(nodeHttp));
for (const connection of connections) adapters.addConnection(connection);
const queries = new QueryCache();

const resolved: ResolvedParams = {
  range: resolveRange({ preset: current.params.defaultRange, now: Date.now() }),
  filters: {},
};

let upstream = 0;
const read = async (input: {
  connection: string;
  op: string;
  params: Readonly<Record<string, string | number | boolean>>;
  resolved: ResolvedParams;
  cacheOnly: boolean;
}) => {
  const spec = connections.find((candidate) => candidate.id === input.connection);
  if (!spec) return null;
  const op = getOp(spec, input.op);
  if (!op) return null;
  const { overrides, inputs } = splitOpInputs(op, input.params, input.resolved.filters);
  const scoped: ResolvedParams = { ...input.resolved, filters: inputs };
  const key = queryKey(input.connection, input.op, overrides, scoped);
  if (input.cacheOnly) {
    const cached = queries.store.get(key);
    return cached
      ? {
          ok: true as const,
          body: cached.body,
          requests: 0,
          truncated: cached.meta.truncated,
        }
      : null;
  }
  try {
    const outcome = await queries.read({
      key,
      connection: input.connection,
      maxAgeMs: 60 * 60_000,
      fetcher: () =>
        adapters.fetch(input.connection, input.op, overrides, {
          params: scoped,
          now: Date.now(),
          resolveSecret: async (ref) => keys.get(ref),
        }),
    });
    if (outcome.outcome !== "hit" && outcome.outcome !== "stale") upstream += 1;
    console.log(
      `    ${input.op}  ${outcome.outcome}  pages=${outcome.meta.pages}` +
        `  truncated=${outcome.meta.truncated}`,
    );
    return {
      ok: true as const,
      body: outcome.body,
      requests: outcome.outcome === "miss" ? 1 : 0,
      truncated: outcome.meta.truncated,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`    ! ${input.op}: ${reason}`);
    return { ok: false as const, reason };
  }
};

const focusStore = new MemoryFocusStore();
const handles = workspaceHandles(dashboards, current.id);
const candidates = buildCandidates({
  handles,
  context,
  resolved,
  isCached: (key) => queries.store.get(key) !== undefined,
});
console.log(
  `\nCANDIDATES  ${candidates.length} (${candidates.filter((c) => c.kind === "widget").length} widgets, ` +
    `${candidates.filter((c) => c.kind === "endpoint").length} endpoints)`,
);

/*
 * The model half, scripted.
 *
 * It always picks the first widget and always says the rows answered the
 * question, so the loop runs exactly once and every model call is free. What
 * is being measured is the half no test can reach: whether a widget spec taken
 * off disk really executes against a live API.
 */
/*
 * `--source <id>` picks which candidate to read, so a widget that answered
 * badly can be examined directly instead of whichever one sorts first.
 */
const sourceAt = process.argv.indexOf("--source");
const wanted = sourceAt === -1 ? null : process.argv[sourceAt + 1];
const first = wanted
  ? candidates.find((candidate) => candidate.id === wanted)
  : candidates.find((candidate) => candidate.kind === "widget");
if (wanted && !first) {
  console.log(`
no candidate "${wanted}". Available widgets:`);
  for (const c of candidates.filter((c) => c.kind === "widget")) {
    console.log(`  ${c.id}`);
  }
  process.exit(1);
}
if (!first) {
  console.log("no widget candidates — nothing to read\n");
  process.exit(0);
}

/**
 * Scripted for the search, real for the reading.
 *
 * `read_chunk` and `join_findings` go to the live model; everything else is
 * answered from the script, so the loop takes a known path and only the part
 * being measured costs anything.
 */
const deepLlm = (fallback: ReturnType<typeof fakeLlm>) => {
  const real = llmForModel(TIER_MODELS.anthropic.fast, "context");
  if (!real) throw new Error("no key for the fast tier");
  return {
    ...fallback,
    generate: async (opts: Parameters<typeof fallback.generate>[0]) => {
      const name = (opts.toolChoice as { name?: string } | undefined)?.name;
      if (name === "read_chunk" || name === "join_findings") return real.generate(opts);
      return fallback.generate(opts);
    },
  } as typeof fallback;
};

const scripted = fakeLlm([
  { args: { sources: [first.id], reason: "scripted" } },
  { args: { verdict: "found", answer: "scripted", missing: "" } },
]);

/*
 * `--deep N` runs the real chunked analysis on the real model, which is the
 * only way to see whether a hundred records at a time yields a pattern worth
 * reading. It costs one call per chunk plus the join.
 */
const chunkAt = process.argv.indexOf("--chunk");
const chunkSize = chunkAt === -1 ? undefined : Number(process.argv[chunkAt + 1] ?? 100);
const deepAt = process.argv.indexOf("--deep");
const scanRecords = deepAt === -1 ? undefined : Number(process.argv[deepAt + 1] ?? 400);
const question =
  process.argv[3] && !process.argv[3].startsWith("--")
    ? process.argv[3]
    : `what does "${first.title}" show right now?`;
console.log(`\nASKING  ${question}`);
const answer = await answerFromData(
  { question, ...(scanRecords ? { scanRecords } : {}) },
  {
    /*
     * The ranker and judge are scripted so the search is deterministic and
     * free; the chunk analysis is not, because whether a real model finds a
     * real pattern in a real hundred records is the whole question.
     */
    /*
     * A memory focus, so a driver run can exercise a follow-up without
     * touching the chat database or needing a session to exist.
     */
    sessionId: "eval",
    focus: focusStore,
    llm: scanRecords ? deepLlm(scripted) : scripted,
    ...(chunkSize ? { chunkSize } : {}),
    context,
    handles,
    dashboards,
    resolved,
    timeZone: current.params.timeZone,
    now: () => Date.now(),
    read,
    isCached: (key) => queries.store.get(key) !== undefined,
    rowsOf: (body, rowsPath) => {
      try {
        return extractRows(parsePath(rowsPath), body).filter(
          (row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null && !Array.isArray(row),
        );
      } catch {
        return [];
      }
    },
    rowsPathFor: (op) => context.shapes[op]?.rowsPath ?? "$",
  },
);

if ("error" in answer) {
  console.log(`\nFAILED  ${answer.error}\n`);
  process.exit(1);
}

/*
 * What the judge was actually handed.
 *
 * The failure this exists for: the reply said it had read all 50 tasks and
 * found no dishwasher, from a set that contains one. Whether that row ever
 * reached the judge is invisible from the answer, so it is printed.
 */
const findAt = process.argv.indexOf("--find");
const needle = findAt === -1 ? null : process.argv[findAt + 1];
for (const finding of answer.findings) {
  const rowsJson = JSON.stringify(finding.rows);
  console.log(
    `\nHANDED OVER  ${finding.rows.length} row(s), ${rowsJson.length} chars serialized`,
  );
  console.log(`  columns:  ${finding.columns.join(", ")}`);
  console.log(`  shows:    ${(finding.shows ?? []).join(", ") || "(none)"}`);
  console.log(`  row keys: ${Object.keys(finding.rows[0] ?? {}).join(", ")}`);
  if (needle) {
    const has = (row: unknown) =>
      JSON.stringify(row).toLowerCase().includes(needle.toLowerCase());
    const at = finding.rows.findIndex(has);
    if (at !== -1) console.log(`  matching row: ${JSON.stringify(finding.rows[at])}`);
    console.log(
      `  "${needle}" is in ${finding.rows.filter(has).length} of them` +
        (at === -1 ? " (NOT PRESENT)" : ` (first at index ${at})`),
    );
  }
}

console.log(`\nOUTCOME   ${answer.outcome}`);
console.log(`LOOKED AT ${answer.looked.join(", ") || "(nothing)"}`);
console.log(`REQUESTS  ${answer.requests} (upstream calls observed: ${upstream})`);
for (const finding of answer.findings) {
  console.log(`\n  ${finding.source}${finding.tab ? ` [${finding.tab}]` : ""}`);
  console.log(`    ${finding.coverage}`);
  console.log(`    columns: ${finding.columns.slice(0, 12).join(", ") || "(none)"}`);
  console.log(`    first row: ${JSON.stringify(finding.rows[0] ?? null).slice(0, 300)}`);
  for (const caveat of finding.caveats) console.log(`    caveat: ${caveat}`);
}
if (answer.deep) {
  console.log(
    `\nDEEP READ  ${answer.deep.scanned} record(s) in ${answer.deep.chunks} chunk(s)` +
      (answer.deep.notRead > 0 ? `, ${answer.deep.notRead} chunk(s) not read` : ""),
  );
  console.log(`  answer:  ${answer.deep.answer}`);
  console.log(`  trends:  ${answer.deep.trends || "(none)"}`);
  console.log(`  caveats: ${answer.deep.caveats || "(none)"}`);
}
console.log(
  `\nSPEND     $${llmSpend().usd.toFixed(4)} over ${llmSpend().calls} call(s)`,
);
console.log(`\nPAYLOAD   ${JSON.stringify(answer.payload ?? null)}`);
console.log(`CITES     ${JSON.stringify(answer.componentIds ?? [])}\n`);
