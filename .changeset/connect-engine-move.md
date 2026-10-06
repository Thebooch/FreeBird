---
"@freebirdai/connect": minor
"@freebirdai/connect-spec": minor
"@freebirdai/dash-spec": minor
"@freebirdai/dash-agent": minor
"@freebirdai/dash-react": patch
---

Move the integration engine into `@freebirdai/connect`: discovery, sign-in, mapping, the response cache and keeper, jobs, drift, evidence and reviewed writes, the REST and MCP source adapters (formerly `@freebirdai/dash-adapters`), and the API-mapping half of the authoring agent. `@freebirdai/dash-agent` re-exports the moved agent passes. A saved connection's `onboarding` and a category's `starters` are now stored by the engine without being read; Dash reads them through `onboardingOf` and `startersOf`.
