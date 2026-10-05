---
"@freebirdai/connect": minor
"@freebirdai/connect-postgres": minor
"@freebirdai/connect-sandbox": minor
"@freebirdai/connect-browser": minor
"@freebirdai/core": patch
---

Split the integration engine's heavy dependencies into opt-in add-ons. `@freebirdai/connect-postgres` holds the Postgres/PGlite stores (`openConnectDb`, `createDbStores`), `@freebirdai/connect-sandbox` runs generated connector code in QuickJS, and `@freebirdai/connect-browser` reads documentation drawn in the browser. Without them the engine keeps its state in memory and a local encrypted key file (`createLocalStores`), refuses connector code, and skips browser-drawn docs. The engine's tables are now named `connect_*`, so their earlier contents are not carried over. The engine uses `@freebirdai/core`'s LLM adapter shape, which gains optional cached-token counts.
