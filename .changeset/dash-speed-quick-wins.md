---
"@freebirdai/connect-spec": patch
"@freebirdai/connect": patch
---

Less repeated work on every read.

- `@freebirdai/connect-spec`: `fingerprintConnection` keeps the fingerprint of a connection that is frozen together with its endpoints, so a host that hands out one frozen copy pays for it once instead of on every read. A connection that is not frozen is worked out each time, as before.
- `@freebirdai/connect`: `CatalogStore.stamp()`, the catalog's files as one string (path, modified time and size of each). Equal stamps mean `list()` would answer the same, so a host can keep what it derived from the whole catalog without copying every entry to find out nothing changed.
