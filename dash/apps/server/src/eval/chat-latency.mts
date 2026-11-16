/**
 * Where a chat turn's time goes, with the real model.
 *
 * Builds the server over a temporary copy of this workspace's boards,
 * connections and reports, answers every API request with made-up rows (so
 * nobody's account is asked anything), and sends chat messages the way the
 * browser does: the topic route first, then the turn. Every model call is
 * timed, with the task it was made for and the model that took it, so the
 * table says which calls a question waits on and for how long.
 *
 * `pnpm eval:latency` (needs an AI key in `.env`; spends tokens: about a
 * dozen calls a run). `--board <id>` picks the board, `--only <n,n>` the
 * questions by number, `--runs <n>` repeats each, `--ask "one|two"` asks
 * your own questions instead.
 *
 * `--live <connection id>` reads that one connection's API for real, with
 * GET only and no key: for a public API such as JSONPlaceholder, so the
 * answers are judged against rows that mean something. Every other
 * connection still gets made-up rows. Made-up rows rarely hold the answer to
 * a question, which sends the search through every round it has; a live
 * public API shows the usual case.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogStore, KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import { loadEnvFile } from "../env.js";
import { llmForModel, modelForTask } from "../llm.js";
import { isTask } from "../models.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { openChatDb } from "../chat/db.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile({ startDir: here });
const root = resolve(process.env.DASH_ROOT ?? join(here, "..", ".."));

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

/* ── the workspace, copied ─────────────────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), "dash-latency-"));
for (const folder of ["connections", "dashboards", "reports"]) {
  if (existsSync(join(root, folder))) cpSync(join(root, folder), join(dir, folder), { recursive: true });
}
if (existsSync(join(root, ".dash", "catalog"))) cpSync(join(root, ".dash", "catalog"), join(dir, ".dash", "catalog"), { recursive: true });
const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
const catalog = new CatalogStore(join(root, "..", "..", "catalog"), join(dir, ".dash", "catalog"));

/* ── every API, answered with made-up rows ─────────────────────────────── */

const STATUSES = ["Open", "Open", "In progress", "Closed", "Open"];
const rows = Array.from({ length: 60 }, (_, index) => ({
  id: index + 1,
  Id: index + 1,
  name: `Record ${index + 1}`,
  title: `Record ${index + 1}`,
  status: STATUSES[index % STATUSES.length],
  Status: STATUSES[index % STATUSES.length],
  isActive: index % 4 !== 0,
  amount: 100 + index * 15,
  vendor: ["Northside Plumbing", "Bright Electric", "Oak Roofing"][index % 3],
  createdAt: new Date(Date.UTC(2026, 9, 1 + (index % 28))).toISOString(),
}));
const seenPaths = new Set<string>();
let upstream = 0;
const live = arg("live") ? store.getConnection(arg("live")!) : null;
if (arg("live") && !live) {
  console.error(`No connection "${arg("live")}" under ${root}.`);
  process.exit(1);
}
if (live && live.auth.type !== "none") {
  console.error(`"${live.id}" needs a key: --live is only for an API that reads without one.`);
  process.exit(1);
}
const liveOrigin = live?.baseUrl ? new URL(live.baseUrl).origin : null;
const http = async (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
  upstream++;
  if (liveOrigin && new URL(url).origin === liveOrigin) {
    if (init?.method && init.method !== "GET") throw new Error("--live only reads");
    const response = await fetch(url, { method: "GET", headers: { accept: "application/json" }, ...(init?.signal ? { signal: init.signal } : {}) });
    const text = await response.text();
    return { status: response.status, text, url, header: (name: string) => response.headers.get(name) };
  }
  const path = url.split("?")[0]!;
  const first = !seenPaths.has(path);
  seenPaths.add(path);
  /* One page, then nothing more, whatever the API's paging. */
  const page = first ? rows : [];
  return { status: 200, text: JSON.stringify({ data: page, results: page, items: page }), url, header: () => null };
};

/* ── the real model, timed ─────────────────────────────────────────────── */

interface Span {
  readonly task: string;
  readonly model: string;
  readonly kind: "stream" | "generate";
  readonly startedAt: number;
  firstAt?: number;
  endedAt?: number;
}
let spans: Span[] = [];

const timed = (adapter: LlmAdapter, task: string, model: string): LlmAdapter => ({
  defaultModel: adapter.defaultModel,
  stream: (options) => {
    const span: Span = { task, model, kind: "stream", startedAt: performance.now() };
    spans.push(span);
    const inner = adapter.stream(options);
    return (async function* () {
      try {
        for await (const chunk of inner) {
          span.firstAt ??= performance.now();
          yield chunk;
        }
      } finally {
        span.endedAt = performance.now();
      }
    })();
  },
  generate: async (options) => {
    const span: Span = { task, model, kind: "generate", startedAt: performance.now() };
    spans.push(span);
    try {
      return await adapter.generate(options);
    } finally {
      span.endedAt = performance.now();
    }
  },
});

const llm = (label?: string): LlmAdapter | null => {
  const [task, pinned] = (label ?? "chat").split("@") as [string, string | undefined];
  const model = pinned ?? modelForTask(isTask(task) ? task : "chat", null);
  const adapter = model ? llmForModel(model, label) : null;
  return adapter && model ? timed(adapter, task, model) : null;
};

if (!llm("chat")) {
  console.error("No AI key found: set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.");
  process.exit(1);
}

/* ── the server ────────────────────────────────────────────────────────── */

const chat = await openChatDb({ inMemory: true });
const app = buildServer({ store, keys, http, chat, catalog, llm });
await app.ready();

const boards = store.listDashboards();
const board = boards.find((one) => one.id === arg("board")) ?? [...boards].sort((a, b) => b.widgets.length - a.widgets.length)[0];
if (!board) {
  console.error(`No dashboards under ${root}: nothing to ask about.`);
  process.exit(1);
}
const headers = { "x-dash-dashboard": board.id };

/* Draw the board once, so its tiles are held the way they are for somebody looking at it. */
const sources = board.widgets.flatMap((widget) => {
  const source = (widget as { source?: { connection: string; op: string; params?: Record<string, unknown> } }).source;
  return source ? [source] : [];
});
const draw = () =>
  Promise.all(
    sources.map((source) =>
      app.inject({ method: "POST", url: "/api/query", payload: { connection: source.connection, op: source.op, params: source.params ?? {}, range: { preset: "30d" }, mode: "refresh", maxAgeMs: 300_000 } }),
    ),
  );
let drawn = await draw();
for (let round = 0; round < 6; round++) {
  const missing = drawn.flatMap((answer) => {
    const said = /no key stored for "([^"]+)"/.exec(String((answer.json() as { error?: string }).error ?? ""));
    return said ? [said[1]!] : [];
  });
  if (missing.length === 0) break;
  for (const ref of missing) keys.set(ref, "made-up");
  drawn = await draw();
}
const held = drawn.filter((answer) => answer.statusCode === 200).length;

/* ── the questions ─────────────────────────────────────────────────────── */

const first = board.widgets[0]?.title ?? "the first widget";
const QUESTIONS = [
  { name: "small talk (no lookup)", text: "Thanks, that helps." },
  { name: "what a widget is (look_up_widget)", text: `What does the "${first}" widget show, and where does it get its data?` },
  { name: "a data question (answer_from_data)", text: `How many records in "${first}" are open right now?` },
  { name: "a follow-up on the same records", text: "Which vendor has the most of those?" },
  { name: "a data question about another widget", text: `What is the total amount across ${board.widgets[1]?.title ?? first}?` },
];
const own = arg("ask")?.split("|").map((text) => text.trim()).filter(Boolean);
if (own && own.length > 0) QUESTIONS.splice(0, QUESTIONS.length, ...own.map((text, index) => ({ name: `question ${index + 1}`, text })));
const only = arg("only")?.split(",").map(Number);
const runs = Math.max(1, Number(arg("runs") ?? 1));

const ms = (value: number | undefined) => (value === undefined ? "    –" : `${Math.round(value)}`.padStart(5));

console.log(`\nBoard "${board.title}" (${board.widgets.length} widgets, ${held}/${sources.length} tiles held, ${live ? `live reads of ${live.id}` : "made-up rows"}). Models: chat ${modelForTask("chat", null)}, context ${modelForTask("context", null)}.\n`);

const session = await app.inject({ method: "POST", url: "/freebird/sessions", payload: {}, headers });
let topicId = (session.json() as { id: string }).id;
const totals: Array<{ name: string; route: number; turn: number; firstWord: number | undefined; calls: number; modelMs: number }> = [];

for (const [index, question] of QUESTIONS.entries()) {
  if (only && !only.includes(index + 1)) continue;
  for (let run = 0; run < runs; run++) {
    spans = [];
    const before = upstream;
    const t0 = performance.now();
    const routed = await app.inject({ method: "POST", url: "/api/chat/route", headers, payload: { text: question.text, topicId, tz: "America/Chicago" } });
    const routeMs = performance.now() - t0;
    const routeSpans = spans.length;
    const decided = routed.json() as { topicId?: string; id?: string };
    topicId = decided.topicId ?? decided.id ?? topicId;

    const t1 = performance.now();
    const turn = await app.inject({ method: "POST", url: "/freebird/chat", headers, payload: { sessionId: topicId, text: question.text, activeComponentIds: ["board"] } });
    const turnMs = performance.now() - t1;

    const events = turn.body.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as { kind: string; assistantMessage?: { content?: string; toolPayload?: { extraTools?: Array<{ name?: string }> } } });
    const saved = events.find((event) => event.kind === "assistant_saved")?.assistantMessage;
    const tools = (saved?.toolPayload?.extraTools ?? []).map((tool) => tool.name).filter(Boolean);
    /* When the person first sees words of the answer: the first text of the last chat call. */
    const chatCalls = spans.filter((span) => span.kind === "stream");
    const lastChat = chatCalls[chatCalls.length - 1];
    const firstWord = lastChat?.firstAt !== undefined ? lastChat.firstAt - t0 : undefined;
    const modelMs = spans.reduce((sum, span) => sum + ((span.endedAt ?? span.startedAt) - span.startedAt), 0);

    console.log(`${index + 1}. ${question.name}${runs > 1 ? ` (run ${run + 1})` : ""}`);
    console.log(`   asked: ${question.text}`);
    console.log(`   topic route ${ms(routeMs)} ms · turn ${ms(turnMs)} ms · first words of the answer at ${ms(firstWord)} ms · ${spans.length} model calls · tools: ${tools.join(", ") || "none"} · API requests: ${upstream - before} · status ${turn.statusCode}`);
    for (const [at, span] of spans.entries()) {
      const where = at < routeSpans ? "before the turn" : "in the turn    ";
      console.log(`     ${where}  ${span.task.padEnd(10)} ${span.model.padEnd(28)} ${span.kind.padEnd(8)} start +${ms(span.startedAt - t0)}  first ${ms(span.firstAt !== undefined ? span.firstAt - span.startedAt : undefined)}  took ${ms((span.endedAt ?? span.startedAt) - span.startedAt)} ms`);
    }
    console.log(`   server's own time (not waiting on a model): ${ms(routeMs + turnMs - modelMs)} ms`);
    console.log(`   answer: ${(saved?.content ?? "").replace(/\s+/g, " ").slice(0, 200)}\n`);
    totals.push({ name: question.name, route: routeMs, turn: turnMs, firstWord, calls: spans.length, modelMs });
  }
}

console.log("Summary (ms)");
console.log(`${"question".padEnd(42)} ${"route".padStart(6)} ${"turn".padStart(6)} ${"total".padStart(6)} ${"1st word".padStart(8)} ${"calls".padStart(5)} ${"in models".padStart(9)}`);
for (const one of totals) {
  console.log(`${one.name.padEnd(42)} ${ms(one.route).padStart(6)} ${ms(one.turn).padStart(6)} ${ms(one.route + one.turn).padStart(6)} ${ms(one.firstWord).padStart(8)} ${String(one.calls).padStart(5)} ${ms(one.modelMs).padStart(9)}`);
}

await app.close();
await chat.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
