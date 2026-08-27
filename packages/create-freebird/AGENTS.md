# create-freebird — AI integration guide

Instructions for an AI assistant scaffolding or maintaining a FreeBird integration with the `freebird` CLI.

## What this is

The CLI over `@freebirdai/codegen`: `freebird init` generates registry files from a `freebird.manifest.json`; `freebird check` fails CI when registries drift from the manifest. Use it whenever a host project has (or should have) a manifest-driven integration. For fully hand-written integrations, it's optional — but `check` is still worth wiring into CI.

## Install / run

```bash
npx create-freebird            # one-shot
# or install for repeat use:
pnpm add -D create-freebird    # provides both `create-freebird` and `freebird` bins
```

## Minimal integration

1. Create a manifest (or scaffold one):

```bash
npx freebird init --scaffold   # writes a starter freebird.manifest.json
```

2. Edit `freebird.manifest.json` — a `@freebirdai/manifest` RegistrationManifest listing the site's components (see that package's AGENTS.md for the schema).

3. Generate:

```bash
freebird init                       # detects framework from package.json / index.html
freebird init --framework vue       # override detection ("next" | "react" | "vue" | "static")
freebird init --manifest ./fb.json  # custom manifest path
freebird init --out app/freebird    # custom output directory (default src/freebird)
freebird init --dry-run             # print what would be written
```

This writes `ids.ts` + client/server registries (+ a route/mount file per framework) and prints a checklist of remaining wiring steps — apply those to the host app.

4. Guard against drift in CI:

```bash
freebird check   # exit 0 = in sync; non-zero prints which side is missing which ids
```

Add it to the host's CI or a `verify` script.

## Key behaviors

- Framework detection: `next` in dependencies → next; `react`/`vue` → those; a bare `index.html` → static.
- Generated registries import ONE canonical `freebird/ids.ts` — never hand-duplicate id lists.
- `init` is regeneration-safe: manifest is the source of truth; hand-edits to generated files are overwritten on the next run.

## Works with

- `@freebirdai/manifest` — the manifest schema and runtime compiler.
- `@freebirdai/codegen` — the generation engine (use directly for programmatic tooling).
- `@freebirdai/server` + UI bindings — the generated files wire these together.

## Common pitfalls

- **Adding a component by editing a registry file** → add it to `freebird.manifest.json` and re-run `freebird init`; direct edits get flagged by `check` and clobbered on regen.
- **`check` fails after a manual registry edit** → that's the tool working; regenerate instead.
- **Wrong framework detected** → pass `--framework` explicitly.

## Verify

```bash
freebird init --dry-run   # sensible file list for the host framework
freebird check            # ✓ FreeBird registries in sync (N ids).
```
