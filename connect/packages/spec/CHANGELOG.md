# @freebirdai/connect-spec

## 0.2.0

### Minor Changes

- 474e53c: Move the integration engine into `@freebirdai/connect`: discovery, sign-in, mapping, the response cache and keeper, jobs, drift, evidence and reviewed writes, the REST and MCP source adapters (formerly `@freebirdai/dash-adapters`), and the API-mapping half of the authoring agent. `@freebirdai/dash-agent` re-exports the moved agent passes. A saved connection's `onboarding` and a category's `starters` are now stored by the engine without being read; Dash reads them through `onboardingOf` and `startersOf`.
- be9f5ec: Split the connection side of Dash's spec into its own package, `@freebirdai/connect-spec`: connections, connectors, catalog entries, record types and their relations, evidence, rhythm and writes. `@freebirdai/dash-spec` re-exports all of it, so existing imports keep working. This is the first step toward the standalone `@freebirdai/connect` integration engine.

### Patch Changes

- ce27094: Make Connect usable on its own: a README with a five-minute quickstart, an `AGENTS.md` integration guide, a docs-site section, and two runnable examples (`examples/connect-node`, `examples/connect-express`). After a check, the engine now describes the API's record types by itself when a model is configured, so `read({ record })` works without a host wiring it up.
- Updated dependencies [cacc921]
- Updated dependencies [24ecda1]
  - @freebirdai/expr@0.2.0
