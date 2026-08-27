# @freebirdai/manifest

The **Registration Manifest** is FreeBird's declarative, JSON-serializable description of a site's components — the interchange format between everything that *discovers* components and everything that *serves* them.

```
Producers                              Consumers
─────────────────────────────          ─────────────────────────────────────
@freebirdai/embed DOM scanner      →     compileServerRegistry()  (managed / multi-tenant backends)
freebird-wp content push         →     @freebirdai/codegen        (generates real registry files)
Studio / analysis tooling        →
```

## Why it exists

A hand-written FreeBird integration keeps component ids in sync across a client registry, a server registry, and a canonical id list. The manifest collapses those into one document: producers emit it, `canonicalIds()` / `diffManifestIds()` validate against it, and consumers compile it.

Security property: a manifest is **pure data**. Actions declared in a manifest are restricted to a fixed allowlist — local DOM directives (executed by the embed in the visitor's browser), ticket filing, and *named* webhooks resolved by the host. URLs never live in the manifest, so a manifest scanned from an untrusted page cannot introduce code execution or exfiltration targets.

## Quick start

```ts
import { parseManifest, compileServerRegistry } from "@freebirdai/manifest";

const manifest = parseManifest({
  version: 1,
  siteId: "fb_abc123",
  components: [
    {
      id: "openingHours",
      title: "Opening hours",
      description: "The restaurant's weekly opening hours.",
      kind: "dom-region",
      source: { selector: "#hours" },
      actions: [
        { id: "show_hours", description: "Scroll the visitor to the hours", kind: "local-dom", directive: "scroll-to" },
      ],
    },
  ],
});

const registry = compileServerRegistry(manifest, {
  getSnapshot: (componentId, ctx) => snapshotStore.latest(manifest.siteId!, componentId),
  fileTicket: (draft, meta, ctx) => ticketSink.fileTicket(stamp(draft, ctx)),
  resolveWebhook: (name) => webhookConfig.forSite(manifest.siteId!, name),
});
// → pass `registry` to createFreeBirdRouter / route handlers as usual
```

## Component kinds

| kind | source requirement | produced by |
|---|---|---|
| `framework-component` | `source.file` (+ optional `exportName`) | Studio analysis / codegen |
| `dom-region` | `source.selector` | `@freebirdai/embed` scanner, `data-freebird-*` attributes |
| `wp-content` | `source.wpType` (+ optional `wpId`) | `freebird-wp` content push |

## Local-DOM action contract

`local-dom` action handlers don't mutate anything server-side — they return a `LocalActionResult` payload (`kind: "freebird.local-dom"`). The FreeBird server streams it like any action result; `@freebirdai/embed` recognizes it via `isLocalActionResult()` and executes the directive (`highlight`, `scroll-to`, `show-in-chat`, `fill-form`, `click`) against the component's registered region. Directives that change page state (`fill-form`, `click`) default to `requiresConfirmation: "preview"`.

## API

- `parseManifest(json)` / `safeParseManifest(json)` — validate unknown input.
- `canonicalIds(manifest)` / `diffIds(expected, actual)` / `diffManifestIds(manifest, registeredIds)` — drift detection.
- `mergeManifests(base, incoming)` — upsert-by-id merge for re-scans and content pushes.
- `compileServerRegistry(manifest, hooks)` — idempotent (upserts) compile into a `ComponentRegistry`.
- `buildLocalActionResult` / `isLocalActionResult` / `LOCAL_ACTION_RESULT_KIND` — the embed wire contract.
- `DEFAULT_MANIFEST_GRID` — grid applied when an entry declares none.
