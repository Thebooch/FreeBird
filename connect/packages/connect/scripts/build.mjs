// Compiles with tsc rather than bundling, so each module keeps its own path
// under dist/ (Dash imports them by path until phase 4 narrows the surface),
// then copies the sandbox's plain-JS files beside the code that loads them.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
for (const file of ["connector/prelude.js", "connector/worker.mjs"]) {
  const to = join(root, "dist", file);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, "src", file), to);
}
