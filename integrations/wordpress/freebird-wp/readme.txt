=== FreeBird ===
Contributors: freebird
Tags: ai, chatbot, assistant, support, woocommerce
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.1.0
License: MIT

Add a component-aware FreeBird AI chatbot to your WordPress site and let it help visitors with your pages, posts, and products.

== Description ==

FreeBird adds an AI chat assistant to your site that actually knows what's on the page. It can point visitors at your opening hours, help them fill in your booking form, answer questions about your products, and file support requests — all in natural language.

This plugin:

* Injects the FreeBird embed script (the chat widget renders in an isolated Shadow DOM, so it can't clash with your theme).
* Pushes your page, post, and WooCommerce product content to the FreeBird backend when you save, so the assistant stays current. Uses a signed, outbound-only request — no inbound access to your admin is required, so it works on locked-down shared hosts.
* Provides a `[freebird_component]` shortcode/block to mark any region of a page as something the assistant should know about.
* Exposes a one-time pairing code so you can connect the site to FreeBird Studio in one click.

You need a FreeBird site id and API base (from FreeBird Studio, or your own self-hosted managed backend).

== Installation ==

1. Upload the `freebird-wp` folder to `/wp-content/plugins/`, or install the zip via Plugins → Add New.
2. Activate the plugin.
3. Go to Settings → FreeBird and enter your Site ID and API base URL.
4. To connect FreeBird Studio, enter the one-time pairing code shown on the settings screen into Studio.

== Shortcode ==

Wrap any content so the assistant can find it:

`[freebird_component id="hours" title="Opening hours" description="Our weekly opening hours"]`
`Mon–Fri 9–5`
`[/freebird_component]`

== Frequently Asked Questions ==

= Does this send my content to a third party? =

Content you publish is pushed to the FreeBird backend you configure (FreeBird Studio, or your own self-hosted instance). Pushes are signed with your secret and are outbound-only.

= Does it work with WooCommerce? =

Yes. Products are pushed on save just like pages and posts, and can be annotated with the shortcode.

== Changelog ==

= 0.1.0 =
* Initial release: embed injection, push-model content registration, pairing handshake, and the [freebird_component] shortcode.
