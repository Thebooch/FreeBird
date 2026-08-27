# @freebirdai/codegen

Turn a `@freebirdai/manifest` Registration Manifest into the files and wiring a FreeBird integration needs. Deterministic and side-effect-free — it returns strings and steps; the caller decides what to write. This is the **single source of truth** for integration codegen: the `freebird` CLI and FreeBird Studio both call it.

## Why

A hand-written integration keeps component ids in sync across a client registry, a server registry, and a canonical list — three places, by hand. Codegen emits **one** `freebird/ids.ts` that both registries import, so drift is structurally impossible to introduce silently, and `freebird check` catches it if you edit a registry without regenerating.

## Usage

```ts
import { generateIntegration, checkDrift } from "@freebirdai/codegen";

const result = generateIntegration(manifest, { framework: "vue" });
for (const file of result.files) writeFile(file.path, file.contents);
for (const step of result.steps) console.log(step.title, step.detail);
```

### What it emits

| target | files |
|---|---|
| `next` | `src/freebird/ids.ts`, `client-registry.tsx`, `server-registry.ts`, `app/freebird/[...route]/route.ts` |
| `react` / `vue` | `ids.ts`, `client-registry.{tsx,ts}`, `server-registry.ts`, `server.ts` (Express mount) |
| `static` | no files — embed-only wiring steps (use `@freebirdai/embed`) |

Plus `steps` — the wiring that touches existing app files (plugin install, keep-mounted chat panel, server mount). `automatable` steps are safe append-only operations a tool can apply; the rest are for a human or an edit engine.

### Drift check

```ts
checkDrift(manifest, {
  client: idsFromClientRegistry,
  server: idsFromServerRegistry,
});
// → { ok, bySource: { client: { missing, extra }, ... }, messages }
```
