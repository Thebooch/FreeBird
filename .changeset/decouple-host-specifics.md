---
"@freebirdai/core": minor
"@freebirdai/server": minor
---

Remove host-specific behavior from the core engine so the framework is fully application-agnostic.

The engine no longer recognizes any particular component id or host tool name. Previously a handful of
identifiers from the app FreeBird was extracted from were special-cased in `@freebirdai/core`, which meant
undocumented magic behavior for anyone who happened to use the same names.

**Removed**

- The per-session argument stash that merged processing-tool output into one specific component's pending
  action, and its `blueprintStash` plumbing through the action-tool context.
- The hardcoded continuation prompt that steered the model after a specific host tool ran.
- The lookup table mapping specific host tool names to workspace citation component ids.
- The per-tool natural-language summary templates for specific host tools.
- Host tool names referenced by example in harness/engine prompt text.

**Generalized**

- **Processing-tool arg contributions.** Any host tool may now contribute args by returning `normalizedArgs`
  on its result — no name allowlist. Two optional guards are honored when present: `actionRef`
  (`"componentId:actionId"`) scopes the contribution to the pending action, and a non-empty `invalid[]`
  suppresses the merge. Results carrying `error` are skipped.
- **Workspace citations.** Host tools declare them by returning `workspaceCitations` or `componentIds` on
  their result, instead of relying on a built-in per-tool table.
- **Deterministic tool summaries.** A host tool may return a `summary` string to control the assistant's
  fallback text. Without one, the engine asks the LLM to summarize the raw tool results — which is the
  better default.

**Breaking**

- `Ticket.firmId` is now `Ticket.orgId`, sourced from the first-class `AuthContext.orgId` instead of an
  untyped cast on the auth object. Hosts that read `firmId` off filed tickets should read `orgId`; hosts
  that set a tenant id should populate `auth.orgId` (as the DB adapters already expect).
