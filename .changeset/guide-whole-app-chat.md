---
"@freebirdai/core": minor
"@freebirdai/core-state": minor
"@freebirdai/server": minor
"@freebirdai/react": minor
"@freebirdai/vue": minor
"@freebirdai/angular": minor
---

The chat can do anything the app can, from anywhere, and says where a change landed.

- **On screen is context.** Every registered action is offered on every turn; `activeComponentIds` now tells the model what "this" and "here" mean, and `setFocus({ componentId, itemId?, label? })` names the one item open. `narrowToActive: true` restores the old filter. Behaviour change: hosts that relied on `activeComponentIds` to hide actions now offer all of them (`authorize` was, and is, the boundary).
- **`harnessArgsMode: "catalog"`**: one `start_action` tool for the whole app, every action listed a line each with its argument names, the picked action's exact schema on `update_action_args`. A value that does not fit, or a name the action does not take, keeps the action collecting with the reason.
- **No tool budget by default.** `toolBudgetBytes` (now an engine option too) defers tools behind `tool_search` only when set.
- **`withCitation(result, { title, page, selector, summary })`**: after an approved action, `@freebirdai/server` saves a line in the conversation with a citation chip to where the change is, and returns it as `outcomeMessage`, which the store shows at once. Nothing navigates on its own.
- **`navigation: { enabled: true }`**: an `open_component` tool for "take me to …", a citation-shaped `navigate` stream event, `store.onNavigate`, and `useNavigationRequests` in React; follow it with `activateCitation`, as a chip click is.
- Fixed: what `tool_search` and `tool_describe` return now reaches the model's next step, with a hint to start the action found.
