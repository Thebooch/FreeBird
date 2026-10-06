---
"@freebirdai/connect": patch
"@freebirdai/connect-actions": patch
---

`ReadResult.complete` is true only on affirmative evidence: the read was traversed to its end, nothing was truncated, and nothing is still being read. A read whose end is unknown (for example, paging nobody has confirmed) is no longer reported complete. The chat's read tool passes `complete` on to the model.
