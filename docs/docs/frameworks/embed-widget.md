# Embed widget

`@freebirdai/embed` drops a FreeBird chatbot onto **any** website with a single script tag — no build step, no framework, no code changes to the host page. It covers plain HTML, static-site-generator output, and (via the [WordPress plugin](../integrations/wordpress.md)) WordPress sites.

## Quick start

```html
<script
  src="https://your-host.example/freebird.js"
  data-api="/freebird"
  defer
></script>
```

A launcher button appears bottom-right and the widget talks to your `@freebirdai/server` mount. With a managed backend, set `data-site-id` and point `data-api` at the backend origin instead.

### Script attributes

| Attribute | Default | Meaning |
|---|---|---|
| `data-site-id` | — | Managed-backend site id. Absent → self-hosted mode. |
| `data-api` | `""` | API origin (managed) or path prefix (self-hosted). |
| `data-chat-path` | `/freebird` | Where FreeBird chat routes are mounted. |
| `data-scan` | `true` | Auto-scan the DOM for `data-freebird-*` components. |
| `data-snapshots` | on when `site-id` set | Post component snapshots to the backend. |
| `data-position` | `bottom-right` | `bottom-right` \| `bottom-left` \| `full-right` \| `full-left`. |
| `data-title` / `data-placeholder` / `data-accent` | — | Widget chrome. |

## Registering components declaratively

Any element can tell the assistant it exists — no JavaScript required:

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

The scanner turns these into `dom-region` entries of a [`@freebirdai/manifest`](../tooling/manifest-and-codegen.md) `RegistrationManifest`, sends it to the backend on handshake, and re-scans on DOM changes (SPAs, page builders) via a `MutationObserver`.

## What the assistant can do on a static page

- **Display & navigate** — `highlight`, `scroll-to`, and `show-in-chat` run entirely in the visitor's browser. Cross-page directives stash the pending action, navigate, and replay it on the destination page.
- **Interact** — `fill-form` and `click` manipulate the registered region (preview-confirmed by default).
- **Escalate** — server actions (ticket filing, named webhooks) run in the backend, compiled from your manifest by `@freebirdai/manifest` — never arbitrary code from the page.

The LLM emits these as action results; the embed recognizes the `freebird.local-dom` result shape and executes the directive against the component's registered region.

## The widget is isolated

`<freebird-chat>` renders in a **Shadow DOM** with its styles injected into the shadow root. The host page's CSS cannot leak in and the widget's CSS cannot leak out. Theme it with CSS custom properties:

```css
freebird-chat { --freebird-accent: #b4231f; --freebird-radius: 8px; }
```

## Imperative escape hatch

Skip the attributes and drive registration in JavaScript:

```js
window.FreeBird.register({
  id: "pricingTable",
  title: "Pricing",
  description: "Our plan pricing table",
  kind: "dom-region",
  source: { selector: "#pricing" },
});
window.FreeBird.open();
```

Bundler users import `{ start }` from `@freebirdai/embed` and pass an explicit `EmbedConfig` instead of relying on the script-tag autostart.

## Try it

The repo ships a runnable example: [`examples/static-embed`](https://github.com/Thebooch/FreeBird/tree/main/examples/static-embed) — plain HTML pages, an Express server with an offline echo LLM, declarative registration, local-DOM actions, and knowledge citations with cross-page navigation.
