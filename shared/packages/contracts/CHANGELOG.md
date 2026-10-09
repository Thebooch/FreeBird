# @freebirdai/contracts

## 0.2.0

### Minor Changes

- cacc921: Close the gaps between Connect on its own and Connect inside Dash.
  - One read: `createEngine().read` carries a read capped at its page limit on in the background, refreshes an answer a background read owns the same way, and watches each fresh answer's shape. Dash's tile route and `connect.read()` both go through it. `connect.read()` waits for the whole answer by default (`wait: false` returns early with `progress`), and `ReadResult` gains `complete`, `completion`, `pages`, `reportedTotal`, `progress` and `changed`.
  - Drift: `DriftWatch` moves into Connect. A host says whether anything it saved reads the fields that changed (`readsFields`); on its own, every change is reported and the endpoint checked again.
  - Shared packages: the expression language is now `@freebirdai/expr` (formerly `@freebirdai/dash-expr`), and the LLM adapter contract and approval digest move into `@freebirdai/contracts`, which `@freebirdai/core` re-exports. Connect no longer depends on `@freebirdai/core`.
  - `allowlistEgress` and `configureEgress` are exported from `@freebirdai/connect`, as its integration guide says; a test now checks every import the Connect guides show.
