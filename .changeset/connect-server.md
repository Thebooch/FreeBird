---
"@freebirdai/connect": minor
"@freebirdai/connect-server": minor
---

Add `@freebirdai/connect-server`: the engine's HTTP routes (add a connection, save its key, check it, list its record types, read, prepare and commit changes), one route list served on Fastify, Express and the Next.js App Router. The integrate, map and OAuth route plugins move here from Dash, and record-type mapping and verification move into the engine core (`@freebirdai/connect/map`, `@freebirdai/connect/verify-records`).
