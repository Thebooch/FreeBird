# @freebirdai/core — AI integration guide

Instructions for an AI assistant integrating FreeBird into a host app. Self-contained: everything here can be done without reading other repo docs.

## What this is

The framework-agnostic engine behind FreeBird: component registry, streaming chat engine, action layer, deterministic layout solver, custom tabs, digests, knowledge/citations, and support tickets. Pure TypeScript, no DOM dependencies.

Use it directly when building the **server side** of any FreeBird integration, or a custom runtime. Do NOT hand-roll UI on it — pair it with `@freebirdai/server` (HTTP routes) plus a UI binding (`@freebirdai/react`, `@freebirdai/vue`, `@freebirdai/angular`, or `@freebirdai/embed`).

## Install

```bash
pnpm add @freebirdai/core zod
```

`zod` is a peer dependency — actions and manifests are Zod-typed.

## Minimal integration (server side)

1. Create a registry and register the host's components. Every component needs `id`, `title`, `description`, and `grid`:

```ts
import { createComponentRegistry } from "@freebirdai/core";
import { z } from "zod";

export const registry = createComponentRegistry();

registry.register({
  id: "revenueChart",                        // stable, unique — the LLM addresses it by id
  title: "Revenue",
  description: "30-day revenue trend",       // one sentence; the LLM reads this to choose components
  tags: ["revenue", "finance"],
  grid: { minW: 4, minH: 3, maxW: 12, defaultAspect: "wide" },
  dataSource: async (ctx) => ({ total: await getRevenue(ctx.auth) }),
  knowledge: ["Defaults to the last 30 days."],
  actions: [
    {
      id: "set_range",
      description: "Change the visible date range.",
      schema: z.object({ days: z.number().int().min(1).max(365) }),
      handler: async (args, ctx) => saveRange(ctx.auth.userId, args.days),
      requiresConfirmation: "preview",       // "none" auto-applies; default "preview"
    },
  ],
});
```

2. Wire the engine with adapters:

```ts
import { createFreeBird } from "@freebirdai/core";
import { createMemoryDb, createFakeLlm } from "@freebirdai/core/testing"; // dev only

const fb = createFreeBird({
  db: createMemoryDb(),          // prod: @freebirdai/adapters-db-postgres or -prisma
  llm: createFakeLlm(),          // prod: @freebirdai/adapters-llm-openai or -anthropic
  registry,
});
```

3. Stream a turn (normally `@freebirdai/server` does this for you):

```ts
for await (const event of fb.chat.send(
  { sessionId, text: "Show me revenue" },
  { userId: "u1" },              // AuthContext — passed to every db call and action
)) {
  // event.kind: user_saved | text_delta | assistant_saved | layout_ready
  //           | action_* | llm_usage | ticket_* | error
}
```

## Key APIs

- `createComponentRegistry()` → `register/upsert/get/list/getAction/listActions/setKnowledge/listKnowledge`
- `createFreeBird({ db, llm, email?, registry })` → `{ chat, tabs, digest, knowledge, registry }`
- `ChatEngine` options (pass via `createFreeBird` or `new ChatEngine`): `maxToolSteps` (default 3), `harnessArgsMode` (`"typed"`), `fallbackToolOnlyPhrase`, `citations: { enabled }`, `knowledgeContext: { enabled, maxChars, retrieve }`, `emitLlmUsage`, `onLlmUsage`, `enablePlanLayout`, `review: { enabled }`, `support`
- `solveLayout(registry, intent, { locked })` — deterministic 12-column packer
- Action pipeline: `validateActionArgs`, `runAction`, `runAuthorize`, `runActionPreflight`
- Adapter interfaces to implement for BYO infra: `DbAdapter`, `LlmAdapter`, `EmailAdapter` (in `@freebirdai/core` — see `src/adapters/`)
- Test doubles: `@freebirdai/core/testing` → `MemoryDb`, `FakeLlm`, `FakeEmail`

## Works with

- `@freebirdai/server` — mounts HTTP+SSE routes over this engine (Express/Fastify/Next). Install it rather than writing routes by hand.
- `@freebirdai/adapters-db-postgres` / `-db-prisma` — production persistence (`createPostgresDb(...)` / `createPrismaDb(...)`).
- `@freebirdai/adapters-llm-openai` / `-llm-anthropic` — production LLMs.
- `@freebirdai/manifest` — compile a declarative site manifest into this registry instead of hand-registering.

## Common pitfalls

- **Actions silently unavailable** → the client's `activeComponentIds` doesn't include the component. Empty array = ALL actions exposed (that's intentional for cross-page navigation).
- **`authorize` missing on a sensitive action** → `setActiveComponentIds` is UX scoping, not security. Every action that mutates must have `authorize(args, ctx)`; it runs on every execution path (HTTP, chat, MCP).
- **Empty assistant bubbles** → don't handle this client-side; the engine always persists a message. Customize wording with `fallbackToolOnlyPhrase` (it wins over the generic summary, loses to tool-result summaries).
- **Grid validation errors** → a component needs either `sizes[]` or both `minW` and `minH`.
- **LLM never cites** → citations need `citations: { enabled: true }` AND components with `domAnchor` or knowledge (or site knowledge items with `id`s).

## Verify

```bash
pnpm typecheck && pnpm test
```

Then a real round-trip with the test doubles: create a session via `db.createSession`, run `fb.chat.send`, and assert an `assistant_saved` event arrives. For an end-to-end check with HTTP + UI, follow `@freebirdai/server`'s AGENTS.md.
