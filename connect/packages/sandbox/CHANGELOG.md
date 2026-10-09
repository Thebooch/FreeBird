# @freebirdai/connect-sandbox

## 0.2.0

### Minor Changes

- 6b7bfe5: Split the integration engine's heavy dependencies into opt-in add-ons. `@freebirdai/connect-postgres` holds the Postgres/PGlite stores (`openConnectDb`, `createDbStores`), `@freebirdai/connect-sandbox` runs generated connector code in QuickJS, and `@freebirdai/connect-browser` reads documentation drawn in the browser. Without them the engine keeps its state in memory and a local encrypted key file (`createLocalStores`), refuses connector code, and skips browser-drawn docs. The engine's tables are now named `connect_*`, so their earlier contents are not carried over. The engine uses `@freebirdai/core`'s LLM adapter shape, which gains optional cached-token counts.

### Patch Changes

- ce27094: Make Connect usable on its own: a README with a five-minute quickstart, an `AGENTS.md` integration guide, a docs-site section, and two runnable examples (`examples/connect-node`, `examples/connect-express`). After a check, the engine now describes the API's record types by itself when a model is configured, so `read({ record })` works without a host wiring it up.
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
