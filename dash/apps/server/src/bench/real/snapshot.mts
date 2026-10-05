/**
 * `tsx src/bench/real/snapshot.mts [id ...]` — read each real source (or those named) once and keep the
 * fields its answer keys use, so the keys are fixed before any integrator runs.
 *
 * Public data from public APIs that need no key. Run by hand; the benchmark
 * checks the snapshot against the live API before scoring (see
 * `providers/real.ts`), so a changed API is reported rather than mis-scored.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPublicDocument } from "@freebirdai/connect/safe-fetch";
import { REAL_SOURCES, readSource } from "./sources.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "snapshots");
mkdirSync(out, { recursive: true });

/* Only the sources named, when any are: retaking a snapshot changes its answer keys. */
const only = process.argv.slice(2);
for (const source of REAL_SOURCES.filter((one) => only.length === 0 || only.includes(one.id))) {
  const records = await readSource(source, (url) => fetchPublicDocument(url));
  writeFileSync(
    join(out, `${source.id}.json`),
    `${JSON.stringify({ source: source.url, at: new Date().toISOString(), records }, null, 1)}
`,
  );
  console.log(`${source.id}: ${records.length} record(s)`);
}
