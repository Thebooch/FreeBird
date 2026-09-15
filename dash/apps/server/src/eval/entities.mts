/**
 * Is the describing pass any good, measured rather than argued about.
 *
 * Run by hand, never as a test. It spends real money and its answers are not
 * deterministic — a vitest file that costs dollars and fails on a coin-flip is
 * worse than no coverage at all.
 *
 *   pnpm eval:entities                     every described API on disk
 *   pnpm eval:entities buildium            one entry
 *   pnpm eval:entities --model claude-sonnet-5
 *
 * It reads the catalog already on disk and calls only the describing pass, so
 * it spends **model tokens and zero upstream requests** — it can be run
 * against an account whose key is rate-limited or absent entirely.
 *
 * Two things are measured, and they answer different questions.
 *
 * **Agreement.** The pass is re-run over an API somebody has already
 * described, and the new reading is compared with the stored one. This needs
 * no answer key, which is the point: an eval whose ground truth the author
 * invented measures the author. What it catches is the failure that actually
 * matters for a shared artifact — a pass that says something different every
 * time cannot be sold as "describe once, everybody inherits it".
 *
 * **Soundness.** Deterministic properties of whatever came back: whether a
 * record type can open a page, whether it can say a record's name, whether its
 * links point at record types that exist. These are checkable without opinion
 * and every failure is a specific fixable thing.
 *
 * Correctness against a human answer key is the third question and it is not
 * answered here by default, because there is no honest way to write the key
 * from the code. Drop a JSON file beside this one to supply it — see
 * `LABELS_FILE` below — and the references it names are scored for precision
 * and recall. Absent, that section says so rather than inventing a number.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyReferences, describeEntities } from "@freebirdai/dash-agent";
import type { CatalogEntry, EntitySpec } from "@freebirdai/dash-spec";
import { catalogEntrySchema } from "@freebirdai/dash-spec";
import { loadEnvFile } from "../env.js";
import { llmForModel, llmFromEnv, llmSpend, resetLlmSpend } from "../llm.js";
import { formatUsd } from "../pricing.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile({ startDir: here });

const root = resolve(process.env.DASH_ROOT ?? join(here, "..", ".."));

/**
 * An answer key, if somebody has written one.
 *
 * `{ "<catalog id>": { "<entity>.<field>": "<target entity>" | null } }`,
 * where null means "this field is not a link". Only the fields it names are
 * scored, so a partial key is useful immediately — twenty fields somebody is
 * sure about beats sixty they guessed at.
 */
const LABELS_FILE = join(here, "entities.labels.json");

type AnswerKey = Readonly<Record<string, Readonly<Record<string, string | null>>>>;

const answerKey = (): AnswerKey => {
  if (!existsSync(LABELS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LABELS_FILE, "utf8")) as AnswerKey;
  } catch (error) {
    console.warn(`  ! ${LABELS_FILE} did not parse: ${(error as Error).message}`);
    return {};
  }
};

const entriesOn = (dir: string): CatalogEntry[] => {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const parsed = catalogEntrySchema.safeParse(
        JSON.parse(readFileSync(join(dir, name), "utf8")),
      );
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
};

/** Overlay wins over seed, the same way `CatalogStore` reads them. */
const catalog = (): CatalogEntry[] => {
  const merged = new Map<string, CatalogEntry>();
  for (const entry of entriesOn(join(root, "..", "..", "catalog"))) merged.set(entry.id, entry);
  for (const entry of entriesOn(join(root, ".dash", "catalog"))) merged.set(entry.id, entry);
  return [...merged.values()];
};

/* ── what can be said without an opinion ─────────────────────────────────── */

interface Soundness {
  readonly entities: number;
  readonly withIdentity: number;
  readonly withName: number;
  readonly references: number;
  /** Links naming a record type this API does not have. Should be zero. */
  readonly danglingReferences: number;
  readonly fieldsDescribed: number;
  readonly fieldsTotal: number;
}

const soundness = (entities: readonly EntitySpec[]): Soundness => {
  const known = new Set(entities.map((entity) => entity.id));
  let references = 0;
  let dangling = 0;
  let described = 0;
  let fields = 0;
  for (const entity of entities) {
    for (const field of entity.fields) {
      fields += 1;
      if (field.description) described += 1;
      if (!field.reference) continue;
      references += 1;
      if (!known.has(field.reference.entity)) dangling += 1;
    }
  }
  return {
    entities: entities.length,
    withIdentity: entities.filter((one) => one.identity).length,
    withName: entities.filter((one) => one.display).length,
    references,
    danglingReferences: dangling,
    fieldsDescribed: described,
    fieldsTotal: fields,
  };
};

/* ── does it say the same thing twice ────────────────────────────────────── */

const referenceMap = (entities: readonly EntitySpec[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.reference) map.set(`${entity.id}.${field.path}`, field.reference.entity);
    }
  }
  return map;
};

const pct = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}%`;

const agreement = (before: readonly EntitySpec[], after: readonly EntitySpec[]): void => {
  const was = new Map(before.map((entity) => [entity.resource, entity]));
  const now = new Map(after.map((entity) => [entity.resource, entity]));
  const shared = [...now.keys()].filter((id) => was.has(id));

  const sameIdentity = shared.filter(
    (id) => was.get(id)!.identity?.field === now.get(id)!.identity?.field,
  ).length;
  const sameKind = shared.filter((id) => was.get(id)!.kind === now.get(id)!.kind).length;

  const oldRefs = referenceMap(before);
  const newRefs = referenceMap(after);
  let agreed = 0;
  let moved = 0;
  for (const [key, target] of newRefs) {
    const previous = oldRefs.get(key);
    if (previous === undefined) continue;
    if (previous === target) agreed += 1;
    else moved += 1;
  }
  const dropped = [...oldRefs.keys()].filter((key) => !newRefs.has(key)).length;
  const added = [...newRefs.keys()].filter((key) => !oldRefs.has(key)).length;

  console.log(`  record types described both times: ${shared.length} of ${now.size}`);
  console.log(`  same identity field:  ${sameIdentity}/${shared.length} (${pct(sameIdentity, shared.length)})`);
  console.log(`  same kind:            ${sameKind}/${shared.length} (${pct(sameKind, shared.length)})`);
  console.log(
    `  links: ${agreed} agreed, ${moved} re-pointed, ${dropped} dropped, ${added} new` +
      ` (${pct(agreed, agreed + moved + dropped)} stable)`,
  );
};

/* ── against a human answer key, when there is one ───────────────────────── */

const scoreAgainstKey = (entities: readonly EntitySpec[], key: Readonly<Record<string, string | null>>): void => {
  const found = referenceMap(entities);
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const wrong: string[] = [];

  for (const [field, expected] of Object.entries(key)) {
    const actual = found.get(field);
    if (expected === null) {
      if (actual !== undefined) {
        falsePositive += 1;
        wrong.push(`${field} → ${actual} (should be no link)`);
      }
      continue;
    }
    if (actual === expected) truePositive += 1;
    else if (actual === undefined) {
      falseNegative += 1;
      wrong.push(`${field} → nothing (should be ${expected})`);
    } else {
      falsePositive += 1;
      falseNegative += 1;
      wrong.push(`${field} → ${actual} (should be ${expected})`);
    }
  }

  const precision = truePositive + falsePositive;
  const recall = truePositive + falseNegative;
  console.log(
    `  against the answer key: precision ${pct(truePositive, precision)}, ` +
      `recall ${pct(truePositive, recall)} over ${Object.keys(key).length} labelled field(s)`,
  );
  for (const line of wrong.slice(0, 12)) console.log(`    ✗ ${line}`);
};

/* ── run ─────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const modelAt = args.indexOf("--model");
const model = modelAt >= 0 ? args[modelAt + 1] : undefined;
/*
 * The `--model` value is the one positional that is not a catalog id, and it
 * only exists when the flag does. Deriving "skip index modelAt + 1" without
 * that guard skips index 0 whenever the flag is absent — which silently drops
 * the entry somebody named and runs this against everything on disk instead.
 * It spends money, so getting it wrong is not free.
 */
const skip = modelAt >= 0 ? modelAt + 1 : -1;
const wanted = args.filter((arg, index) => !arg.startsWith("--") && index !== skip);
const dryRun = args.includes("--dry-run");

const llm = dryRun ? null : model ? llmForModel(model) : llmFromEnv("eval:entities");
if (!llm && !dryRun) {
  console.error("No model available. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  process.exit(1);
}

const key = answerKey();
const described = catalog().filter(
  (entry) => (entry.entities?.length ?? 0) > 0 && (wanted.length === 0 || wanted.includes(entry.id)),
);

if (described.length === 0) {
  console.error(
    wanted.length > 0
      ? `Nothing described for: ${wanted.join(", ")}`
      : "No described API on disk. Describe one first — this compares a fresh reading with a stored one.",
  );
  process.exit(1);
}

for (const entry of described) {
  console.log(`\n${entry.title} (${entry.id})`);
  const stored = entry.entities ?? [];

  console.log("\n  stored:");
  const before = soundness(stored);
  console.log(
    `  ${before.entities} record type(s) — ${before.withIdentity} can open a page, ` +
      `${before.withName} can say a record's name`,
  );
  console.log(
    `  ${before.references} link(s), ${before.danglingReferences} pointing at nothing; ` +
      `${before.fieldsDescribed}/${before.fieldsTotal} field(s) described`,
  );
  if (key[entry.id]) scoreAgainstKey(stored, key[entry.id]!);

  if (dryRun) {
    console.log("  --dry-run: stopping before anything is spent.");
    continue;
  }

  resetLlmSpend();
  const started = Date.now();
  const described = await describeEntities(llm!, {
    apiTitle: entry.title,
    resources: entry.resources,
    ops: entry.ops.map((op) => ({
      id: op.id,
      title: op.title,
      path: op.path,
      ...(op.description ? { description: op.description } : {}),
      ...(op.fields ? { fields: op.fields } : {}),
    })),
  }, { ...(model ? { model } : {}) });

  /*
   * And the second pass, because the first one writes no links at all. Reading
   * what a record *is* and deciding which of its fields point at another are
   * separate calls, and comparing a reading that skipped the second against a
   * stored one that had it reports every link as dropped — which looks like a
   * catastrophic regression and is only a broken measurement.
   */
  const pathOf = (id: string): string | undefined => {
    const listOp = entry.resources.find((resource) => resource.id === id)?.listOp;
    return listOp ? entry.ops.find((op) => op.id === listOp)?.path : undefined;
  };
  const fresh =
    described.entities.length > 0
      ? await classifyReferences(
          llm!,
          { apiTitle: entry.title, entities: described.entities, pathOf },
          { ...(model ? { model } : {}) },
        )
      : { ...described, considered: 0, linked: 0 };

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\n  re-read with ${model ?? llm!.defaultModel} in ${seconds}s, ${formatUsd(llmSpend().usd)}:`);
  const after = soundness(fresh.entities);
  console.log(
    `  ${after.entities} record type(s) — ${after.withIdentity} can open a page, ` +
      `${after.withName} can say a record's name`,
  );
  console.log(
    `  ${after.references} link(s), ${after.danglingReferences} pointing at nothing; ` +
      `${after.fieldsDescribed}/${after.fieldsTotal} field(s) described`,
  );
  const failed = described.errors.length + fresh.errors.length;
  const refused = described.skipped.length + fresh.skipped.length;
  if (failed > 0) console.log(`  ${failed} batch(es) failed`);
  if (refused > 0) console.log(`  ${refused} proposal(s) refused`);

  console.log("\n  agreement between the two readings:");
  agreement(stored, fresh.entities);
  if (key[entry.id]) scoreAgainstKey(fresh.entities, key[entry.id]!);
}

if (Object.keys(key).length === 0) {
  console.log(
    `\nNo answer key at ${LABELS_FILE}, so nothing above is scored for correctness — ` +
      "only for agreement and soundness. See the note at the top of this file for its shape.",
  );
}
