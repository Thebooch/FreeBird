# FreeBird

> Two open-source TypeScript products for putting AI in front of your own data — one that guides people through your site, one that builds dashboards over any API.

This monorepo ships **FreeBird Guide** and **FreeBird Dash**. They are developed and versioned together, but they install independently: adopt either one without taking on the other.

| | What it does | Lives in | Install |
|---|---|---|---|
| **Guide** | Drops an AI chat backbone into any website and lets it drive your real components — actions, layout, citations, digests. | [`guide/`](./guide) | `@freebirdai/core` + a UI binding |
| **Dash** | Turns a JSON spec into a working dashboard over any API — pipeline, states, formatting, time ranges, layout. | [`dash/`](./dash) | `@freebirdai/dash-spec` + `dash-react` |

Dash builds on Guide's foundation — it uses `@freebirdai/core` for the component registry, auth context, and database adapter — but the dependency runs **one way only**. Guide has no knowledge of Dash and works completely on its own.

```
guide/packages/   20 packages   @freebirdai/core, react, vue, angular, server, embed, …
dash/packages/     8 packages   @freebirdai/dash-spec, dash-runtime, dash-react, …
dash/apps/         2 apps       the Dash server and dashboard (private, not published)
examples/                       reference apps for Guide
docs/                           the documentation site
integrations/                   WordPress/WooCommerce plugin
```

---

# FreeBird Guide

> An AI-driven website framework. Turn any site's backbone into an LLM-controlled, chat-first experience.

FreeBird Guide is an open-source TypeScript framework that drops an AI chat "backbone" into any website — from a React/Vue/Angular app to a static HTML page or a WordPress site. The chat can **drive your real components**: generate dashboard layouts, run **actions** you define (with previews, confirmation, and auditing), cite the exact page section an answer came from, and email **digests** of live component data on a schedule.

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

## Guide packages

### Core

| Package | Purpose |
|---|---|
| [`@freebirdai/core`](./guide/packages/core) | Framework-agnostic engine: registry, chat, actions, layout, tabs, digests, knowledge, support |
| [`@freebirdai/core-state`](./guide/packages/core-state) | Framework-agnostic client store + HTTP/SSE transport (wrapped by every UI binding) |
| [`@freebirdai/server`](./guide/packages/server) | Route handlers + Express / Fastify / Next.js integrations, middleware, digest scheduler |
| [`@freebirdai/digest-worker`](./guide/packages/digest-worker) | Standalone cron worker for digests (optional, for multi-replica deployments) |

### UI bindings

| Package | Purpose |
|---|---|
| [`@freebirdai/react`](./guide/packages/react) | React provider, hooks, and headless primitives |
| [`@freebirdai/react-tailwind`](./guide/packages/react-tailwind) | Opt-in pre-styled Tailwind preset for React |
| [`@freebirdai/vue`](./guide/packages/vue) | Vue 3 plugin, composables, and headless components |
| [`@freebirdai/vue-tailwind`](./guide/packages/vue-tailwind) | Opt-in pre-styled Tailwind preset for Vue |
| [`@freebirdai/angular`](./guide/packages/angular) | Angular 17–20 provider, signals service, and standalone components |
| [`@freebirdai/embed`](./guide/packages/embed) | Script-tag chat widget (Shadow DOM) + declarative registration for static sites |

### Tooling

| Package | Purpose |
|---|---|
| [`@freebirdai/manifest`](./guide/packages/manifest) | Registration Manifest schema + compiler into live registries |
| [`@freebirdai/codegen`](./guide/packages/codegen) | Manifest → registry files, route wiring, and integration steps |
| [`create-freebird`](./guide/packages/create-freebird) | CLI: `freebird init` scaffolds an integration, `freebird check` catches registry drift |
| [`@freebirdai/mcp`](./guide/packages/mcp) | MCP server exposing components/actions to external AI agents |

### Adapters

| Package | Purpose |
|---|---|
| [`@freebirdai/adapters-db-postgres`](./guide/packages/adapters-db-postgres) | Postgres (Kysely) persistence |
| [`@freebirdai/adapters-db-prisma`](./guide/packages/adapters-db-prisma) | Prisma persistence |
| [`@freebirdai/adapters-llm-openai`](./guide/packages/adapters-llm-openai) | OpenAI LLM adapter (+ cost estimation) |
| [`@freebirdai/adapters-llm-anthropic`](./guide/packages/adapters-llm-anthropic) | Anthropic Claude LLM adapter |
| [`@freebirdai/adapters-email-resend`](./guide/packages/adapters-email-resend) | Resend email adapter |
| [`@freebirdai/adapters-email-smtp`](./guide/packages/adapters-email-smtp) | SMTP (Nodemailer) email adapter |

## Running Guide

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

---

# FreeBird Dash

> A declarative binding runtime and a polished React component library for building dashboards over any API.

The charts aren't the hard part — LLMs emit Recharts fine. What hand-built dashboards are missing is everything *around* the charts: loading, empty, error and stale states; consistent number formatting; a time-range filter every widget actually respects; responsive layout; a refresh policy; and a data pipeline that isn't fifteen bespoke `.map().filter().reduce()` chains scattered across components.

Dash gives you all of that from a JSON spec:

```jsonc
{
  "id": "revenue_trend",
  "component": "timeseries",
  "source": { "connection": "stripe", "op": "charges.list" },
  "pipeline": [
    { "op": "extract", "path": "$.data[*]" },
    { "op": "coerce", "fields": { "created": "unix_s->datetime", "amount": "int->money:cents" } },
    { "op": "filter", "where": "status == 'succeeded'" },
    { "op": "group", "by": [{ "field": "created", "bucket": "{{range.grain}}" }],
                     "agg": { "revenue": "sum(amount)" } }
  ]
}
```

An LLM writes that spec once, at authoring time — then the runtime executes it deterministically forever after. No model sits in the render path.

## Dash highlights

- **Spec-driven, not code-generated** — widgets are versioned JSON validated against role contracts, so a bad binding fails at save time rather than in production.
- **Safe expression engine** — a hand-rolled, non-Turing-complete path/filter language with **no `eval` and no third-party JSONPath**, avoiding the embedded-subexpression class of RCE.
- **Isomorphic pipeline** — the same executor runs on server or client, turning an API payload into rows a component can render.
- **Every state handled** — loading, empty, error, stale, and partial come from the runtime, not from each widget.
- **Provenance inspector** — click any number and see the request, the pipeline stage, and the row it came from.
- **Colorblind-safe palette, no charting dependency** — components own their rendering.

## Dash packages

| Package | Purpose |
|---|---|
| [`@freebirdai/dash-spec`](./dash/packages/spec) | Versioned schemas, semantic type registry, and the component role contracts every other package agrees on |
| [`@freebirdai/dash-runtime`](./dash/packages/runtime) | Pure isomorphic pipeline executor: API payload → renderable rows |
| [`@freebirdai/dash-expr`](./dash/packages/expr) | Safe path + expression language, hand-rolled to an AST, no `eval` |
| [`@freebirdai/dash-adapters`](./dash/packages/adapters) | Source adapters — the boundary between the runtime and wherever the data lives (inline / REST / MCP) |
| [`@freebirdai/dash-components`](./dash/packages/components) | Role-contract-driven React widgets with a validated, colorblind-safe palette |
| [`@freebirdai/dash-react`](./dash/packages/react) | Shared params, deduplicating query cache, widget states, provenance inspector, and the grid |
| [`@freebirdai/dash-parts`](./dash/packages/parts) | Part registry: layered resolution of swappable units, storing only what you customise |
| [`@freebirdai/dash-agent`](./dash/packages/agent) | Authoring agent — deterministic schema inference plus one LLM call proposing a binding, validated and previewed before save |

Full detail in [`dash/README.md`](./dash/README.md).

## Running Dash

```bash
pnpm install
pnpm build
pnpm dev:dash
```

## Documentation

**Guide**

- [Getting Started](./GETTING_STARTED.md) — the end-to-end walkthrough
- [Actions guide](./ACTIONS.md) — the LLM action layer in depth
- [Docs site](./docs) — concepts, package guides, and recipes (`pnpm --filter freebird-docs start`)

**Dash**

- [`dash/README.md`](./dash/README.md) — the spec format, pipeline ops, and component roles
- [`dash/AGENTS.md`](./dash/AGENTS.md) — working notes on the package layout and conventions

**Both**

- [AGENTS.md](./AGENTS.md) — a map of the repo for AI coding assistants; every major package also ships its own `AGENTS.md` integration guide

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Development is `pnpm install && pnpm build && pnpm test` from the repo root, which covers both products.

Useful narrower commands:

| Command | Scope |
|---|---|
| `pnpm build:guide` | Build only `guide/packages/*` |
| `pnpm build:dash` | Build only `dash/packages/*` |
| `pnpm dev` | Watch-build the Guide packages |
| `pnpm dev:dash` | Run the Dash server and dashboard |

CI runs build, typecheck, lint, tests, and the docs build on every PR — across both products.

## Status

Early-stage: APIs may move before 1.0. The package set is stable enough to build on, and every release goes through the changesets flow.

All 28 published packages share one version line and release together under the `@freebirdai` scope, so a Guide and Dash release always agree with each other. The two Dash apps in `dash/apps/` are private and are not published.

## License

[MIT](./LICENSE)
