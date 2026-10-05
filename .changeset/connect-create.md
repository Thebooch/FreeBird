---
"@freebirdai/connect": minor
---

Add `createConnect`, the engine's public API: add an API from its documentation or OpenAPI address, save its key, check it, read an endpoint or a record type with a filter and a freshness bound, keep reads warm, make two-step reviewed changes, and listen for reads, failures, checks and writes. `createEngine` exposes the same machinery for a host that serves it itself; Dash's server now builds its engine with it.
