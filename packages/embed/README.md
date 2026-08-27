# @freebirdai/embed

Drop a FreeBird chatbot onto **any** website with a single script tag — no build step, no framework, no code changes to the host page. This is the distribution FreeBird was missing: plain HTML, static-site-generator output, and (via `freebird-wp`) WordPress.

## Quick start

```html
<script
  src="https://cdn.freebird.dev/v1/freebird.js"
  data-site-id="fb_abc123"
  data-api="https://api.freebird.cloud"
  defer
></script>
```

That's it — a launcher button appears bottom-right, and the widget talks to your managed FreeBird backend. Drop the `data-site-id`/`data-api` and point `data-api` at your own `@freebirdai/server` mount to self-host.

### Script attributes

| attribute | default | meaning |
|---|---|---|
| `data-site-id` | — | Managed-backend site id. Absent → self-hosted mode. |
| `data-api` | `""` | API origin (managed) or path prefix (self-hosted). |
| `data-chat-path` | `/freebird` | Where FreeBird chat routes are mounted. |
| `data-scan` | `true` | Auto-scan the DOM for `data-freebird-*` components. |
| `data-snapshots` | on when `site-id` set | Post component snapshots to the backend. |
| `data-position` | `bottom-right` | `bottom-right` \| `bottom-left`. |
| `data-title` / `data-placeholder` / `data-accent` | — | Widget chrome. |

## Registering components declaratively

Any element can tell the assistant it exists — no JS:

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

The scanner turns these into `dom-region` entries of a `@freebirdai/manifest` `RegistrationManifest`, sends it to the backend on handshake, and re-scans on DOM changes (SPAs, page builders) via a `MutationObserver`.

## What the assistant can do without a server on your site

- **Display & navigate** — `highlight`, `scroll-to`, and `show-in-chat` run entirely in the visitor's browser.
- **Interact** — `fill-form` and `click` manipulate the registered region (preview-confirmed by default).
- **Escalate** — server actions (ticket filing, named webhooks) live in the managed backend, compiled from your manifest by `@freebirdai/manifest` — never arbitrary code from the page.

The LLM emits these as action results; the embed recognizes the `freebird.local-dom` result shape and executes the directive against the component's registered region.

## The widget is isolated

`<freebird-chat>` renders in a **Shadow DOM** with its styles injected into the shadow root. The host page's CSS cannot leak in and the widget's CSS cannot leak out. Theme it with CSS custom properties:

```css
freebird-chat { --freebird-accent: #b4231f; --freebird-radius: 8px; }
```

## Imperative escape hatch

Tech-savvy static sites can skip the attributes and drive it in JS:

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

Bundler users import `{ start }` and pass an explicit `EmbedConfig` instead of relying on the script-tag autostart.
