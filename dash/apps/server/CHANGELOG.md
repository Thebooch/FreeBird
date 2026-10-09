# @freebirdai/dash-server

## 0.2.0

### Minor Changes

- 6a61d71: Widgets asked for in chat now land on the board by themselves once their preview checks out, with no style picker or confirm step. The setup stays linked to the placed widgets so follow-up requests change them in place, and hand-editing controls sit behind an optional "Adjust it yourself" link.
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

- 24ecda1: Preserve endpoint contracts and connection-scoped field evidence throughout guided setup. Retain widget coercions, formatting, nested fields and measurements in every draft part; share the REST patch schema with the agent and browser.

  Initialize declared pagination on the first request, keep imported pagination hints inactive, preserve multipart authentication requirements, isolate catalog credentials, and invalidate stale reports and queries after execution changes. Failed mapping passes remain retryable.

  Check guided widget previews against cached upstream responses before either confirmation path saves them. Distinguish unchecked, invalid, empty and partial previews. Legacy catalog connections with ambiguous shared multipart credentials require re-entry; saved widget calculations are not rewritten.

  Preserve source-specific conversions in combined comparisons, including nested money values, and keep account identities on primary and secondary ambiguity choices. Persist mapping and labeling batch checkpoints so retries resume only unfinished work. Honor endpoint-level OpenAPI authentication overrides and expose their credential slots in the connection UI.

### Patch Changes

- fd7fcf7: Tighten the integration engine. Connector code that may send POST is no longer tried until it declares every request it sends. An input another list supplies is settled on that list's single record only when the list is known to have been read to its end; otherwise the endpoint is read for each record. A read made once per record keeps the parts the API answered when it refuses one record, and says which were left out.
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
- Updated dependencies [6a61d71]
- Updated dependencies [3d5061b]
- Updated dependencies [76dc96c]
- Updated dependencies [24ecda1]
- Updated dependencies [fd7fcf7]
- Updated dependencies [e273624]
- Updated dependencies [e273624]
  - @freebirdai/connect@0.2.0
  - @freebirdai/connect-postgres@0.2.0
  - @freebirdai/connect-sandbox@0.2.0
  - @freebirdai/connect-browser@0.2.0
  - @freebirdai/core@0.2.0
  - @freebirdai/connect-server@0.2.0
  - @freebirdai/dash-spec@0.2.0
  - @freebirdai/dash-agent@0.2.0
  - @freebirdai/expr@0.2.0
  - @freebirdai/server@0.2.0
  - @freebirdai/adapters-db-postgres@0.2.0
  - @freebirdai/connect-bench@0.0.0
  - @freebirdai/dash-runtime@0.2.0
