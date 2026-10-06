---
"@freebirdai/connect": minor
---

`WriteService.commit` returns the journal entry's `eventId` and, when the change can be undone, its `reversal`, so a caller can offer Reverse without reading the journal back.
