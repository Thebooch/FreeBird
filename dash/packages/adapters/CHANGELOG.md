# @freebirdai/dash-adapters

## 0.2.0

### Patch Changes

- 24ecda1: Preserve endpoint contracts and connection-scoped field evidence throughout guided setup. Retain widget coercions, formatting, nested fields and measurements in every draft part; share the REST patch schema with the agent and browser.

  Initialize declared pagination on the first request, keep imported pagination hints inactive, preserve multipart authentication requirements, isolate catalog credentials, and invalidate stale reports and queries after execution changes. Failed mapping passes remain retryable.

  Check guided widget previews against cached upstream responses before either confirmation path saves them. Distinguish unchecked, invalid, empty and partial previews. Legacy catalog connections with ambiguous shared multipart credentials require re-entry; saved widget calculations are not rewritten.

  Preserve source-specific conversions in combined comparisons, including nested money values, and keep account identities on primary and secondary ambiguity choices. Persist mapping and labeling batch checkpoints so retries resume only unfinished work. Honor endpoint-level OpenAPI authentication overrides and expose their credential slots in the connection UI.

- Updated dependencies [24ecda1]
  - @freebirdai/dash-spec@0.2.0
  - @freebirdai/dash-expr@0.2.0
