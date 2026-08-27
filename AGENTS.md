# AGENTS.md — LLM-friendly map of FreeBird

> **When to read this:** you are an AI agent (or a human onboarding fast)
> who needs to understand FreeBird's pivotal docs and source files
> *without* reading the whole repo. This file tells you what each pointer
> doc covers and links to deeper references.

FreeBird is a TypeScript framework that wraps a host website with an
LLM-driven chat: dynamic component layouts, locking, custom tabs with
email digests, and an **action layer** that lets the LLM submit values
on the user's behalf with full auditability.

## Commands

pnpm monorepo (pnpm 10, Node ≥ 20). Run from the repo root:

```bash
pnpm install                          # install all workspaces
pnpm build                            # build every package (guide/packages/* + dash/packages/*)
pnpm build:guide                      # build only guide/packages/*
pnpm build:dash                       # build only dash/packages/*
pnpm typecheck                        # tsc --noEmit across all workspaces
pnpm test                             # vitest run (root config; DOM tests opt in per-file)
pnpm lint                             # eslint over the repo
pnpm --filter freebird-docs start     # docs site dev server
pnpm --filter freebird-docs build     # docs site production build
pnpm changeset                        # add a changeset for user-facing changes
```

Scope any of these to one package with `--filter`, e.g.
`pnpm --filter @freebirdai/core test`. CI runs build → typecheck → lint →
test → docs build on every PR; keep all five green.

## Per-package integration guides

Every major package ships its own `AGENTS.md` — an AI-oriented, self-contained
guide for integrating that package into a host app (install, minimal wiring,
key APIs, pitfalls, verification). They also ship in the npm tarballs, so they
are available under `node_modules/@freebirdai/<name>/AGENTS.md` in consuming
projects.

| Feature you're integrating | Packages | Guide |
| --- | --- | --- |
| Chat engine, sessions, digests, support (server side) | `@freebirdai/core` | [`guide/packages/core/AGENTS.md`](guide/packages/core/AGENTS.md) |
| HTTP routes for Express / Fastify / Next.js | `@freebirdai/server` | [`guide/packages/server/AGENTS.md`](guide/packages/server/AGENTS.md) |
| Client store / custom UI binding | `@freebirdai/core-state` | [`guide/packages/core-state/AGENTS.md`](guide/packages/core-state/AGENTS.md) |
| React UI | `@freebirdai/react` (+ `react-tailwind`) | [`guide/packages/react/AGENTS.md`](guide/packages/react/AGENTS.md), [`guide/packages/react-tailwind/AGENTS.md`](guide/packages/react-tailwind/AGENTS.md) |
| Vue UI | `@freebirdai/vue` (+ `vue-tailwind`) | [`guide/packages/vue/AGENTS.md`](guide/packages/vue/AGENTS.md), [`guide/packages/vue-tailwind/AGENTS.md`](guide/packages/vue-tailwind/AGENTS.md) |
| Angular UI | `@freebirdai/angular` | [`guide/packages/angular/AGENTS.md`](guide/packages/angular/AGENTS.md) |
| Script-tag widget on a static site / WordPress | `@freebirdai/embed` (+ `manifest`) | [`guide/packages/embed/AGENTS.md`](guide/packages/embed/AGENTS.md) |
| Declarative site manifest → registries | `@freebirdai/manifest`, `@freebirdai/codegen` | [`guide/packages/manifest/AGENTS.md`](guide/packages/manifest/AGENTS.md), [`guide/packages/codegen/AGENTS.md`](guide/packages/codegen/AGENTS.md) |
| Scaffolding + drift checks (CLI) | `create-freebird` | [`guide/packages/create-freebird/AGENTS.md`](guide/packages/create-freebird/AGENTS.md) |
| Exposing components/actions to external agents | `@freebirdai/mcp` | [`guide/packages/mcp/AGENTS.md`](guide/packages/mcp/AGENTS.md) |
| DB / LLM / email adapters | `@freebirdai/adapters-*` | package READMEs (`guide/packages/adapters-*/README.md`) |

## Pivotal docs (read these first)

| File                                                         | Purpose                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [`README.md`](README.md)                                     | Project overview, package map, contributor entry point.                                          |
| [`GETTING_STARTED.md`](GETTING_STARTED.md)                   | Step-by-step first-run guide — registry, server route, transport.                                |
| [`ACTIONS.md`](ACTIONS.md)                                   | End-to-end "how to add an action to your FreeBird app". Start here for any action layer work.    |
| [`docs/`](docs/)                                             | Long-form Docusaurus site (concepts + API). Mostly for humans.                                   |

## Action layer (the deep dive)

The action layer is the most stateful subsystem; if your task involves
actions, read these in order:

1. [`ACTIONS.md`](ACTIONS.md) — top-level user-facing guide.
2. [`guide/packages/core/src/actions/README.md`](guide/packages/core/src/actions/README.md)
   — `ActionDefinition`, `readCurrent`, `buildHarnessTurn` contracts.
3. [`guide/packages/core-state/src/actions/README.md`](guide/packages/core-state/src/actions/README.md)
   — `ActionState`, `ActionRecord`, `ActionTransition`, journal semantics,
     `ActionEvent` audit stream.
4. Framework "Actions" sections:
   - [`guide/packages/react/README.md#actions`](guide/packages/react/README.md)
   - [`guide/packages/vue/README.md#actions`](guide/packages/vue/README.md)
   - [`guide/packages/angular/README.md#actions`](guide/packages/angular/README.md)

## Source-of-truth files for actions

| Concern                              | File                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| Action types (`ActionDefinition` …)  | `guide/packages/core/src/types.ts`                                   |
| Server harness (LLM tool schema)     | `guide/packages/core/src/actions/harness.ts`                         |
| Argument validation + diff utilities | `guide/packages/core/src/actions/diff.ts`                            |
| State machine + journal              | `guide/packages/core-state/src/actions/state.ts`                     |
| Audit event types                    | `guide/packages/core-state/src/actions/events.ts`                    |
| HTTP endpoints                       | `guide/packages/server/src/handlers.ts` (search `/actions/`)         |
| React hooks/components               | `guide/packages/react/src/hooks/useAction*.ts`, `components/Action*.tsx` |
| Vue composables/components           | `guide/packages/vue/src/composables/useAction*.ts`, `components/Action*.ts` |
| Angular service + components         | `guide/packages/angular/src/services/freebird.service.ts`, `components/action-*.component.ts` |

## Auth & security primitives

- **Transport auth** — `FetchTransport` accepts `getAuthToken` + `authScheme`
  for outbound requests, and `onUnauthorized` (single-flight) for 401
  refresh + retry. See
  [`guide/packages/core-state/README.md`](guide/packages/core-state/README.md).
  Source: `guide/packages/core-state/src/transport/fetch.ts`.
- **Action authorization** — `ActionDefinition.authorize(args, ctx)` runs
  server-side after Zod validation, before `readCurrent`/`handler`. Denials
  return HTTP 403 (or custom status) and emit `action.unauthorized` server
  events. See
  [`ACTIONS.md#securing-actions-authorize`](ACTIONS.md#securing-actions-authorize).
- **Digest auth refresh** — `DigestEngineOptions.refreshAuth(savedAuth, tab)`
  runs before each digest tab render so long-running digests can mint a
  fresh service token instead of replaying stale `auth`. See
  [`guide/packages/digest-worker/README.md`](guide/packages/digest-worker/README.md).

## Harness UX knobs (chat engine)

Three `createChatEngine` options shape a single LLM turn. All default to
the most ubiquitous behaviour and can be opted out of per-host.

- **`harnessArgsMode: "typed" | "loose"`** *(default `"typed"`)* —
  `start_action`/`update_action_args` get a discriminated union with the
  pending action's actual Zod schema. Use `"loose"` if your provider
  adapter struggles with discriminated unions.
- **`maxToolSteps: number`** *(default `3`)* — when a turn produces only
  tool calls and lands in `collecting`/`awaiting_confirmation`, the
  engine runs another LLM step in the same SSE stream so the model can
  ask the missing question. Only progress-making transitions
  (`action_started`, `action_args_updated`, `action_resumed`) trigger
  the loop. Set to `1` to disable.
- **`fallbackToolOnlyPhrase: string | (ctx) => string | null | null`**
  *(default `null`)* — host-supplied text for a turn that would otherwise
  leave a blank assistant bubble. When set, it wins over the engine's
  generic phase summary (but not over a summary of executed tool
  results). Default `null`: the engine's built-in summaries apply, so a
  visible assistant message is always persisted either way.

See [`ACTIONS.md#harness-ux-knobs-chat-engine`](ACTIONS.md#harness-ux-knobs-chat-engine)
for full details.

## LLM usage / cost (OpenAI)

- **`OpenAiAdapter({ includeUsage: true })`** — streams a final chunk with
  token counts (`LlmStreamChunk.usage`).
- **`createChatEngine({ emitLlmUsage, onLlmUsage, estimateLlmCostUsd })`** —
  forwards usage as SSE `llm_usage`; optional USD via
  `estimateOpenAiChatCostUsd` from `@freebirdai/adapters-llm-openai`.
- **Client:** `@freebirdai/core-state` `FreeBirdState.lastLlmUsage`.

## Other concepts (1-line each)

- **Layout solver** — `guide/packages/core/src/layout/solver.ts`. Two-pass packer
  over `SizeVariant`s (preferred → minimum). Tests cover priority and
  fallback cases.
- **Component registry** — `guide/packages/core/src/components/registry.ts`.
  Single source of truth for what components exist + their actions.
- **Chat engine** — `guide/packages/core/src/chat/engine.ts`. Streams
  `ChatStreamEvent`s; orchestrates layout planning + action harness.
- **Knowledge graph** — `guide/packages/core/src/knowledge/graph.ts`.
  Tag/component-id inverted index for cross-chat references and
  `InfoTrigger`.
- **Custom tabs + digests** — `guide/packages/core/src/tabs/*.ts`,
  `guide/packages/core/src/digest/*.ts`. Save layouts; email summaries on a cron.
- **Adapters** — `guide/packages/adapters-*`. Pluggable DB / LLM / Email impls.
- **MCP** — `guide/packages/mcp/`. Opt-in MCP server; `runAction()` shared with HTTP confirm.

## MCP (`@freebirdai/mcp`)

| Concern | File |
| ------------------------------------ | -------------------------------------------------------------- |
| MCP server factory | `guide/packages/mcp/src/server.ts` |
| Tool handlers | `guide/packages/mcp/src/tools.ts` |
| Access mode + overrides | `guide/packages/mcp/src/access.ts` |
| Shared execute pipeline | `guide/packages/core/src/actions/run.ts` |
| Policy fields on registry | `guide/packages/core/src/types.ts` (`mcp` on `ActionDefinition` / `ComponentDefinition`) |

MCP writes call the same `runAction()` as `POST /actions/confirm`. **`authorize`
is the security boundary** — `setActiveComponentIds` gates only the in-app chat
harness, not MCP.

## Conventions for AI agents

- Prefer editing existing files; never create duplicate `Action*` types.
- Action types are defined **once** in `@freebirdai/core`; `@freebirdai/core-state`
  re-exports them. If you add a new field, add it in core only.
- The server harness and the client store both reduce over the same
  `ActionState` shape — keep both pure and free of side effects.
- Journal records are in-memory; persistence is a host concern. Hosts
  subscribe to `ActionEvent`s (client) or `onActionEvent` (server) to
  store / replay history.
