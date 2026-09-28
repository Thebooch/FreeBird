# Guided setup reliability

The setup pipeline keeps three separate facts: the endpoint's declared contract, observed account data, and the widget's own configuration. A declared field list is sufficient to propose a widget, but it is not evidence that a request or calculation worked.

## Connection and endpoint contracts

- Catalog connections retain parameters, defaults, descriptions, field schemas and endpoint-specific pagination overrides.
- Required query inputs appear as guided questions. Path inputs remain scoped to the request that supplies them.
- REST and MCP request the declared starting page and page size on the first request. Repeated pages, missing row envelopes and page caps must not be presented as complete results.
- Pagination guesses, from an OpenAPI specification or from prose documentation, are retained as `paginationProposal`, not installed as executable dialect settings. `paginationPending` warns that an imported connection may return only one response until pagination is configured. An endpoint's own pagination setting takes precedence over its connection dialect.
- What Dash can and cannot connect to is one manifest, `packages/spec/src/capabilities.ts`, and `COMPATIBILITY.md` is generated from it. When an importer meets something outside it — a sign-in scheme it cannot perform, a required header parameter, a CSV or XML response, a specification split across files, an endpoint served from another address — it says so in the manifest's words at import time, instead of dropping it or treating the API as needing no key.
- The catalog response-check badge means that a real response contained usable data. It does not prove that every endpoint, permission, page boundary or account is covered.
- Security requirement objects retain their AND semantics. Supported header pairs get distinct vault references per connection. Explicit public security is respected; missing or unsupported authentication declarations require configuration. A 403 does not prove authentication succeeded, and cannot override a later 401.
- Operation-level OpenAPI security overrides take precedence over the connection default. Public operations do not receive the default credential; alternative schemes use distinct account-scoped slots that appear in the key panel. Unsupported operation requirements block that operation until configured.
- Catalog matching strips a small explicit set of service prefixes instead of treating the final two hostname labels as an organisation. This avoids cross-vendor matches on suffixes such as `co.uk`; uncommon aliases may require an explicit catalog selection.

## Checking a connection, and what it proves

A connection made from documentation is checked before anything is built on it, **by itself**: as soon as it can be read — its key saved, or an API that needs none added, or its account address filled in — the server starts the check in the background (`autoIntegrate`, on in the real entry point, off in tests), and the setup screen runs it if it never ran. Nobody is asked to start it. A check already running is joined, never repeated, and one started by itself waits behind boards at the connection's gate. It only reads; it never changes the account. `POST /api/connections/:id/integrate` runs or joins it on demand. The check reads the endpoints its boards would use, the way they will read them — the same adapter, key, guard, gate and cooldown — within a budget of 60 requests. When a read fails it tries what a developer would, keeping a change only when a real request then gets further:

- an address the documentation's own text names, only on the same organisation's domain as the documentation or the address already in use — a key is never sent to another organisation's host, whatever a page says;
- the other ways of sending the same key (a bearer token, a named header, a query parameter), ordered by what the documentation mentions;
- a header the API asked for, with the value the specification allows or the documentation states — never a guessed value;
- where the records really are in the response.

When none of those works, one change is asked of a model (the `repair` task), with the same rule: it is tried like any other candidate and kept only if the read gets further, and a model that finds the API needs something no change can express says so rather than guessing.

**When no change can express it**, the check asks for code instead (the `connector` task): a sign-in the importer could not represent, an endpoint whose ids come from other requests, or a repair model saying the API needs more than a change. The model reads the documentation and writes a connector — small JavaScript plus the authority it needs — which is loaded in the sandbox, installed on a copy of the connection and read through, exactly as a board will read it. It is kept only when that read returns records. When it does not, the model is shown what happened (the error, the requests the code sent, what it logged — never a credential) and tries again, three times at most. A connector that declares credentials nobody has pasted is kept as a draft, and the check asks for them in the documentation's words ("Paste the Key ID and Secret from your Vaultbank account"); pasting them starts the next check, which tries the code. Once a connection has code, a read that fails is a revision of the code, not a repair around it. Without a sandbox or a model, a sign-in the importer could not represent stops the check at once, with the capability named — nothing was sent, and it is never reported as a refusal. Connector code reads; a change through a connection that signs in with one is refused, not sent unsigned. See `PLATFORM.md` for what contains the code, and what does not.

How each endpoint pages is then confirmed by reading its second page (`discovery/probe-pagination.ts`). A rule is installed — with `paginationChecked` — only when the second page returned records the first did not. A proposal's cursor path is checked against the first page and replaced by the field that really holds the cursor, and a short first page is retried at the size the API returned, because an API that caps a request for 100 at 25 would otherwise read as ending after one page. A documented default for a parameter the paging rule sets is the rule's to decide: filling it in beside the rule made every paged request conflict.

What was observed is **evidence**, one rung of a ladder, never a single "complete" flag:

| Level | What it establishes |
|---|---|
| `accepted` | This request was accepted. |
| `advanced` | This continuation returned different records. |
| `traversed` | The configured continuation rule reached an end. |
| `count-reconciled` | The records retrieved match a count stated under the same scope. |
| `metric-reconciled` | A calculation matches an independent expected result. |

Each record carries its scope, the configuration it was observed with (`fingerprintConnection`), when, and the limits it ran within. Only evidence gathered with the connection's current configuration counts as a claim about it (`strongestEvidence`); a changed address or key makes earlier evidence history. Evidence is kept in Dash's own database (`.dash/dash-db`, or Postgres when `DATABASE_URL` is set), bounded per endpoint, and removed with its connection. Keeping it is best-effort: a database that refuses a write is logged, and the check it describes still counts. The server closes both embedded databases on SIGINT and SIGTERM, since a process killed while one is open can leave it damaged.

## Reads that are not a plain GET, and signing in

**Reads sent with POST.** A search or report that needs a request body is imported as a read only when the specification marks it read-only, or when its name says it reads (search, list, query, report…), nothing in it says it changes something, and it answers with a list of records. That is evidence of intent, not proof, and it is recorded as such (`readSafety.basis`). A read on such a basis is sent only while somebody is looking at it — never warmed in the background, never retried — and every send is journalled, so if one ever did change something, when and how often is on record. A GraphQL body is parsed, and a document that contains a mutation or subscription is refused as a read outright. Paging values can travel in the body or in GraphQL's variables.

**Inputs outside the query string.** Header and cookie parameters are read from the specification and sent with each request; a header allowed a single value (a version) is sent with it, and counts as supplied. Lists are written as the specification says, and a deepObject filter becomes the parameters it sends (`filter[account]`). A response's stated total — a declared `totalPath` or an `X-Total-Count` header — is read on the first page and carried as `reportedTotal`.

**OAuth.** An OAuth scheme with a flow the broker can run is imported as a real OAuth connection, not a pasted token. The person gives the app's client ID and secret once; for the sign-in flow they also sign in once on the provider's page (PKCE), the one click nothing can take for them. Tokens are fetched, stored in the vault, renewed a minute before they expire, and renewed again after a refusal: the refused page is read again and the read carries on from there, so a token running out part-way through costs nothing already read. Rotating refresh tokens are each used once. A grant the provider withdraws removes the tokens, and the connection asks to be signed in again rather than reporting a wrong key. The app's secret is only ever sent to a sign-in address on the API's own domain or a known identity provider. A write is never retried.

**Reads through connector code.** An endpoint a connector serves carries a `readSafety` of `model-inferred` when its code may send POST (to start an export, or to search), so it is treated like any other read on an intent basis: never warmed, never retried, journalled each time. Its records say how many there were when the code knows (`total`), and a read the code says it stopped short of the end (`complete: false`), or that falls short of its own total, says so on the tile. A login's session token is kept like OAuth's, in the vault, and reused until it expires.

**The journal** keeps every change to a connected account, and every read that might not have been one, in Dash's database (`dash_journal`). Which reads is decided by the endpoint's `readSafety`, not its method. Keeping an event never costs the read it describes.

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

A read that stopped before the end — a page cap, a repeated page, a later page without its records, unconfirmed pagination, a fan-out that expanded only some records — says so on the tile itself, not only in the inspector, from every request the widget made rather than only the first. The wording names what was left out and never guesses at its size or sign: "What is shown excludes those additional records." Onboarding checks report such a widget as `partial`: it is kept, and never reported as fully checked.

Totals are not drawn where adding up is meaningless: a sum skips values it cannot read as numbers and says how many; percentages are never offered as a total, and a brief summing one is refused; and after a join, a table does not total the columns the join repeated, while an aggregate over a repeated column is warned about.

Preview outcomes are `unchecked`, `invalid`, `checked`, `empty`, and `partial`. Empty and partial results are explicitly described; they are not presented as proof of complete account data. A check is bounded to the sampled response and current configuration, not a guarantee against future upstream schema changes. Receipts expire after ten minutes and never contain credentials or response bodies.

## Changes to connected accounts

Reads and writes are kept apart in the data model. Connection `ops` are reads: GET, or POST only for an endpoint that reads with a body, with its `readSafety` recorded. Write endpoints (create, update, delete and record actions) are kept in the catalog entry's `writes`. They are read from an OpenAPI request body, or inferred from documentation prose and marked `inferred`, which every review of a change through one says. An API's write endpoints are read from its published specification when a connection is added, and once at startup for a connection whose entry never had them read; that is a documentation read and never touches the account. A write endpoint's role for a record type is derived from path shape each time it is needed:
- POST on the collection creates a record.
- PUT on the record replaces it.
- PATCH, or a POST with a body, merges into it.
- DELETE on the record removes it.
- A PUT on a singleton adds or changes it.
- A POST to a named step with no GET is an action.

Because the role is derived each time, replacing a connection's resources cannot drop it.

There is nothing to turn on: every connection can change what its API lets it change, from a row's menu, a record's page, a widget's "New" item or the assistant. The policy is the only thing that refuses (in the open-source build it never does), and an endpoint that turns out wrong can be switched off. Every change is a two-step exchange:
- **Prepare** reads the record fresh from the API, never from the cache. It builds the exact request and returns a review: before and after for each changed value, values a replace cannot read ("not sent"), first-use and prose-derived warnings, and whether it can be undone. It also returns a digest over the request and the values it read.
- **Commit** accepts only that digest, only from the person who prepared it, and only once. It re-reads the record and refuses with a fresh review if anything it depends on moved.

A write is never retried and never follows a redirect. A failure before dispatch is reported as "not sent" and the review can be sent again. A timeout or dropped connection after dispatch is reported as "unknown outcome": the review is spent and the affected cache entries are dropped, because the change may have happened.

After a successful write, only the affected endpoints' cached answers are dropped. These are the record type's list and detail endpoints, and those of the record it lives under. Other in-flight reads are unaffected. Every attempt produces a complete journal event with a reversal hint. The open-source build does not store these events yet.

## Existing installations

Old drafts default missing `inputs`, `coercions`, and `format` to empty objects. New report fingerprints can make older capability reports stale; the UI offers an explicit reread instead of spending requests during migration.

For legacy catalog imports with multipart credentials, a uniquely owned secret is copied to the connection-specific reference. If two accounts shared an old reference, the migration assigns separate empty references and requires credentials to be entered for each account. Original encrypted entries are retained; the migration never guesses ownership or deletes them.

The onboarding benchmark (`bench/PROTOCOL.md`, `pnpm bench`) measures the whole path from documentation to a number against answer keys fixed in advance, on in-process mock providers with no network. Its dev-split runs with scripted choices measure mechanics, not judgment; the held-out split runs only at checkpoints.

Tests use deterministic responses and fake model outputs. Live-provider authentication, rate limits and pagination semantics must still be checked against the provider's actual contract. No live credentials are required to run the regression suite.

On September 9, 2026, a bounded read against the existing Buildium connection returned HTTP 429. No retry was attempted. This exercised rate-limit reporting, but did not verify the provider's current response shape or pagination semantics.
