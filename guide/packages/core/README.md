# @freebirdai/core

Framework-agnostic engine powering [FreeBird](../../README.md). Pure TypeScript, no DOM dependencies. React and server packages are built on top of this.

## What's inside

- `ComponentRegistry` — register renderable components with metadata the LLM can understand.
- `KnowledgeGraph` — tag / component id inverted index used for cross-chat references and InfoTrigger.
- `ChatEngine` — streaming orchestrator: persist user message → resolve references → call LLM with `plan_layout` tool → run solver → persist assistant reply.
- `solveLayout` — deterministic first-fit packer that turns `LayoutIntent` from the LLM into a real `LayoutPlan` on a 12-column grid, respecting locked cells.
- `CustomTabsService` — save / list / update / delete locked layout snapshots, optionally with a digest config.
- `DigestEngine` — pulls `dataSource()` from each component in a tab, summarizes via LLM, sends via email adapter.
- Adapter interfaces: `DbAdapter`, `LlmAdapter`, `EmailAdapter`.
- `@freebirdai/core/testing` — `MemoryDb`, `FakeLlm`, `FakeEmail` for unit tests.

## Install

```bash
pnpm add @freebirdai/core zod
```

## Usage

```ts
import { createFreeBird } from "@freebirdai/core";
import { createMemoryDb, createFakeLlm } from "@freebirdai/core/testing";

const fb = createFreeBird({
  db: createMemoryDb(),
  llm: createFakeLlm(),
});

fb.registry.register({
  id: "revenueChart",
  title: "Revenue",
  description: "30-day revenue trend",
  tags: ["revenue", "finance"],
  grid: { minW: 4, minH: 3, maxW: 12, defaultAspect: "wide" },
  dataSource: async () => ({ total: 12345 }),
});

const session = await db.createSession({ topic: "weekly review" }, { userId: "u1" });
for await (const event of fb.chat.send(
  { sessionId: session.id, text: "Show me revenue" },
  { userId: "u1" },
)) {
  console.log(event);
}
```

See [`src/index.ts`](./src/index.ts) for the full public surface.
