---
"@freebirdai/connect-spec": minor
"@freebirdai/dash-spec": patch
---

Split the connection side of Dash's spec into its own package, `@freebirdai/connect-spec`: connections, connectors, catalog entries, record types and their relations, evidence, rhythm and writes. `@freebirdai/dash-spec` re-exports all of it, so existing imports keep working. This is the first step toward the standalone `@freebirdai/connect` integration engine.
