/**
 * 3a — what does the setup card still have to ask?
 *
 * No model calls and no requests: a brief is synthesised for every described
 * record type, put through the real `patchFromBrief → revise → readiness`
 * path, and whatever `readiness` still reports as missing is what the card
 * genuinely has to ask about. Everything else the machine can do is dead
 * weight on this path.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConciergeContext } from "@freebirdai/dash-agent";
import { newDraft, patchFromBrief, readiness, revise } from "@freebirdai/dash-agent";
import type { CapabilityReport, CatalogEntry, ConnectionSpec } from "@freebirdai/dash-spec";
import { buildConciergeContext } from "../concierge/context.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.DASH_ROOT ?? join(here, "..", ".."));

const readDir = <T,>(dir: string): T[] => {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as T);
  } catch {
    return [];
  }
};

const connections = readDir<ConnectionSpec>(join(root, "connections"));
const reports = readDir<CapabilityReport>(join(root, "reports"));
const maps = readDir<CatalogEntry>(join(root, ".dash", "catalog"));
const context: ConciergeContext = buildConciergeContext({ connections, reports, maps });

const described = maps.filter((m) => (m.entities?.length ?? 0) > 0);
const entities = described.flatMap((m) => m.entities ?? []);
const resources = described.flatMap((m) => m.resources);
const connectionId = connections[0]?.id ?? "";

const asked = new Map<string, number>();
let built = 0;
let noPatch = 0;
let clean = 0;
const examples = new Map<string, string>();
const rejected = new Map<string, number>();
const rejectExample = new Map<string, string>();

for (const entity of entities) {
  const resource = resources.find((r) => r.id === entity.resource);
  if (!resource) continue;

  const listPath = connections[0]?.ops.find((op) => op.id === resource.listOp)?.path;
  const { patch } = patchFromBrief({
    brief: { entity: entity.id, intent: "records" },
    entity,
    resource,
    connection: connectionId,
    id: entity.id,
    ...(listPath ? { listPath } : {}),
  });
  if (!patch.endpoint) {
    // Refused on purpose: these live on a parent's record page, not on a board.
    noPatch += 1;
    continue;
  }
  built += 1;

  const revised = revise(newDraft("m", `my ${entity.name.many}`, "assisted"), patch, context);
  const state = readiness(revised.draft, context);
  const missing = state.missing.map((piece) => piece.stepId);

  if (missing.length === 0) clean += 1;
  for (const r of revised.rejected) {
    const key = `${r.stepId}: ${r.reason}`.slice(0, 90);
    rejected.set(key, (rejected.get(key) ?? 0) + 1);
    if (!rejectExample.has(key)) rejectExample.set(key, `${entity.id} wanted ${r.value}`);
  }
  for (const stepId of missing) {
    // `input:x` and `role:x` are families, not distinct questions.
    const family = stepId.includes(":") ? `${stepId.split(":")[0]}:*` : stepId;
    asked.set(family, (asked.get(family) ?? 0) + 1);
    if (!examples.has(family)) examples.set(family, `${entity.id} → ${stepId}`);
  }
}

console.log(`record types described:        ${entities.length}`);
console.log(`  compiled to a patch:         ${built}`);
console.log(`  no endpoint (unbuildable):   ${noPatch}`);
console.log(`  nothing left to ask:         ${clean}  (${Math.round((clean / built) * 100)}%)`);
console.log(`\nsteps still asked, by family:`);
for (const [family, n] of [...asked].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${family.padEnd(18)} e.g. ${examples.get(family)}`);
}
if (asked.size === 0) console.log("  (none)");

console.log(`
rejections, by reason:`);
for (const [reason, n] of [...rejected].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${String(n).padStart(4)}  ${reason}`);
  console.log(`        ${rejectExample.get(reason)}`);
}
if (rejected.size === 0) console.log("  (none)");
