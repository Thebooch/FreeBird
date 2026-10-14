# FreeBird

> Open-source TypeScript for putting AI in front of your own data: a chat that drives your website, an engine that connects to any API, and a dashboard with agents that do the work for you.

FreeBird is a pnpm monorepo with three products. They are developed and released together, but each one installs on its own.

| | What it does | Lives in | Start with |
|---|---|---|---|
| **Guide** | Drops an AI chat into any website and lets it drive your real components: actions with confirmation, layouts, citations, digests. | [`guide/`](./guide) | `@freebirdai/core` + a UI binding |
| **Connect** | Connects to an API it has never seen, works out its records, keeps their data fresh, and makes changes only after a person reviews them. | [`connect/`](./connect) | `@freebirdai/connect` |
| **Dash** | A dashboard app over any API, built from JSON specs, with an Agent side for workflows, agents, a calendar, contacts and email. | [`dash/`](./dash) | `pnpm dev:dash` |

Dependencies run one way: Dash uses Connect and Guide, Connect's chat add-on uses Guide, and Guide knows about neither.

## What works today

Everything below is in the code on `main`. Each line points at where to look.

**Guide** (`guide/packages/*`)

- Chat that drives your own components through a registry, with headless React, Vue 3 and Angular bindings and opt-in Tailwind presets.
- Zod-typed **actions**: the model collects arguments in conversation, shows a preview, and runs only after the person confirms, with an audit journal and an `authorize` hook ([`ACTIONS.md`](./ACTIONS.md)).
- Layouts chosen by the model and packed by a deterministic 12-column solver (`core/src/layout`).
- Citations that scroll to and highlight the source section, and a retrieval hook for your own embeddings (`core/src/knowledge`).
- Locking, saved tabs, and email **digests** of live component data on a schedule (`core/src/tabs`, `core/src/digest`, `digest-worker`).
- Support escalation: issue classification and ticket drafting (`core/src/support`).
- A script-tag **embed** for static sites and WordPress, a Registration **Manifest** with `freebird init` / `check` / `doctor`, and an **MCP** server for outside agents.
- Adapters for Postgres, Prisma, OpenAI, Anthropic, Resend and SMTP.

**Connect** (`connect/packages/*`)

- Discovery from OpenAPI, GraphQL, documentation pages, MCP servers, or an API's name.
- Keys and OAuth, with credentials encrypted in a vault.
- Record types worked out from the API, reads by record or endpoint, a response cache, and a keeper that refreshes on each endpoint's cadence.
- Drift checks when an endpoint's shape changes, and **reviewed writes** with a journal.
- Requests guarded against SSRF, with an egress policy for private networks.
- Optional add-ons: Postgres/PGlite stores, a QuickJS sandbox for generated connector code, a headless browser for docs drawn in JavaScript, and HTTP routes for Fastify, Express and Next.js.

**Dash** (`dash/apps/*`, `dash/packages/*`)

- **Boards** built from versioned JSON specs: a safe pipeline language with no `eval`, every loading/empty/error/stale state, a shared time range, and an inspector that shows where any number came from.
- **Connection onboarding** that prepares an API once, previews the boards against the account, then builds them.
- A **chat on every page** that can do anything the page can, through Guide's actions and approval cards, with topics by day and a timeline.
- **Agents**: named AI workers with instructions, knowledge, tools, and a reach limited to what the approver holds.
- **Workflows**: triggers (schedule, record change, new email, booking, by hand) and a graph of steps such as create, update, outreach, wait, branch and ask a person. Steps that leave Dash run automatically or wait for approval, and a task that changed something can be reversed.
- **Calendar, scheduling and bookings**, with public booking pages, approval links and an `.ics` feed.
- **Contacts**: created from new senders, fields filled from email, merged, and typed by match rules that workflows can branch on.
- **Communications**: Gmail and Outlook mailboxes in one list, separate areas for team and agent mail, sending through the reviewed-write path, and calendar busy times.
- **Timed reports**: a tab or chosen widgets emailed on a schedule with a short summary, plus tracked daily values.
- Sign-in through OIDC with roles, and several workspaces on one server ([`dash/PLATFORM.md`](./dash/PLATFORM.md)).

## Planned or in progress

- **Widget polish and restyle** for Dash boards: in progress on its own branches.
- **Texts and calls** for agents and workflows: not built. Outreach by text or call is a step that exists but sends nothing yet.
- **A screen for tracked values**: they can be made through `POST /api/tracked` and shown in reports, but there is no screen for them.
- **Not planned for v1**: history an API doesn't keep, joins across sources, and any write without a person's review. See [`dash/README.md`](./dash/README.md#what-v1-does-not-do).

## Run it locally

You need Node 20+ and pnpm 10. Use pnpm, not npm: internal packages are linked with `workspace:*`.

```bash
pnpm install
pnpm build
```

**Dash.** Copy the example environment, then start the server (port 4600) and the web app (port 5400):

```bash
cp dash/.env.example dash/.env
pnpm dev:dash
```

Open http://localhost:5400. Vite binds IPv6, so `127.0.0.1:5400` will not answer. Dash runs with an empty `.env`; adding `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` turns on reading documentation, the authoring agent and the chat. Data lives under `dash/apps/server/` unless `DASH_ROOT` says otherwise. After editing anything in `dash/packages/`, run `pnpm build:dash` again, because the web app imports built output.

**Guide.** The Next.js starter is the quickest way in. The [Getting Started guide](./GETTING_STARTED.md) walks through the rest.

```bash
OPENAI_API_KEY=sk-... pnpm --filter freebird-next-starter dev
```

**Connect.** Read an API from a plain Node script:

```bash
pnpm --filter freebird-connect-node-example start
```

Other examples: [`examples/vite-express`](./examples/vite-express), [`examples/static-embed`](./examples/static-embed), [`examples/connect-express`](./examples/connect-express), and the WordPress plugin in [`integrations/wordpress`](./integrations/wordpress).

## Repo layout

```
guide/packages/     20 packages   chat engine, server routes, React/Vue/Angular, embed, manifest, CLI, MCP, adapters
connect/packages/    8 packages   the integration engine, its spec, four add-ons, the chat add-on, and a private test bench
shared/packages/     2 packages   @freebirdai/expr (safe expressions) and @freebirdai/contracts
dash/packages/       6 packages   spec, runtime, components, react, parts, authoring agent
dash/apps/           2 apps       server (Fastify) and web (Vite + React), private
dash/catalog/                     shipped catalog entries, including Gmail and Outlook
examples/                         runnable reference apps
integrations/                     WordPress/WooCommerce plugin
docs/                             Docusaurus documentation site
```

Thirty-five packages publish: 34 under `@freebirdai`, plus `create-freebird`. Changesets links their versions so they release together. The Dash apps, the examples and `connect-bench` are private.

### Where to read next

| If you're working on | Read |
|---|---|
| Anything, as an AI assistant or a fast human | [`AGENTS.md`](./AGENTS.md), and the `AGENTS.md` inside each package |
| Guide's action layer | [`ACTIONS.md`](./ACTIONS.md), then `guide/packages/core/src/actions/README.md` |
| Connect | [`connect/packages/connect/README.md`](./connect/packages/connect/README.md) and its `AGENTS.md` |
| Dash's specs, onboarding, agents and reports | [`dash/README.md`](./dash/README.md) |
| Dash's server internals and conventions | [`dash/AGENTS.md`](./dash/AGENTS.md) |
| Swapping Dash's storage, identity or transport | [`dash/PLATFORM.md`](./dash/PLATFORM.md) |
| Concepts and recipes for humans | the docs site: `pnpm --filter freebird-docs start` |

## Contribute

Read [CONTRIBUTING.md](./CONTRIBUTING.md) first. The short version:

```bash
pnpm build        # every package
pnpm typecheck    # tsc --noEmit across all workspaces
pnpm lint
pnpm test         # vitest from the root
pnpm changeset    # for any user-facing change to a published package
```

Narrower builds: `pnpm build:guide`, `pnpm build:connect` and `pnpm build:dash` (each includes `shared/` and whatever it depends on). Scope tests with `pnpm --filter <package> test`.

CI runs build, typecheck, lint, tests and the docs build on every pull request. A change that bumps a schema version must ship its migration in the same PR (see "Schema changes ship their migration" in CONTRIBUTING.md).

A few rules that hold across the repo:

- In Dash, the model runs when something is set up, never when a board renders.
- Nothing changes a connected account without a review a person approves.
- Expressions never use `eval` or `new Function`; untrusted API data flows through them.
- A fresh clone must run with nothing installed beyond Node and pnpm.

## Status

Early-stage. APIs may change before 1.0, and every release goes through changesets.

## License

[MIT](./LICENSE)
