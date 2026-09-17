---
"@freebirdai/dash-spec": minor
"@freebirdai/dash-agent": patch
"@freebirdai/dash-adapters": patch
"@freebirdai/dash-react": patch
"@freebirdai/dash-server": minor
---

Persist view intent through guided authoring, distinguish available filters from aggregation, and reject proposals that contradict a planned record view. Preserve nested filter fields during draft rebuilding and prevent aggregate intent from opening a single-record drilldown.

Add budget-approved, resumable relationship verification with fenced leases, persistent attempts and cooldowns, sanitized evidence summaries, and immutable private version publication. Pin read interactions to their integration binding and reject mid-read binding changes.

Index imported schema fields in bounded, resumable mapping pages instead of dropping fields after the first 14. Preserve wider and deeper OpenAPI object schemas, report import resource limits, and retain distinct relationship roles when they target the same entity.

Check representative forward/reverse relationship round trips separately, keeping missing paths inconclusive. Isolate shared read caches by the complete binding and pinned operation as well as tenant and authorization context.

Reject invalid record extraction instead of presenting malformed responses as empty collections, and preserve upstream REST error codes for missing-record classification without changing proxy response codes.

Add a connection record browser and reusable entity pages backed by shared server reads, with readable reference links, lazy related collections, recipe-defined loaded-record filters, typed-reference navigation, and advanced identity details. Keep detail and collection permissions independent.
