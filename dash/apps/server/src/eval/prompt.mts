/**
 * Where a chat turn's input tokens actually go.
 *
 * Run by hand. It spends nothing — no model call, no upstream request — and
 * exists because "the prompt is big" is not an actionable statement. It
 * rebuilds exactly what `ChatEngine.send` assembles for one turn against the
 * real install and reports each block's size, so the next question is which
 * block rather than whether.
 *
 *   pnpm eval:prompt
 *
 * Tool schemas are counted too. They are easy to forget — they are not "the
 * prompt" in the sense anybody pictures — and they are billed as input on
 * every call like everything else.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCitationsPrompt,
  buildHarnessTurn,
  buildKnowledgePrompt,
} from "@freebirdai/core";
import type {
  CapabilityReport,
  CatalogEntry,
  ConnectionSpec,
  DashboardSpec,
} from "@freebirdai/dash-spec";
import { buildChatRegistry } from "../chat/registry.js";
import { LOOK_UP_WIDGET_TOOL } from "../chat/lookUpWidget.js";
import { ANSWER_TOOL } from "../context/tool.js";
import { buildConciergeContext } from "../concierge/context.js";
import { CHAT_SYSTEM_PROMPT } from "../server.js";
import { toJsonSchema } from "../llm.js";
import { loadEnvFile } from "../env.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile({ startDir: here });
const root = resolve(process.env.DASH_ROOT ?? join(here, "..", ".."));

const readDir = <T,>(dir: string): T[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as T);
  } catch {
    return [];
  }
};

const connections = readDir<ConnectionSpec>(join(root, "connections"));
const reports = readDir<CapabilityReport>(join(root, "reports"));
const maps = readDir<CatalogEntry>(join(root, ".dash", "catalog"));
const dashboards = readDir<DashboardSpec>(join(root, "dashboards"));
if (dashboards.length === 0) throw new Error(`no dashboards under ${join(root, "dashboards")}`);

const context = buildConciergeContext({ connections, reports, maps });
const current = dashboards[0]!;

const registry = buildChatRegistry({
  dashboard: current,
  workspace: dashboards,
  reports,
  connections: connections.map((c) => ({
    id: c.id,
    title: c.title,
    read: true,
    stale: false,
  })),
  allDashboards: dashboards.map((d) => ({ id: d.id, title: d.title })),
  board: { getDashboard: () => current, putDashboard: () => {} },
  concierge: {
    context,
    draft: null,
    getDraft: async () => null,
    putDraft: async () => {},
    clearDraft: async () => {},
    getDashboard: () => current,
    putDashboard: () => {},
  } as never,
});

/* Chars, not tokens. Nothing here calls a tokenizer; see CHARS_PER_TOKEN. */
const blocks: Array<{ name: string; chars: number; note?: string }> = [];

blocks.push({ name: "system prompt", chars: CHAT_SYSTEM_PROMPT.length, note: "server.ts" });

const knowledge = buildKnowledgePrompt(registry, { maxChars: 24_000 });
blocks.push({
  name: "knowledge block",
  chars: knowledge.length,
  note: "capped at 24,000 by knowledgeContext.maxChars",
});

const citations = buildCitationsPrompt(registry);
blocks.push({
  name: "citations block",
  chars: citations.length,
  note: `one line per citable component (${registry.list().filter((c) => c.domAnchor).length} widgets)`,
});

/*
 * The action tools, as the provider sees them.
 *
 * `per_action` mode is the default and emits one tool per action with its
 * schema inlined, so this grows with both the number of actions and the width
 * of the widest one.
 */
const harness = buildHarnessTurn({
  registry,
  actionState: { phase: "idle", pending: null, journal: [], workflowStack: [] },
});
const harnessTools = Object.values(harness.tools ?? {});
const toolJson = (tool: { name: string; description?: string; schema?: unknown }): number =>
  JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.schema ? toJsonSchema(tool.schema as never) : {},
  }).length;

const harnessChars = harnessTools.reduce((total, tool) => total + toolJson(tool as never), 0);
blocks.push({
  name: "action tool schemas",
  chars: harnessChars,
  note: `${harnessTools.length} tools, per_action mode`,
});

const extra = [ANSWER_TOOL, LOOK_UP_WIDGET_TOOL];
blocks.push({
  name: "processing tool schemas",
  chars: extra.reduce((total, tool) => total + toolJson(tool as never), 0),
  note: extra.map((t) => t.name).join(", "),
});

blocks.push({
  name: "harness system messages",
  chars: (harness.systemMessages ?? []).join("\n").length,
});

const total = blocks.reduce((sum, block) => sum + block.chars, 0);

/*
 * A rough conversion, and deliberately labelled as one. Tool schemas are JSON
 * and tokenize denser than prose, so this under- rather than over-states them;
 * the number to trust is what a real turn bills, which the server logs per
 * call. This is for comparing blocks against each other.
 */
const CHARS_PER_TOKEN = 3.3;

console.log(`\nPROMPT BUDGET  ${root}`);
console.log(`  ${dashboards.length} tab(s), ${registry.list().length} component(s), ${context.ops.length} readable endpoint(s)\n`);
const width = Math.max(...blocks.map((b) => b.name.length));
for (const block of [...blocks].sort((a, b) => b.chars - a.chars)) {
  const share = ((block.chars / total) * 100).toFixed(1).padStart(5);
  console.log(
    `  ${block.name.padEnd(width)}  ${String(block.chars).padStart(7)} chars  ${share}%` +
      (block.note ? `   ${block.note}` : ""),
  );
}
console.log(`  ${"".padEnd(width)}  ${String(total).padStart(7)} chars  total`);
console.log(
  `\n  roughly ${Math.round(total / CHARS_PER_TOKEN).toLocaleString()} input tokens before history,` +
    ` at ~${CHARS_PER_TOKEN} chars/token (an estimate; the server logs what each call really bills)\n`,
);

/* The biggest single knowledge section, which is usually the thing to cut. */
const sections = knowledge.split("\n### ").slice(1);
const ranked = sections
  .map((section) => ({ head: section.split("\n")[0] ?? "", chars: section.length }))
  .sort((a, b) => b.chars - a.chars)
  .slice(0, 8);
console.log("  Largest knowledge sections:");
for (const section of ranked) {
  console.log(`    ${String(section.chars).padStart(6)} chars  ${section.head}`);
}
console.log();
