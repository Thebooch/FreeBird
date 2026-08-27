# @freebirdai/codegen — AI integration guide

Instructions for an AI assistant generating FreeBird integration code from a manifest.

## What this is

Deterministic, side-effect-free code generation: a `@freebirdai/manifest` RegistrationManifest in, registry files + wiring steps out. It returns strings — the caller decides what to write. The `freebird` CLI (`create-freebird`) is the main consumer; call this directly when building tooling or applying generation programmatically.

The key output is `freebird/ids.ts` — one canonical id map imported by both client and server registries, making id drift structurally impossible.

## Install

```bash
pnpm add @freebirdai/codegen @freebirdai/manifest
```

## Minimal integration

```ts
import { generateIntegration, checkDrift } from "@freebirdai/codegen";
import { parseManifest } from "@freebirdai/manifest";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const manifest = parseManifest(JSON.parse(readFileSync("freebird.manifest.json", "utf8")));

const result = generateIntegration(manifest, { framework: "next" }); // "next" | "react" | "vue" | "static"

for (const file of result.files) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.contents);
}
for (const step of result.steps) {
  // step: { title, detail, automatable } — automatable steps are safe
  // append-only edits a tool may apply; the rest need a human/edit engine.
  console.log(`${step.automatable ? "[auto]" : "[manual]"} ${step.title}: ${step.detail}`);
}
```

## What each target emits

| target | files |
|---|---|
| `next` | `src/freebird/ids.ts`, `client-registry.tsx`, `server-registry.ts`, `app/freebird/[...route]/route.ts` |
| `react` / `vue` | `ids.ts`, `client-registry.{tsx,ts}`, `server-registry.ts`, `server.ts` (Express mount) |
| `static` | no files — embed-only wiring steps (use `@freebirdai/embed`) |

## Drift checking (CI)

```ts
checkDrift(manifest, {
  client: idsFromClientRegistry,   // string[] actually registered
  server: idsFromServerRegistry,
});
// → { ok, bySource: { client: { missing, extra }, server: {...} }, messages }
```

Prefer wiring `freebird check` (from `create-freebird`) into CI rather than calling this yourself.

## Works with

- `@freebirdai/manifest` — input format; validate with `parseManifest` first.
- `create-freebird` — the CLI wrapper (`freebird init` / `freebird check`); use it instead of this package when a human is driving.
- `@freebirdai/server` / UI bindings — the generated files import them.

## Common pitfalls

- **Editing generated registries by hand** → edits survive until the next `generateIntegration` run; add components to the manifest and regenerate, or you'll trip `checkDrift`.
- **Writing files without creating directories** → outputs contain nested paths; `mkdirSync(dirname(p), { recursive: true })` first.
- **Skipping the steps array** → generation alone isn't a working app; the `steps` cover the wiring into existing app files (provider install, server mount).

## Verify

Generate into a temp dir and confirm: `ids.ts` exports every manifest component id; both registries import from it; `checkDrift` with the generated ids returns `ok: true`.
