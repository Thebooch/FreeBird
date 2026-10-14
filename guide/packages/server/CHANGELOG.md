# @freebirdai/server

## 0.2.0

### Minor Changes

- e273624: Remove host-specific behavior from the core engine so the framework is fully application-agnostic.

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

- 5ed0e03: An action can take the person where they asked to go, and a host can give the model a note about each turn.
  - `@freebirdai/core`: `withNavigation(result, { title, page, selector })` and `navigationOf`, for an action that exists to show something ("show me the leases widget for last month"). `turnNote: ({ auth, text }) => string | null` on the engine adds a per-turn note (today's date, what the page shows) after the cache point; a null or a throw adds nothing.
  - `@freebirdai/core-state`: after an action that needed no approval returns `withNavigation`, the store raises that place to `onNavigate`, as it does for the `open_component` tool. An approved action never moves the page.
  - `@freebirdai/server`: forwards `turnNote`.

- 02f11ef: The chat can do anything the app can, from anywhere, and says where a change landed.
  - **On screen is context.** Every registered action is offered on every turn; `activeComponentIds` now tells the model what "this" and "here" mean, and `setFocus({ componentId, itemId?, label? })` names the one item open. `narrowToActive: true` restores the old filter. Behaviour change: hosts that relied on `activeComponentIds` to hide actions now offer all of them (`authorize` was, and is, the boundary).
  - **`harnessArgsMode: "catalog"`**: one `start_action` tool for the whole app, every action listed a line each with its argument names, the picked action's exact schema on `update_action_args`. A value that does not fit, or a name the action does not take, keeps the action collecting with the reason.
  - **No tool budget by default.** `toolBudgetBytes` (now an engine option too) defers tools behind `tool_search` only when set.
  - **`withCitation(result, { title, page, selector, summary })`**: after an approved action, `@freebirdai/server` saves a line in the conversation with a citation chip to where the change is, and returns it as `outcomeMessage`, which the store shows at once. Nothing navigates on its own.
  - **`navigation: { enabled: true }`**: an `open_component` tool for "take me to …", a citation-shaped `navigate` stream event, `store.onNavigate`, and `useNavigationRequests` in React; follow it with `activateCitation`, as a chip click is.
  - Fixed: what `tool_search` and `tool_describe` return now reaches the model's next step, with a hint to start the action found.

- e273624: Initial release of the FreeBird framework: chat engine with actions,
  citations, and knowledge retrieval; deterministic layout solver;
  per-component locks and custom tabs; digests (in-process + standalone
  worker); support/ticket escalation; React, Vue, and Angular bindings with
  optional Tailwind presets; script-tag embed widget; Registration Manifest +
  codegen and the create-freebird CLI; MCP server; and first-party adapters
  for OpenAI, Anthropic, Postgres (Kysely), Prisma, Resend, and SMTP.

### Patch Changes

- Updated dependencies [6b7bfe5]
- Updated dependencies [cacc921]
- Updated dependencies [e273624]
- Updated dependencies [5ed0e03]
- Updated dependencies [02f11ef]
- Updated dependencies [e273624]
- Updated dependencies [a907857]
  - @freebirdai/core@0.2.0
