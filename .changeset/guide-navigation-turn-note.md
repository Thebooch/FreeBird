---
"@freebirdai/core": minor
"@freebirdai/core-state": minor
"@freebirdai/server": minor
---

An action can take the person where they asked to go, and a host can give the model a note about each turn.

- `@freebirdai/core`: `withNavigation(result, { title, page, selector })` and `navigationOf`, for an action that exists to show something ("show me the leases widget for last month"). `turnNote: ({ auth, text }) => string | null` on the engine adds a per-turn note (today's date, what the page shows) after the cache point; a null or a throw adds nothing.
- `@freebirdai/core-state`: after an action that needed no approval returns `withNavigation`, the store raises that place to `onNavigate`, as it does for the `open_component` tool. An approved action never moves the page.
- `@freebirdai/server`: forwards `turnNote`.
