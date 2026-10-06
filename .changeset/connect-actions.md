---
"@freebirdai/connect": minor
"@freebirdai/connect-actions": minor
---

Add `@freebirdai/connect-actions`: any API from a FreeBird guide chat. `createConnectKit(connect)` returns a guide component with `add_api`, `check_api` and `change_record` actions, and two chat tools (`connect_list_apis`, `connect_read`, with counts and totals) that answer questions during the turn. A change's confirmation card is the engine's own review, and only that reviewed change is committed. `connect.writes.prepare` takes a `sessionId`, so a conversation asking again for the same change gets the same review.
