# WordPress

The `freebird-wp` plugin (in [`integrations/wordpress`](https://github.com/Thebooch/FreeBird/tree/main/integrations/wordpress)) adds a component-aware FreeBird chat assistant to any WordPress site — including WooCommerce stores — with no theme changes.

## What it does

- **Injects the embed widget** — the chat renders in an isolated Shadow DOM (via [`@freebirdai/embed`](../frameworks/embed-widget.md)), so it can't clash with your theme's CSS.
- **Pushes content on save** — pages, posts, and WooCommerce products are pushed to your FreeBird backend whenever they're saved, so the assistant stays current. Pushes are HMAC-signed and **outbound-only**: no inbound access to wp-admin is required, so it works on locked-down shared hosts.
- **`[freebird_component]` shortcode** — mark any region of a page as something the assistant should know about (and can highlight/scroll to).
- **One-time pairing** — a pairing code on the settings screen connects the site to a managed backend in one click.

## Install

1. Upload the `freebird-wp` folder to `/wp-content/plugins/` (or install the zip via Plugins → Add New).
2. Activate the plugin.
3. Go to **Settings → FreeBird** and enter your Site ID and API base URL — from a managed backend, or your own self-hosted `@freebirdai/server` + `@freebirdai/manifest` setup.

Requires WordPress ≥ 6.0 and PHP ≥ 7.4.

## The shortcode

Wrap any content so the assistant can find, cite, and navigate to it:

```text
[freebird_component id="hours" title="Opening hours" description="Our weekly opening hours"]
Mon–Fri 9–5
[/freebird_component]
```

Shortcode regions become `dom-region` entries in the site's [Registration Manifest](../tooling/manifest-and-codegen.md); pushed posts/products become `wp-content` entries. The backend compiles both into the live registry with `compileServerRegistry`.

## How content pushes work

On `save_post` (and WooCommerce product saves), the plugin sends the content digest to the configured API base, signed with the site secret. The backend merges it into the site's manifest via `mergeManifests` — an upsert-by-id merge, so re-saves refresh entries in place and never clobber components registered by the embed scanner.

## Self-hosting the backend

Point the plugin at your own server: mount `@freebirdai/server`, compile the pushed manifests with `@freebirdai/manifest`, and verify push signatures with the shared site secret. The plugin's REST surface is intentionally small: one pairing endpoint (one-time code) and outbound pushes only.
