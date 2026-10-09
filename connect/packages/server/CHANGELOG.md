# @freebirdai/connect-server

## 0.2.0

### Minor Changes

- b403d7b: Finish moving the integration routes out of Dash. `connect-server`'s Fastify entry now also serves a connection's routes (`connectionRoutes`: listing, saving, the catalog, adding from the catalog, address, endpoints, record types, references, checks, enumeration, rhythm), discovery (`discoverRoutes`), keys (`keyRoutes`) and reviewed changes (`writeRoutes`), each taking an engine and a host's own hooks. The engine gains enumeration, field observation, the write-endpoint reader and the connection view the routes serve. `RendererStatus` and `RendererSetup` move into the engine core; `connect-browser` re-exports `RendererStatus`. The benchmark's mock APIs become the engine's test bed in a private `connect/packages/bench`.
- c042b29: Add `@freebirdai/connect-server`: the engine's HTTP routes (add a connection, save its key, check it, list its record types, read, prepare and commit changes), one route list served on Fastify, Express and the Next.js App Router. The integrate, map and OAuth route plugins move here from Dash, and record-type mapping and verification move into the engine core (`@freebirdai/connect/map`, `@freebirdai/connect/verify-records`).

### Patch Changes

- ce27094: Make Connect usable on its own: a README with a five-minute quickstart, an `AGENTS.md` integration guide, a docs-site section, and two runnable examples (`examples/connect-node`, `examples/connect-express`). After a check, the engine now describes the API's record types by itself when a model is configured, so `read({ record })` works without a host wiring it up.
- cacc921: Close the gaps between Connect on its own and Connect inside Dash.
  - One read: `createEngine().read` carries a read capped at its page limit on in the background, refreshes an answer a background read owns the same way, and watches each fresh answer's shape. Dash's tile route and `connect.read()` both go through it. `connect.read()` waits for the whole answer by default (`wait: false` returns early with `progress`), and `ReadResult` gains `complete`, `completion`, `pages`, `reportedTotal`, `progress` and `changed`.
  - Drift: `DriftWatch` moves into Connect. A host says whether anything it saved reads the fields that changed (`readsFields`); on its own, every change is reported and the endpoint checked again.
  - Shared packages: the expression language is now `@freebirdai/expr` (formerly `@freebirdai/dash-expr`), and the LLM adapter contract and approval digest move into `@freebirdai/contracts`, which `@freebirdai/core` re-exports. Connect no longer depends on `@freebirdai/core`.
  - `allowlistEgress` and `configureEgress` are exported from `@freebirdai/connect`, as its integration guide says; a test now checks every import the Connect guides show.

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
- Updated dependencies [be9f5ec]
- Updated dependencies [4175415]
- Updated dependencies [76dc96c]
- Updated dependencies [24ecda1]
- Updated dependencies [fd7fcf7]
  - @freebirdai/connect@0.2.0
  - @freebirdai/connect-spec@0.2.0
