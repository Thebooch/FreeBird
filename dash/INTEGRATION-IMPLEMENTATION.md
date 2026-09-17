# Universal integration implementation

This tracks the approved September 11 plan. A checked entry means implemented and tested, not merely represented by a type.

## Delivery gates

- [ ] Versioned integration contract, database repositories, connection overlays and reversible catalog imports.
- [ ] Budget-approved, resumable preparation with full schema discovery and claim-specific verification.
- [ ] REST, GraphQL and MCP read contracts with structured completeness.
- [ ] Shared server read execution and bidirectional relationship traversal.
- [ ] Intent-driven authoring and semantic field selection.
- [ ] Entity-based record pages and reference navigation across all entry points.
- [ ] Cross-provider regression suite and held-out live-model evaluation.
- [ ] Managed catalog deployment and external read-only MCP facade.

## Invariants

Relationships are integration data, never provider-specific application code. Forward and reverse traversal have separate evidence and execution capabilities. A known inverse never authorizes an unbounded scan. All requests remain account-scoped; publication excludes account observations. Existing dashboards keep their saved meaning. Preparation requires approval of an estimate before paid work. No writes to connected APIs are introduced.

## Implemented slices (September 16)

- Immutable integration definitions, private tenant repositories on PGlite/Postgres, optimistic connection bindings and additive catalog imports. Importing never repoints an existing binding or treats legacy verification flags as evidence.
- A bounded shared server read session with typed identities, authorization before request reuse, forward/reverse traversal and explicit missing/ambiguous/denied/incomplete outcomes. REST and validated GraphQL queries are connected to that service; the existing MCP adapter has completeness metadata but is not connected to it yet.
- An executable **verification stage** of preparation: estimate → exact budget approval → run/resume → checkpoint each direction → publish a new private local version. Reservations precede requests, leases fence old workers, cooldowns survive restarts, and capability attempts cannot exceed three. This stage does not run a model or repair schemas yet.
- Traversal checks require multiple distinct reference values, matching returned identities and observed cardinality. A separate checkpoint checks representative forward/reverse round trips when both directions pass. Missing return paths remain inconclusive because deletion, permissions or scope may explain them. Ignored filters contradict the affected direction; empty, sparse, inaccessible or incomplete samples remain unverified. Evidence contains structural claim codes and counts, not provider rows or keys. New versions do not automatically migrate connections.
- Canonical view intent travels from endpoint selection through proposal mapping, draft patches, persistence and rebuilding. Record filter controls remain unselected and separate from grouping. A declared browse intent cannot silently become an aggregate chart. Explicit manual view edits can replace that default. Nested control fields are included in the deterministic pipeline.
- A searchable index retains all imported field declarations and pages the legacy mapper's resource schemas instead of showing only 14 fields. Page fingerprints support resumable mapping; explicit call budgets stop wider schemas from silently increasing model spend. OpenAPI field import retains wide and deeply nested object fields, follows nested envelopes, and reports resource-limit failures instead of silently truncating. The current flat field representation still does not describe every array/union/recursive branch.
- Legacy relationship proposals and catalog merges distinguish mappings to the same target, preserving roles such as assigned versus billing references. Repeated proposals across schema pages are deduplicated without overwriting existing declarations. Shared read caches include the full binding and pinned operation, as well as tenant and authorization scope.
- Shared read extraction rejects missing paths and non-record payloads rather than returning a misleading empty collection. Empty arrays remain valid, and missing records, access denials and temporary provider failures retain distinct outcomes.

## Record experience added September 17

Connections now offer **Browse records**, using the pinned integration's entity catalog. Collection summaries and entity pages come from the shared read service, with readable labels/descriptions, bounded reference enrichment, typed-reference URLs and lazy related sections. Recipe-defined filters remain unselected and operate explicitly on loaded records; they do not imply verified upstream filtering. Identity and declared reference keys remain in advanced details. Collection and detail permissions are checked independently. A fixture browser journey verifies task → vendor → associated tasks → another task without widget relationship configuration.

This is an additional entry point, not the completed migration: existing widget, search and chat consumers still need to adopt these entity views. Legacy imports remain unverified, so their reference links become executable only after verification and explicit binding migration. Shared recipes are consumed here but their LLM preparation workflow is still outstanding.

Validation: Dash package builds, production web build and all Dash type checks passed. The serial regression run passed 114 files / 2,223 tests; one additional suite hit a worker module-resolution timeout before starting. That suite passed separately (14 tests), together with the updated read-service suite (15 tests, including one added title-visibility regression). This covers 115 files / 2,238 distinct tests across the runs. Lint reports no errors and three existing unused-import warnings in the REST adapter. Browser verification used an isolated local fixture, not a live provider or paid model.

## Still required before these gates can close

- Full schema graph discovery (including arrays, variants, recursive schemas and operations outside legacy resource grouping) and LLM preparation/repair orchestration. The verification-stage estimate is not an estimate for the complete discovery workflow; the indexed legacy mapper is not yet the database-backed preparation workflow.
- Independent request/extraction/pagination/unit verification. The current direction and round-trip checks prove sampled key correspondence, not universal completeness or semantic correctness.
- Complete junction, array-of-object and polymorphic retrieval planning; overlays beyond connection context/disabled relationships; dependency-aware saved-view migrations and export/rollback UX.
- Shared semantic field search, reference enrichment and entity recipes used by every widget, record page, search and chat entry point. Existing widget joins and detail planners are not retired yet.
- GraphQL introspection/SDL ingestion and custom scalar mapping; MCP connection admission and shared-service execution; declared aggregation and filtered navigation from aggregate rows.
- User-facing preparation approval/progress, automatic orchestration after approval, and the full clarification/decision editing experience. Current preparation endpoints are server primitives, not the finished setup flow.
- Managed publication sanitization/allowlisting, managed deployment, external MCP facade, cross-provider held-out fixtures and the 100 × 3 live-model/usability readiness gate. No claim of write readiness is made.

## Verification-stage endpoints

All routes use host-supplied tenant and connection authorization. `POST /api/integrations/preparations` accepts a connection and returns an estimate without making provider requests. `POST /api/integrations/preparations/:id/approve` requires its revision and contract fingerprint. `POST /api/integrations/preparations/:id/run` executes approved work; a paused job can provide `resumeRevision`. `GET /api/integrations/preparations/:id` reports checkpoints, reserved requests, cooldown and resulting version. Running before approval performs no work. Published versions remain private to the tenant until the separate managed publication gate exists.
