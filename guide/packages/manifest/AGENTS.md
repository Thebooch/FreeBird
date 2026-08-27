# @freebirdai/manifest — AI integration guide

Instructions for an AI assistant working with FreeBird's Registration Manifest.

## What this is

The **Registration Manifest**: a declarative, JSON-serializable description of a site's components and knowledge — the interchange format between everything that discovers components (embed scanner, WordPress push, analysis tooling) and everything that serves them (`compileServerRegistry`, `@freebirdai/codegen`).

Use it when: consuming manifests pushed by the embed/WP plugin on a backend; describing a site's components as data instead of hand-registering; or generating integrations via codegen. Skip it when a hand-written `registry.register(...)` per component is simpler (small, single apps).

Security property to preserve: a manifest is **pure data**. Its actions compile only to a fixed allowlist — local DOM directives, ticket filing, and *named* webhooks resolved by the host. Never extend it to carry URLs or code.

## Install

```bash
pnpm add @freebirdai/manifest @freebirdai/core zod
```

## Minimal integration (serve a manifest-described site)

```ts
import { parseManifest, compileServerRegistry } from "@freebirdai/manifest";

const manifest = parseManifest({
  version: 1,
  siteId: "fb_abc123",
  components: [
    {
      id: "openingHours",
      title: "Opening hours",
      description: "The business's weekly opening hours.",
      kind: "dom-region",
      source: { selector: "#hours", page: "/" },
      actions: [
        { id: "show_hours", description: "Scroll the visitor to the hours", kind: "local-dom", directive: "scroll-to" },
      ],
    },
  ],
  knowledge: [
    "Closed on public holidays.",
    { id: "kb_parking", text: "Free parking behind the building.", source: { page: "/about", selector: "#parking" } },
  ],
});

const registry = compileServerRegistry(manifest, {
  // Required: where component data comes from (usually stored snapshots).
  getSnapshot: (componentId, ctx) => snapshotStore.latest("fb_abc123", componentId),
  // Required only if the manifest declares file-ticket / webhook actions:
  fileTicket: (draft, meta, ctx) => ticketSink.file(draft),
  resolveWebhook: (name) => webhookAllowlist[name] ?? null,   // null = reject
});
// → hand `registry` to @freebirdai/server exactly like a hand-built one
```

`compileServerRegistry` is idempotent (upserts) — recompile after every push/re-scan.

## Key APIs

- `parseManifest(json)` / `safeParseManifest(json)` — validate unknown input
- `compileServerRegistry(manifest, hooks)` — hooks: `getSnapshot` (required), `fileTicket?`, `resolveWebhook?`, `fetchImpl?`, `webhookTimeoutMs?`, `registry?` (append into existing)
- `mergeManifests(base, incoming)` — upsert-by-id merge for re-scans/pushes; preserves base knowledge when incoming has none
- `canonicalIds(manifest)` / `diffManifestIds(manifest, registeredIds)` — drift detection
- `buildLocalActionResult` / `isLocalActionResult` — the embed wire contract for local-DOM directives
- Component kinds: `framework-component` (needs `source.file`), `dom-region` (needs `source.selector`), `wp-content` (needs `source.wpType`)
- `DEFAULT_MANIFEST_GRID` — applied when an entry declares no grid

## Works with

- `@freebirdai/embed` — produces manifests from `data-freebird-*` markup; executes `local-dom` results.
- `@freebirdai/codegen` + `create-freebird` — generate real registry files from a manifest instead of compiling at runtime.
- `@freebirdai/server` — consumes the compiled registry; accepts a per-request registry resolver for multi-tenant backends.

## Common pitfalls

- **Compile throws about hooks** → the manifest declares `file-ticket`/`webhook` actions but `fileTicket`/`resolveWebhook` hooks are missing. Provide them or strip those actions.
- **Re-scan wiped knowledge** → don't rebuild manifests from scratch; use `mergeManifests(stored, incoming)` so knowledge and unrelated components survive partial pushes.
- **Citations can't deep-link** → knowledge items need an `id` (for `[[cite:id]]`) and a `source.page` (site-relative path like `/about`, not a full URL).
- **`fill-form`/`click` execute without confirmation** → they default to preview; only `highlight`/`scroll-to`/`show-in-chat` run unconfirmed. Don't override `requiresConfirmation: "none"` on state-changing directives.

## Verify

`pnpm test` in the package, or in the host: parse a real pushed manifest, compile, then `registry.list()` should show every component with actions attached; run one `local-dom` action via the chat and confirm the embed executes it in the browser.
