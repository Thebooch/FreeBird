/**
 * `tsx src/bench/real/snapshot.mts` — read each real source once and keep the
 * fields its answer keys use, so the keys are fixed before any integrator runs.
 *
 * Public data from public APIs that need no key. Run by hand; the benchmark
 * checks the snapshot against the live API before scoring (see
 * `providers/real.ts`), so a changed API is reported rather than mis-scored.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPublicDocument } from "../../safe-fetch.js";
import { REAL_SOURCES, minimal } from "./sources.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "snapshots");
mkdirSync(out, { recursive: true });

for (const source of REAL_SOURCES) {
  const answer = await fetchPublicDocument(source.url);
  if (answer.status !== 200) throw new Error(`${source.id}: ${answer.status}`);
  const records = minimal(source, JSON.parse(answer.text));
  writeFileSync(
    join(out, `${source.id}.json`),
    `${JSON.stringify({ source: source.url, at: new Date().toISOString(), records }, null, 1)}\n`,
  );
  console.log(`${source.id}: ${records.length} record(s)`);
}
