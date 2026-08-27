# create-freebird

The `freebird` CLI: scaffold and maintain a FreeBird integration from a Registration Manifest.

```bash
npx create-freebird           # or: freebird <command>
```

## Commands

### `freebird init`

Detects your framework (from `package.json` / `index.html`), reads `freebird.manifest.json`, and generates the FreeBird registry files plus a printed checklist of wiring steps.

```bash
freebird init                       # detect framework, generate into src/freebird
freebird init --framework vue       # override detection
freebird init --manifest ./fb.json  # custom manifest path
freebird init --out app/freebird    # custom output directory
freebird init --dry-run             # print what would be written
freebird init --scaffold            # write a starter freebird.manifest.json
```

Generated files import a single canonical `freebird/ids.ts` from both the client and server registries — no more hand-duplicated id lists.

### `freebird check`

Validates that the generated registries haven't drifted from the manifest's component ids. Exits non-zero on drift — wire it into CI.

```bash
freebird check
# ✓ FreeBird registries in sync (12 ids).
# — or —
#   server: missing heroSection
# ✗ FreeBird registry drift detected. Re-run `freebird init` to regenerate.
```

This automated id-parity check catches components registered on one side (client or server) but not the other — the classic drift that creeps into hand-maintained integrations.

## The manifest

`freebird.manifest.json` is a `@freebirdai/manifest` `RegistrationManifest` — a declarative list of your site's components. Write it by hand, generate it with FreeBird Studio, or start from `freebird init --scaffold`.
