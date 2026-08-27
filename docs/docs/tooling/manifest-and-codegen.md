# Manifest & codegen

Two packages turn a declarative description of your site into a working FreeBird integration:

- **`@freebirdai/manifest`** — the **Registration Manifest**: a JSON-serializable description of a site's components, and compilers that turn it into live registries.
- **`@freebirdai/codegen`** — deterministic code generation from a manifest: registry files, route wiring, and step-by-step integration instructions.

## The Registration Manifest

The manifest is the interchange format between everything that *discovers* components and everything that *serves* them:

```
Producers                              Consumers
─────────────────────────────          ─────────────────────────────────────
@freebirdai/embed DOM scanner      →     compileServerRegistry()  (managed / multi-tenant backends)
freebird-wp content push         →     @freebirdai/codegen        (generates real registry files)
analysis tooling                 →
```

A hand-written FreeBird integration keeps component ids in sync across a client registry, a server registry, and a canonical id list. The manifest collapses those into one document: producers emit it, `canonicalIds()` / `diffManifestIds()` validate against it, and consumers compile it.

**Security property:** a manifest is *pure data*. Actions declared in a manifest are restricted to a fixed allowlist — local DOM directives (executed by the embed in the visitor's browser), ticket filing, and *named* webhooks resolved by the host. URLs never live in the manifest, so a manifest scanned from an untrusted page cannot introduce code execution or exfiltration targets.

### Quick start

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
  knowledge: [
    "We are closed on public holidays.",
    { id: "kb_parking", text: "Free parking behind the building.", source: { page: "/about", selector: "#parking" } },
  ],
});

const registry = compileServerRegistry(manifest, {
  getSnapshot: (componentId, ctx) => snapshotStore.latest(manifest.siteId!, componentId),
  fileTicket: (draft, meta, ctx) => ticketSink.fileTicket(draft),
  resolveWebhook: (name) => webhookConfig.forSite(manifest.siteId!, name),
});
// → pass `registry` to the route handlers as usual
```

### Component kinds

| kind | source requirement | produced by |
|---|---|---|
| `framework-component` | `source.file` (+ optional `exportName`) | analysis tooling / codegen |
| `dom-region` | `source.selector` | `@freebirdai/embed` scanner, `data-freebird-*` attributes |
| `wp-content` | `source.wpType` (+ optional `wpId`) | `freebird-wp` content push |

### Site knowledge

Top-level `knowledge` entries hold site-wide facts the assistant can use and cite. The plain-string shorthand is the quickest form; the object form adds a stable `id` (required for `[[cite:id]]` citability) and a `source` location so citation chips can deep-link to the exact page section. See [Knowledge & references](../concepts/knowledge-and-references.md).

### Local-DOM action contract

`local-dom` action handlers don't mutate anything server-side — they return a `LocalActionResult` payload (`kind: "freebird.local-dom"`). The server streams it like any action result; `@freebirdai/embed` recognizes it via `isLocalActionResult()` and executes the directive (`highlight`, `scroll-to`, `show-in-chat`, `fill-form`, `click`) against the component's registered region. Directives that change page state (`fill-form`, `click`) default to `requiresConfirmation: "preview"`.

### Manifest API

- `parseManifest(json)` / `safeParseManifest(json)` — validate unknown input.
- `canonicalIds(manifest)` / `diffIds(expected, actual)` / `diffManifestIds(manifest, registeredIds)` — drift detection.
- `mergeManifests(base, incoming)` — upsert-by-id merge for re-scans and content pushes.
- `compileServerRegistry(manifest, hooks)` — idempotent (upserts) compile into a `ComponentRegistry`.
- `buildLocalActionResult` / `isLocalActionResult` / `LOCAL_ACTION_RESULT_KIND` — the embed wire contract.
- `DEFAULT_MANIFEST_GRID` — grid applied when an entry declares none.

## Codegen

`@freebirdai/codegen` turns a manifest into the files and wiring an integration needs. It is deterministic and side-effect-free — it returns strings and steps; the caller decides what to write. The [`freebird` CLI](./create-freebird.md) is the main consumer.

The single most important thing it generates is `freebird/ids.ts`: **one** canonical id map imported by both the client and server registries, so id drift is structurally impossible to introduce silently — and `freebird check` catches it if you edit a registry without regenerating.

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

Wire this into CI via `freebird check` so a registry edited without regenerating fails the build.
