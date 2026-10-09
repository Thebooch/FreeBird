# @freebirdai/core

## 0.2.0

### Minor Changes

- e273624: Remove host-specific behavior from the core engine so the framework is fully application-agnostic.

  The engine no longer recognizes any particular component id or host tool name. Previously a handful of
  identifiers from the app FreeBird was extracted from were special-cased in `@freebirdai/core`, which meant
  undocumented magic behavior for anyone who happened to use the same names.

  **Removed**
  - The per-session argument stash that merged processing-tool output into one specific component's pending
    action, and its `blueprintStash` plumbing through the action-tool context.
  - The hardcoded continuation prompt that steered the model after a specific host tool ran.
  - The lookup table mapping specific host tool names to workspace citation component ids.
  - The per-tool natural-language summary templates for specific host tools.
  - Host tool names referenced by example in harness/engine prompt text.

  **Generalized**
  - **Processing-tool arg contributions.** Any host tool may now contribute args by returning `normalizedArgs`
    on its result — no name allowlist. Two optional guards are honored when present: `actionRef`
    (`"componentId:actionId"`) scopes the contribution to the pending action, and a non-empty `invalid[]`
    suppresses the merge. Results carrying `error` are skipped.
  - **Workspace citations.** Host tools declare them by returning `workspaceCitations` or `componentIds` on
    their result, instead of relying on a built-in per-tool table.
  - **Deterministic tool summaries.** A host tool may return a `summary` string to control the assistant's
    fallback text. Without one, the engine asks the LLM to summarize the raw tool results — which is the
    better default.

  **Breaking**
  - `Ticket.firmId` is now `Ticket.orgId`, sourced from the first-class `AuthContext.orgId` instead of an
    untyped cast on the auth object. Hosts that read `firmId` off filed tickets should read `orgId`; hosts
    that set a tenant id should populate `auth.orgId` (as the DB adapters already expect).

- e273624: Initial release of the FreeBird framework: chat engine with actions,
  citations, and knowledge retrieval; deterministic layout solver;
  per-component locks and custom tabs; digests (in-process + standalone
  worker); support/ticket escalation; React, Vue, and Angular bindings with
  optional Tailwind presets; script-tag embed widget; Registration Manifest +
  codegen and the create-freebird CLI; MCP server; and first-party adapters
  for OpenAI, Anthropic, Postgres (Kysely), Prisma, Resend, and SMTP.

### Patch Changes

- 6b7bfe5: Split the integration engine's heavy dependencies into opt-in add-ons. `@freebirdai/connect-postgres` holds the Postgres/PGlite stores (`openConnectDb`, `createDbStores`), `@freebirdai/connect-sandbox` runs generated connector code in QuickJS, and `@freebirdai/connect-browser` reads documentation drawn in the browser. Without them the engine keeps its state in memory and a local encrypted key file (`createLocalStores`), refuses connector code, and skips browser-drawn docs. The engine's tables are now named `connect_*`, so their earlier contents are not carried over. The engine uses `@freebirdai/core`'s LLM adapter shape, which gains optional cached-token counts.
- cacc921: Close the gaps between Connect on its own and Connect inside Dash.
  - One read: `createEngine().read` carries a read capped at its page limit on in the background, refreshes an answer a background read owns the same way, and watches each fresh answer's shape. Dash's tile route and `connect.read()` both go through it. `connect.read()` waits for the whole answer by default (`wait: false` returns early with `progress`), and `ReadResult` gains `complete`, `completion`, `pages`, `reportedTotal`, `progress` and `changed`.
  - Drift: `DriftWatch` moves into Connect. A host says whether anything it saved reads the fields that changed (`readsFields`); on its own, every change is reported and the endpoint checked again.
  - Shared packages: the expression language is now `@freebirdai/expr` (formerly `@freebirdai/dash-expr`), and the LLM adapter contract and approval digest move into `@freebirdai/contracts`, which `@freebirdai/core` re-exports. Connect no longer depends on `@freebirdai/core`.
  - `allowlistEgress` and `configureEgress` are exported from `@freebirdai/connect`, as its integration guide says; a test now checks every import the Connect guides show.

- Updated dependencies [cacc921]
  - @freebirdai/contracts@0.2.0
