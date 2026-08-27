#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  generateIntegration,
  identFor,
  diffIds,
  canonicalIds,
  type Framework,
} from "@freebirdai/codegen";
import { parseManifest, type RegistrationManifest } from "@freebirdai/manifest";
import { detectFramework, idsDeclaredIn, idsReferencedIn } from "./detect.js";

const FRAMEWORKS: Framework[] = ["next", "react", "vue", "static"];
const MANIFEST_NAME = "freebird.manifest.json";

interface Args {
  command: string | undefined;
  flags: Record<string, string | boolean>;
}

const parseArgs = (argv: string[]): Args => {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, flags };
};

const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));

const loadManifest = (cwd: string, flags: Args["flags"]): RegistrationManifest | null => {
  const explicit = typeof flags["manifest"] === "string" ? (flags["manifest"] as string) : null;
  const path = explicit ? resolve(cwd, explicit) : join(cwd, MANIFEST_NAME);
  if (!existsSync(path)) return null;
  return parseManifest(readJson(path));
};

const STARTER_MANIFEST = {
  version: 1,
  components: [
    {
      id: "exampleSection",
      title: "Example section",
      description: "Describe what this part of your site is so the assistant can help visitors with it.",
      kind: "dom-region",
      source: { selector: "#example" },
    },
  ],
};

const resolveFramework = (cwd: string, flags: Args["flags"]): Framework => {
  const override = flags["framework"];
  if (typeof override === "string") {
    if (!FRAMEWORKS.includes(override as Framework)) {
      fail(`unknown --framework "${override}". Expected one of: ${FRAMEWORKS.join(", ")}`);
    }
    return override as Framework;
  }
  const pkgPath = join(cwd, "package.json");
  const pkg = existsSync(pkgPath) ? readJson(pkgPath) : null;
  return detectFramework(pkg, existsSync(join(cwd, "index.html")));
};

const runInit = (cwd: string, flags: Args["flags"]): number => {
  const framework = resolveFramework(cwd, flags);
  let manifest = loadManifest(cwd, flags);
  if (!manifest) {
    if (flags["scaffold"]) {
      writeFileSync(join(cwd, MANIFEST_NAME), JSON.stringify(STARTER_MANIFEST, null, 2) + "\n");
      console.log(`Wrote a starter ${MANIFEST_NAME}. Edit it to describe your components, then run \`freebird init\` again.`);
      return 0;
    }
    console.error(
      `No ${MANIFEST_NAME} found. Create one (see @freebirdai/manifest) or run \`freebird init --scaffold\` to start from a template.`,
    );
    return 1;
  }

  const outDir = typeof flags["out"] === "string" ? (flags["out"] as string) : undefined;
  const result = generateIntegration(manifest, {
    framework,
    ...(outDir ? { outDir } : {}),
  });

  const dryRun = Boolean(flags["dry-run"]);
  console.log(`FreeBird integration for framework: ${framework}`);
  for (const file of result.files) {
    if (dryRun) {
      console.log(`  would write ${file.path}`);
    } else {
      const abs = join(cwd, file.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.contents);
      console.log(`  wrote ${file.path}`);
    }
  }
  for (const w of result.warnings) console.log(`  note: ${w}`);

  if (result.steps.length) {
    console.log(`\nNext steps (${result.steps.length}):`);
    for (const step of result.steps) {
      const tag = step.automatable ? "[auto]" : "[manual]";
      console.log(`  ${tag} ${step.title}`);
      console.log(`         ${step.detail}`);
    }
  }
  return 0;
};

const runCheck = (cwd: string, flags: Args["flags"]): number => {
  const manifest = loadManifest(cwd, flags);
  if (!manifest) {
    console.error(`No ${MANIFEST_NAME} found to check against.`);
    return 1;
  }
  const outDir = typeof flags["out"] === "string" ? (flags["out"] as string) : "src/freebird";
  const expected = canonicalIds(manifest).map(identFor).sort();

  // Parse whichever generated registry files exist.
  const sources: Record<string, string[]> = {};
  const idsPath = join(cwd, outDir, "ids.ts");
  if (existsSync(idsPath)) sources["ids"] = idsDeclaredIn(readFileSync(idsPath, "utf8"));
  for (const [label, file] of [
    ["client", "client-registry.tsx"],
    ["client", "client-registry.ts"],
    ["server", "server-registry.ts"],
  ] as const) {
    const p = join(cwd, outDir, file);
    if (existsSync(p)) sources[label] = idsReferencedIn(readFileSync(p, "utf8"));
  }

  if (Object.keys(sources).length === 0) {
    console.error(`No generated registry files found under ${outDir}. Run \`freebird init\` first.`);
    return 1;
  }

  let ok = true;
  for (const [label, ids] of Object.entries(sources)) {
    const drift = diffIds(expected, ids);
    if (drift.missing.length || drift.extra.length) {
      ok = false;
      if (drift.missing.length) console.error(`  ${label}: missing ${drift.missing.join(", ")}`);
      if (drift.extra.length) console.error(`  ${label}: unexpected ${drift.extra.join(", ")}`);
    }
  }
  if (ok) {
    console.log(`✓ FreeBird registries in sync (${expected.length} ids).`);
    return 0;
  }
  console.error("✗ FreeBird registry drift detected. Re-run `freebird init` to regenerate.");
  return 1;
};

const HELP = `freebird — scaffold and maintain a FreeBird integration

Usage:
  freebird init  [--framework next|react|vue|static] [--manifest <path>] [--out <dir>] [--dry-run] [--scaffold]
  freebird check [--manifest <path>] [--out <dir>]

init   Generate the FreeBird registry files + wiring steps from your manifest.
check  Verify the generated registries have not drifted from the manifest ids.
`;

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const main = (): void => {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const cwd = typeof flags["cwd"] === "string" ? resolve(flags["cwd"] as string) : process.cwd();
  switch (command) {
    case "init":
      process.exit(runInit(cwd, flags));
      break;
    case "check":
      process.exit(runCheck(cwd, flags));
      break;
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      process.exit(0);
      break;
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exit(1);
  }
};

main();
