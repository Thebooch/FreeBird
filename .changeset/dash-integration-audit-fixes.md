---
"@freebirdai/dash-spec": patch
"@freebirdai/connect": patch
"@freebirdai/dash-server": patch
---

Tighten the integration engine. Connector code that may send POST is no longer tried until it declares every request it sends. An input another list supplies is settled on that list's single record only when the list is known to have been read to its end; otherwise the endpoint is read for each record. A read made once per record keeps the parts the API answered when it refuses one record, and says which were left out.
