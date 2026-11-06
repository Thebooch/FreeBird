# @freebirdai/vue

## 0.2.0

### Minor Changes

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
  - @freebirdai/core-state@0.2.0
