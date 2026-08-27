---
title: Chat engine
---

# Chat engine

`ChatEngine` (`@freebirdai/core/chat/engine`) orchestrates a single turn:

1. Persist the user message.
2. Pull cross-chat references for any tags/component ids mentioned, plus
   [knowledge context](./knowledge-and-references.md) for the registry's
   knowledge items.
3. Run an inner loop (up to `maxToolSteps`): call the LLM with the harness
   tools built from the registry and current [action](./actions.md) state —
   `plan_layout`, `start_action`, clarifications, and any host processing
   tools — streaming tokens back to the client over SSE.
4. Apply tool calls: predict the next action state, execute processing
   tools, and run the deterministic [layout solver](./layout-solver.md) on
   any layout intent (locked cells are pinned first so the LLM can't
   overwrite them).
5. Resolve `[[cite:id]]` markers into clickable citations when
   [citations](./knowledge-and-references.md) are enabled.
6. **Persist the assistant message — every turn.** If the LLM produced no
   prose (a tool-only turn), the bubble is filled from a fallback chain:
   a summary of executed tool results, then the host's
   `fallbackToolOnlyPhrase`, then the engine's phase-aware summary, with
   an optional final LLM summary step (`requireAssistantReply`).

The engine is storage-agnostic (`DbAdapter`), LLM-agnostic (`LlmAdapter`),
and emits a typed `ChatStreamEvent` stream — `user_saved`, `text_delta`,
`assistant_saved`, `layout_ready`, `action_*`, `llm_usage`, and
ticket/support events — that `@freebirdai/core-state` reduces into client
state identically across React, Vue, and Angular.

Key options: `maxToolSteps`, `harnessArgsMode`, `fallbackToolOnlyPhrase`
(see [Actions](./actions.md#harness-ux-knobs)), `citations`,
`knowledgeContext` (including the embeddings
[`retrieve` hook](./knowledge-and-references.md#embeddings-retrieval)),
`emitLlmUsage`/`onLlmUsage` for cost tracking, and `support` for
[ticket escalation](./support.md).
