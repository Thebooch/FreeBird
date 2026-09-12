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
