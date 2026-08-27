# static-embed example

A plain HTML page that gets a working, component-aware FreeBird chatbot from a **single script tag** — no build step, no framework — served by a **multi-tenant** backend that hosts two sites from one process.

This is the end-to-end proof of the OSS Phase-1 pieces working together:

```
public/index.html  ──(data-freebird-* + <script>)──►  @freebirdai/embed
                                                          │ handshake + chat
                                                          ▼
server.ts  ──(registry resolver keyed on site id)──►  compileServerRegistry(@freebirdai/manifest)
           ──(createFreeBirdRouter, per-tenant)────►  @freebirdai/server
```

## Run it

```bash
pnpm --filter @freebirdai/embed build      # build the embed bundle the page loads
pnpm --filter freebird-static-embed-example start
# → http://localhost:4100
```

Open the page: a chat launcher appears bottom-right. The assistant is a canned offline echo (no API key needed) — swap `echoLlm` for `@freebirdai/adapters-llm-openai` for real answers.

## What it demonstrates

- **Zero-touch integration** — the page is static HTML; the only FreeBird-specific things are `data-freebird-*` attributes and one `<script>` tag.
- **Declarative registration** — the embed scans the DOM into a `RegistrationManifest` and hands it to the backend at handshake.
- **Multi-tenancy** — `server.ts` hosts two sites (`fb_bakery`, `fb_garage`) with different components. The registry resolver compiles the right manifest per request, keyed on the site id carried in the session token. Change the page's `data-site-id` to `fb_garage` to see a different registry.
- **Local-DOM actions** — the bakery's manifest declares `scroll-to` and `highlight` actions the assistant can trigger in the visitor's browser.
- **Snapshots** — the embed posts DOM snapshots the backend serves as each component's `dataSource`.

The automated version of this verification lives in
`packages/server/src/tenancy.integration.test.ts`.
