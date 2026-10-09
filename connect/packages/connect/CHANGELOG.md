# @freebirdai/connect

## 0.2.0

### Minor Changes

- 01e073a: Add `@freebirdai/connect-actions`: any API from a FreeBird guide chat. `createConnectKit(connect)` returns a guide component with `add_api`, `check_api` and `change_record` actions, and two chat tools (`connect_list_apis`, `connect_read`, with counts and totals) that answer questions during the turn. A change's confirmation card is the engine's own review, and only that reviewed change is committed. `connect.writes.prepare` takes a `sessionId`, so a conversation asking again for the same change gets the same review.
- 6b7bfe5: Split the integration engine's heavy dependencies into opt-in add-ons. `@freebirdai/connect-postgres` holds the Postgres/PGlite stores (`openConnectDb`, `createDbStores`), `@freebirdai/connect-sandbox` runs generated connector code in QuickJS, and `@freebirdai/connect-browser` reads documentation drawn in the browser. Without them the engine keeps its state in memory and a local encrypted key file (`createLocalStores`), refuses connector code, and skips browser-drawn docs. The engine's tables are now named `connect_*`, so their earlier contents are not carried over. The engine uses `@freebirdai/core`'s LLM adapter shape, which gains optional cached-token counts.
- 7bb37b8: `WriteService.commit` returns the journal entry's `eventId` and, when the change can be undone, its `reversal`, so a caller can offer Reverse without reading the journal back.
- 4488a52: Add `createConnect`, the engine's public API: add an API from its documentation or OpenAPI address, save its key, check it, read an endpoint or a record type with a filter and a freshness bound, keep reads warm, make two-step reviewed changes, and listen for reads, failures, checks and writes. `createEngine` exposes the same machinery for a host that serves it itself; Dash's server now builds its engine with it.
- ce27094: Make Connect usable on its own: a README with a five-minute quickstart, an `AGENTS.md` integration guide, a docs-site section, and two runnable examples (`examples/connect-node`, `examples/connect-express`). After a check, the engine now describes the API's record types by itself when a model is configured, so `read({ record })` works without a host wiring it up.
- 474e53c: Move the integration engine into `@freebirdai/connect`: discovery, sign-in, mapping, the response cache and keeper, jobs, drift, evidence and reviewed writes, the REST and MCP source adapters (formerly `@freebirdai/dash-adapters`), and the API-mapping half of the authoring agent. `@freebirdai/dash-agent` re-exports the moved agent passes. A saved connection's `onboarding` and a category's `starters` are now stored by the engine without being read; Dash reads them through `onboardingOf` and `startersOf`.
- b403d7b: Finish moving the integration routes out of Dash. `connect-server`'s Fastify entry now also serves a connection's routes (`connectionRoutes`: listing, saving, the catalog, adding from the catalog, address, endpoints, record types, references, checks, enumeration, rhythm), discovery (`discoverRoutes`), keys (`keyRoutes`) and reviewed changes (`writeRoutes`), each taking an engine and a host's own hooks. The engine gains enumeration, field observation, the write-endpoint reader and the connection view the routes serve. `RendererStatus` and `RendererSetup` move into the engine core; `connect-browser` re-exports `RendererStatus`. The benchmark's mock APIs become the engine's test bed in a private `connect/packages/bench`.
- cacc921: Close the gaps between Connect on its own and Connect inside Dash.
  - One read: `createEngine().read` carries a read capped at its page limit on in the background, refreshes an answer a background read owns the same way, and watches each fresh answer's shape. Dash's tile route and `connect.read()` both go through it. `connect.read()` waits for the whole answer by default (`wait: false` returns early with `progress`), and `ReadResult` gains `complete`, `completion`, `pages`, `reportedTotal`, `progress` and `changed`.
  - Drift: `DriftWatch` moves into Connect. A host says whether anything it saved reads the fields that changed (`readsFields`); on its own, every change is reported and the endpoint checked again.
  - Shared packages: the expression language is now `@freebirdai/expr` (formerly `@freebirdai/dash-expr`), and the LLM adapter contract and approval digest move into `@freebirdai/contracts`, which `@freebirdai/core` re-exports. Connect no longer depends on `@freebirdai/core`.
  - `allowlistEgress` and `configureEgress` are exported from `@freebirdai/connect`, as its integration guide says; a test now checks every import the Connect guides show.

- c042b29: Add `@freebirdai/connect-server`: the engine's HTTP routes (add a connection, save its key, check it, list its record types, read, prepare and commit changes), one route list served on Fastify, Express and the Next.js App Router. The integrate, map and OAuth route plugins move here from Dash, and record-type mapping and verification move into the engine core (`@freebirdai/connect/map`, `@freebirdai/connect/verify-records`).
- 4175415: Changes made by workflows and agents are journalled as such.
  - `WriteEvent.via` (and `prepare`'s `via`) can now be `"workflow"` or `"agent"` beside `"form"` and `"chat"`, and an event can carry `onBehalfOf: { kind: "agent", id }`. The actor is still the person whose permission the change used.
  - The single read behind `connect.read()` is exported as `createRecordReader`, so a host can read records the same way for its own background work.
  - Dash spec: workflows (`workflow.ts`): a trigger, an optional source and criteria, and steps that are each `auto` or `approve`, with an optional condition. A new `workflows.manage` permission.

- 76dc96c: Connection onboarding: a new connection ends by asking what somebody wants from it and building it.
  The API behind it is prepared once for everybody who connects it — what the software is, the parts it
  divides into, a starter set of widget briefs per part, and how often each kind of record arrives — one
  step per request, each written as it lands, so preparation resumes wherever it stopped. The person then
  chooses parts and one tab or a tab each, previews the boards with every widget tried against their account
  (a refused widget is left off with its reason; one that could not be tried because of a rate limit is
  kept), and creates exactly what was previewed. Setup is a resumable state on the connection
  (`pending → choosing → preview → creating → complete`, or `skipped`); an interrupted create finishes the
  same boards without overwriting any it already wrote. Existing connections reach it from their
  **Dashboards** button, which also makes another set.

  The shared half stores briefs, never widgets, and a fingerprint of the API reading it was made against,
  so a re-described API is prepared again rather than served stale. Starter composition refuses widgets
  whose endpoints need inputs a board cannot supply, and both model passes retry once with the reasons they
  were refused.

  Keeping boards fresh: a board being looked at reads the server's cache and never calls the API; the
  keeper refreshes, on each endpoint's cadence, exactly the requests boards made — including changed filters,
  picked ranges and path parameters — and warms new boards before they are opened. It reads refusals behind
  cached copies (a 401 or 403 stops a target until the connection's key changes; a 429 pauses the connection
  until the API allows it), and a changed cadence applies at the next tick. Polls re-read the server rather
  than the API, and staleness is labelled against the endpoint's cadence. The cache key no longer carries the
  time range for endpoints that do not read it, and 304 responses are no longer treated as redirects.

  Catalog, connection, dashboard and cadence files are written atomically.

### Patch Changes

- b1b8de4: `ReadResult.complete` is true only on affirmative evidence: the read was traversed to its end, nothing was truncated, and nothing is still being read. A read whose end is unknown (for example, paging nobody has confirmed) is no longer reported complete. The chat's read tool passes `complete` on to the model.
- 24ecda1: Preserve endpoint contracts and connection-scoped field evidence throughout guided setup. Retain widget coercions, formatting, nested fields and measurements in every draft part; share the REST patch schema with the agent and browser.

  Initialize declared pagination on the first request, keep imported pagination hints inactive, preserve multipart authentication requirements, isolate catalog credentials, and invalidate stale reports and queries after execution changes. Failed mapping passes remain retryable.

  Check guided widget previews against cached upstream responses before either confirmation path saves them. Distinguish unchecked, invalid, empty and partial previews. Legacy catalog connections with ambiguous shared multipart credentials require re-entry; saved widget calculations are not rewritten.

  Preserve source-specific conversions in combined comparisons, including nested money values, and keep account identities on primary and secondary ambiguity choices. Persist mapping and labeling batch checkpoints so retries resume only unfinished work. Honor endpoint-level OpenAPI authentication overrides and expose their credential slots in the connection UI.

- fd7fcf7: Tighten the integration engine. Connector code that may send POST is no longer tried until it declares every request it sends. An input another list supplies is settled on that list's single record only when the list is known to have been read to its end; otherwise the endpoint is read for each record. A read made once per record keeps the parts the API answered when it refuses one record, and says which were left out.
- Updated dependencies [ce27094]
- Updated dependencies [474e53c]
- Updated dependencies [cacc921]
- Updated dependencies [be9f5ec]
- Updated dependencies [24ecda1]
  - @freebirdai/connect-spec@0.2.0
  - @freebirdai/expr@0.2.0
  - @freebirdai/contracts@0.2.0
