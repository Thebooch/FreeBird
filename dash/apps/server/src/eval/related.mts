/**
 * What hangs off a record, and whether it can actually be reached.
 *
 * Run by hand, spends nothing. A related lookup needs three things to line up:
 * a child collection recorded against the parent endpoint, an identifier field
 * on the parent's rows, and an input on the child that takes it. Any one
 * missing and the answer is "I can't", which is honest and useless — this says
 * which one.
 *
 *   pnpm eval:related <op-id>
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CapabilityReport,
  CatalogEntry,
  ConnectionSpec,
} from "@freebirdai/dash-spec";
import { buildConciergeContext } from "../concierge/context.js";
import { identityFor, relatedFor } from "../context/related.js";
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

const context = buildConciergeContext({
  connections: readDir<ConnectionSpec>(join(root, "connections")),
  reports: readDir<CapabilityReport>(join(root, "reports")),
  maps: readDir<CatalogEntry>(join(root, ".dash", "catalog")),
});

const op = process.argv[2];
if (!op) {
  console.log("\nUsage: pnpm eval:related <op-id>\n");
  const parents = [...new Set(context.children.map((child) => child.parentOp))];
  console.log(`Endpoints with anything attached (${parents.length}):`);
  for (const parent of parents.slice(0, 40)) {
    console.log(`  ${parent}  (${relatedFor(context, parent).length})`);
  }
  process.exit(0);
}

const identity = identityFor(context, op);
const children = relatedFor(context, op);

console.log(`\n${op}`);
console.log(`  identity field: ${identity ?? "(none established — nothing can be looked up)"}`);
console.log(`  attached collections: ${children.length}`);
for (const child of children) {
  const reachable = child.param ? "reachable" : "NO INPUT TAKES THE ID";
  console.log(`\n  ${child.id}`);
  console.log(`    op:       ${child.op}`);
  console.log(`    title:    ${child.title}`);
  console.log(`    path:     ${child.path ?? "(none)"}`);
  console.log(`    param:    ${child.param ?? "(none)"}   ${reachable}`);
  console.log(`    parentId: ${child.parentIdField ?? "(none)"}`);
  console.log(`    linkField:${child.linkField ?? "(none)"}  kind=${child.linkKind ?? "-"}`);
}
console.log();
