# @freebirdai/embed — AI integration guide

Instructions for an AI assistant adding the FreeBird chat widget to a static site, SSG output, or any page without a build step.

## What this is

A script-tag chat widget: `<freebird-chat>` renders in an isolated Shadow DOM, scans the page for declaratively-registered components, and talks to a FreeBird backend. The assistant can highlight/scroll-to/fill/click registered regions (local-DOM actions) and cite page sections.

Use when the host site is plain HTML, an SSG, or WordPress. For React/Vue/Angular apps, prefer the framework bindings — the embed also works there but gives up native integration.

## Install

No build step — one script tag before `</body>`:

```html
<script
  src="/freebird.js"          <!-- serve the built dist/freebird.js from your host or CDN -->
  data-api="/freebird"        <!-- your @freebirdai/server mount (self-hosted mode) -->
  defer
></script>
```

Managed backend instead: `data-site-id="fb_abc123" data-api="https://api.your-backend.example"`.

Bundler alternative: `pnpm add @freebirdai/embed` then `import { start } from "@freebirdai/embed"; start({ api: "/freebird", ... })`.

## Minimal integration

1. Add the script tag (above).
2. Mark up the regions the assistant should know about — no JS needed:

```html
<section
  id="hours"
  data-freebird-component="openingHours"
  data-freebird-title="Opening hours"
  data-freebird-description="Our weekly opening hours"
  data-freebird-tags="hours,contact"
>
  <span data-freebird-field="monday" data-freebird-field-description="Monday hours">9–17</span>
</section>
```

The scanner compiles these into a `@freebirdai/manifest` RegistrationManifest, sends it on handshake, and re-scans on DOM changes via MutationObserver.

3. On the server, compile the pushed manifest with `@freebirdai/manifest`'s `compileServerRegistry` (see that package's AGENTS.md).

## Key APIs

- Script attributes: `data-site-id`, `data-api`, `data-chat-path` (default `/freebird`), `data-scan` (default true), `data-snapshots`, `data-position` (`bottom-right` | `bottom-left` | `full-right` | `full-left`), `data-title`, `data-placeholder`, `data-accent`
- `window.FreeBird.register({ id, title, description, kind: "dom-region", source: { selector } })` — imperative registration
- `window.FreeBird.open()` / `.close()`
- Module exports: `start(config)`, `scanDocument`, `observeComponents`, `captureSnapshots`, `createLocalActionExecutor`, `PENDING_ACTION_KEY`
- Theming: `freebird-chat { --freebird-accent: #b4231f; --freebird-radius: 8px; }`

## Local-DOM actions

The assistant's `highlight`, `scroll-to`, `show-in-chat` run without confirmation; `fill-form` and `click` preview first. Cross-page directives stash the pending action in sessionStorage, navigate, and replay on arrival. All of this is built in — no host code needed beyond the `data-freebird-*` markup.

## Works with

- `@freebirdai/server` + `@freebirdai/manifest` — the self-hosted backend pair.
- `freebird-wp` (integrations/wordpress) — WordPress plugin that injects this embed and pushes content.
- `@freebirdai/codegen` `static` target — emits the wiring steps for embed-only sites.

## Common pitfalls

- **Widget doesn't appear** → the script must load on the page (check network tab) and `data-api` must point at a reachable FreeBird mount; CORS applies in managed mode.
- **Components not registered** → `data-freebird-component` values must be unique; duplicates keep the first and warn in the console.
- **Styles clash** → they can't (Shadow DOM); if the widget looks unstyled, the JS failed to load — don't add CSS workarounds.
- **fill-form does nothing** → field elements need `data-freebird-field` names matching the action args, or real `name` attributes.
- **Highlight fails after navigation** → the target page must also load the embed script; replay runs there.

## Verify

Open the page, click the launcher, ask "what are your opening hours?" — the reply should reference the marked-up content, and asking "show me" should scroll to and pulse-highlight the section. `examples/static-embed` in the FreeBird repo is a full runnable reference (works offline with an echo LLM).
