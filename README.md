# FreeBird

> An AI-driven website framework. Turn any site's backbone into an LLM-controlled, chat-first experience.

FreeBird is an open-source TypeScript framework that drops an AI chat "backbone" into any website — from a React/Vue/Angular app to a static HTML page or a WordPress site. The chat can **drive your real components**: generate dashboard layouts, run **actions** you define (with previews, confirmation, and auditing), cite the exact page section an answer came from, and email **digests** of live component data on a schedule.

## Highlights

- **Embedded chat UX** that drives your existing components — not a canned widget.
- **Actions layer** — declare Zod-typed actions on components; the LLM collects arguments in conversation, shows a preview card, and executes only after confirmation. Full audit journal, pause/resume, and authorization hooks.
- **Dynamic layout generation** — the LLM picks which registered components to show; a deterministic solver arranges them on a 12-column grid respecting your size hints.
- **Citations & knowledge** — replies grounded in a component's registered knowledge get clickable chips that navigate to, scroll to, and highlight the source. Bring your own embeddings via the retrieval hook.
- **Script-tag embed** — one `<script>` on any static site or WordPress page mounts the chat widget in Shadow DOM, with declarative `data-freebird-*` component registration.
- **Registration Manifest + codegen** — describe your site's components in one JSON manifest; `freebird init` generates the client/server registries and `freebird check` catches id drift in CI.
- **Multi-framework** — headless React, Vue 3, and Angular bindings over one framework-agnostic core, each with an opt-in Tailwind preset.
- **MCP server** — expose your registered components and actions to external AI agents over the Model Context Protocol.
- **Support escalation** — built-in issue classification and ticket drafting/filing when the chat can't resolve something.
- **Per-component locking, custom tabs, and digests** — lock layouts, save them as named tabs, and email periodic summaries of the live data inside them.
- **BYO database / LLM / email** via adapter interfaces, with first-party adapters included.

## Packages

### Core

| Package | Purpose |
|---|---|
| [`@freebirdai/core`](./packages/core) | Framework-agnostic engine: registry, chat, actions, layout, tabs, digests, knowledge, support |
| [`@freebirdai/core-state`](./packages/core-state) | Framework-agnostic client store + HTTP/SSE transport (wrapped by every UI binding) |
| [`@freebirdai/server`](./packages/server) | Route handlers + Express / Fastify / Next.js integrations, middleware, digest scheduler |
| [`@freebirdai/digest-worker`](./packages/digest-worker) | Standalone cron worker for digests (optional, for multi-replica deployments) |

### UI bindings

| Package | Purpose |
|---|---|
| [`@freebirdai/react`](./packages/react) | React provider, hooks, and headless primitives |
| [`@freebirdai/react-tailwind`](./packages/react-tailwind) | Opt-in pre-styled Tailwind preset for React |
| [`@freebirdai/vue`](./packages/vue) | Vue 3 plugin, composables, and headless components |
| [`@freebirdai/vue-tailwind`](./packages/vue-tailwind) | Opt-in pre-styled Tailwind preset for Vue |
| [`@freebirdai/angular`](./packages/angular) | Angular 17–20 provider, signals service, and standalone components |
| [`@freebirdai/embed`](./packages/embed) | Script-tag chat widget (Shadow DOM) + declarative registration for static sites |

### Tooling

| Package | Purpose |
|---|---|
| [`@freebirdai/manifest`](./packages/manifest) | Registration Manifest schema + compiler into live registries |
| [`@freebirdai/codegen`](./packages/codegen) | Manifest → registry files, route wiring, and integration steps |
| [`create-freebird`](./packages/create-freebird) | CLI: `freebird init` scaffolds an integration, `freebird check` catches registry drift |
| [`@freebirdai/mcp`](./packages/mcp) | MCP server exposing components/actions to external AI agents |

### Adapters

| Package | Purpose |
|---|---|
| [`@freebirdai/adapters-db-postgres`](./packages/adapters-db-postgres) | Postgres (Kysely) persistence |
| [`@freebirdai/adapters-db-prisma`](./packages/adapters-db-prisma) | Prisma persistence |
| [`@freebirdai/adapters-llm-openai`](./packages/adapters-llm-openai) | OpenAI LLM adapter (+ cost estimation) |
| [`@freebirdai/adapters-llm-anthropic`](./packages/adapters-llm-anthropic) | Anthropic Claude LLM adapter |
| [`@freebirdai/adapters-email-resend`](./packages/adapters-email-resend) | Resend email adapter |
| [`@freebirdai/adapters-email-smtp`](./packages/adapters-email-smtp) | SMTP (Nodemailer) email adapter |

## Quick start

**Most readers should start with the full [Getting Started guide](./GETTING_STARTED.md).**
It walks you from zero to a running FreeBird app in ~15 minutes, covering the
registry model, server wiring, client wiring, Tailwind preset, the hero
features, production adapters, digests, auth, and testing.

To run the reference app directly:

```bash
pnpm install
pnpm build
OPENAI_API_KEY=sk-... pnpm --filter freebird-next-starter dev
```

Reference apps:

- [`examples/next-starter`](./examples/next-starter) — Next.js 15 App Router + Tailwind
- [`examples/vite-express`](./examples/vite-express) — Vite SPA + Express API
- [`examples/static-embed`](./examples/static-embed) — plain HTML + the script-tag embed widget
- [`integrations/wordpress`](./integrations/wordpress) — WordPress/WooCommerce plugin

## Documentation

- [Getting Started](./GETTING_STARTED.md) — the end-to-end walkthrough
- [Actions guide](./ACTIONS.md) — the LLM action layer in depth
- [Docs site](./docs) — concepts, package guides, and recipes (`pnpm --filter freebird-docs start`)
- [AGENTS.md](./AGENTS.md) — a map of the repo for AI coding assistants; every major package also ships its own `AGENTS.md` integration guide

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Development is `pnpm install && pnpm build && pnpm test`; CI runs build, typecheck, lint, tests, and the docs build on every PR.

## Status

Early-stage: APIs may move before 1.0. The package set is stable enough to build on, and every release goes through the changesets flow.

## License

[MIT](./LICENSE)
