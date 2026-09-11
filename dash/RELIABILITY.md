# Guided setup reliability

The setup pipeline keeps three separate facts: the endpoint's declared contract, observed account data, and the widget's own configuration. A declared field list is sufficient to propose a widget, but it is not evidence that a request or calculation worked.

## Connection and endpoint contracts

- Catalog connections retain parameters, defaults, descriptions, field schemas and endpoint-specific pagination overrides.
- Required query inputs appear as guided questions. Path inputs remain scoped to the request that supplies them.
- REST and MCP request the declared starting page and page size on the first request. Repeated pages, missing row envelopes and page caps must not be presented as complete results.
- OpenAPI pagination guesses are retained as `paginationProposal`, not installed as executable dialect settings. `paginationPending` warns that an imported connection may return only one response until pagination is configured. An endpoint's own pagination setting takes precedence over its connection dialect.
- The catalog response-check badge means that a real response contained usable data. It does not prove that every endpoint, permission, page boundary or account is covered.
- Security requirement objects retain their AND semantics. Supported header pairs get distinct vault references per connection. Explicit public security is respected; missing or unsupported authentication declarations require configuration. A 403 does not prove authentication succeeded, and cannot override a later 401.
- Operation-level OpenAPI security overrides take precedence over the connection default. Public operations do not receive the default credential; alternative schemes use distinct account-scoped slots that appear in the key panel. Unsupported operation requirements block that operation until configured.
- Catalog matching strips a small explicit set of service prefixes instead of treating the final two hostname labels as an organisation. This avoids cross-vendor matches on suffixes such as `co.uk`; uncommon aliases may require an explicit catalog selection.

## Drafts and comparisons

Endpoint ids are local to a connection. Contexts store field evidence separately for each connection, and multi-connection planner candidates are qualified before selection. Drafts and saved sources retain the actual connection id.

Every widget part uses the same patch contract, including required inputs, controls, measurement, filters, coercions and formats. Unknown REST patch fields fail validation instead of disappearing. Connection and endpoint changes apply before dependent settings and clear stale choices.

Proposal-to-draft conversion reverses flattened field aliases and preserves unit conversions. Expression renaming leaves string literals and function names intact. Existing saved widgets are not recalculated or silently corrected; a previously saved widget with incorrect units should be reviewed and explicitly revised.

Each comparison endpoint gets its own binding proposal. A combined axis requires compatible measurement shapes and formats; otherwise the proposal uses separate views, retaining each measurement's transformations. Nested comparisons still require a viable, bounded fan-out. Unresolved meaning and unit questions remain visible. Only a typed missing-endpoint ambiguity that an included source actually resolves is removed automatically.

Combined series apply each source's own flattening and conversions before filtering and aggregation, including nested money values and date formats. The common value axis retains the primary measurement's configured format. Account-specific ambiguity choices carry a separate option identity and connection id. Secondary ambiguities remain attached to the secondary widget; choosing another account clears bindings from the old account.

## Recovery and preview checks

Explicit “Read again” bypasses stored enumeration results. Execution fingerprints include request contracts, base URL, auth configuration and credential revision. Changes invalidate query data and in-flight cache writes; old capability reports are ignored rather than silently sampled again.

An explicit catalog schema refresh updates imported contract fields on existing connections while preserving local overrides. A failed mapping or labeling pass retains successful output but does not mark the pass complete, so retry remains available.

Mapping and labeling save checkpoints after each successful batch. A retry skips completed batches for the same input contract and pass version, including across restarts. Schema changes invalidate those checkpoints, and an explicit forced run starts the batches again. If mapping succeeded but labeling failed, retrying the same map route resumes labeling without remapping.

The browser renders the current draft with the normal widget runtime. Proxied reads return opaque receipts; the server checks the draft against those already-cached responses without another upstream request. Both REST confirmation and chat confirmation enforce that check. Changed widgets, changed credentials, evicted data and expired receipts invalidate evidence. A multi-widget build with any build error cannot be partly committed.

Preview outcomes are `unchecked`, `invalid`, `checked`, `empty`, and `partial`. Empty and partial results are explicitly described; they are not presented as proof of complete account data. A check is bounded to the sampled response and current configuration, not a guarantee against future upstream schema changes. Receipts expire after ten minutes and never contain credentials or response bodies.

## Existing installations

Old drafts default missing `inputs`, `coercions`, and `format` to empty objects. New report fingerprints can make older capability reports stale; the UI offers an explicit reread instead of spending requests during migration.

For legacy catalog imports with multipart credentials, a uniquely owned secret is copied to the connection-specific reference. If two accounts shared an old reference, the migration assigns separate empty references and requires credentials to be entered for each account. Original encrypted entries are retained; the migration never guesses ownership or deletes them.

Tests use deterministic responses and fake model outputs. Live-provider authentication, rate limits and pagination semantics must still be checked against the provider's actual contract. No live credentials are required to run the regression suite.

On September 9, 2026, a bounded read against the existing Buildium connection returned HTTP 429. No retry was attempted. This exercised rate-limit reporting, but did not verify the provider's current response shape or pagination semantics.
