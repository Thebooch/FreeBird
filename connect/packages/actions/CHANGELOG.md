# @freebirdai/connect-actions

## 0.2.0

### Minor Changes

- 01e073a: Add `@freebirdai/connect-actions`: any API from a FreeBird guide chat. `createConnectKit(connect)` returns a guide component with `add_api`, `check_api` and `change_record` actions, and two chat tools (`connect_list_apis`, `connect_read`, with counts and totals) that answer questions during the turn. A change's confirmation card is the engine's own review, and only that reviewed change is committed. `connect.writes.prepare` takes a `sessionId`, so a conversation asking again for the same change gets the same review.

### Patch Changes

- b1b8de4: `ReadResult.complete` is true only on affirmative evidence: the read was traversed to its end, nothing was truncated, and nothing is still being read. A read whose end is unknown (for example, paging nobody has confirmed) is no longer reported complete. The chat's read tool passes `complete` on to the model.
- Updated dependencies [01e073a]
- Updated dependencies [6b7bfe5]
- Updated dependencies [7bb37b8]
- Updated dependencies [b1b8de4]
- Updated dependencies [4488a52]
- Updated dependencies [ce27094]
- Updated dependencies [474e53c]
- Updated dependencies [b403d7b]
- Updated dependencies [cacc921]
- Updated dependencies [c042b29]
- Updated dependencies [4175415]
- Updated dependencies [76dc96c]
- Updated dependencies [24ecda1]
- Updated dependencies [fd7fcf7]
- Updated dependencies [e273624]
- Updated dependencies [e273624]
  - @freebirdai/connect@0.2.0
  - @freebirdai/core@0.2.0
