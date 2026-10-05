# @freebirdai/connect

FreeBird's integration engine: it connects to an API, works out what its
records are, keeps their data fresh and makes reviewed changes. It is being
split out of FreeBird Dash so it can be used without a dashboard.

**Status: moved, not yet redesigned.** The code here is Dash's engine code as
it was, so the diff of the move stays easy to check. Dash imports modules by
path (`@freebirdai/connect/discovery/index`, `@freebirdai/connect/writes/service`).
The public `createConnect` API, the add-on packages (postgres, sandbox,
browser, server) and a quickstart come in the next phases.

- `@freebirdai/connect/adapters`: the REST and MCP source adapters. Safe in a
  browser.
- `@freebirdai/connect/agent`: the API-mapping passes (record types,
  references, views, categories, rhythm, connectors, repairs) and the LLM
  adapter shape they share.
- The types live in `@freebirdai/connect-spec`.
