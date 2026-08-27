---
title: "@freebirdai/core"
---

# @freebirdai/core

Framework-agnostic engine. No DOM, no React, no Node-only APIs. You can run
it in a worker, in Deno, or in tests.

### Exports

- `createComponentRegistry()` — register components.
- `createChatEngine({ db, llm, registry, knowledge, systemPrompt })` — run
  a streamed chat turn.
- `solveLayout({ registry, intent, lockedCells })` — deterministic packer.
- `createCustomTabsService(db)` — save/load/delete tabs.
- `createKnowledgeGraph(registry)` — tag index for cross-chat references.
- `createDigestEngine({ db, llm, email, registry })` — snapshot and email.
- Adapter interfaces: `DbAdapter`, `LlmAdapter`, `EmailAdapter`.
- `@freebirdai/core/testing` — `createMemoryDb`, `createFakeLlm`,
  `createFakeEmail` for unit tests.
