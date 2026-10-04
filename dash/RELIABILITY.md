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
- where the records really are in the response;
- a GET refused with 405, where the specification reads the same path with a POST it describes as a search or a list (never one it describes as anything else);
- a body refused with 415, sent as the specification says it is taken.

When none of those works, one change is asked of a model (the `repair` task), with the same rule: it is tried like any other candidate and kept only if the read gets further, and a model that finds the API needs something no change can express says so rather than guessing.

**A repair can change the request itself**: its method, its path, the body it sends (JSON, form, a GraphQL document, XML) and how a list is written. The runtime already read all of these, but a repair could not say so, so a request body sent the check to write connector code for an API that needed none. A request change is held to the documentation (`integrate/request-change.ts`):
- the path is one the documentation names, and its ids are inputs it names;
- a POST is never one of the catalog's endpoints that change the account, unless it is a search or an export;
- a POST read carries why it is believed to read: `graphql-query` for a GraphQL query, whose document is checked to only query, and `docs-inferred` otherwise, which keeps it from being warmed or sent twice;
- a GET sends no body.

Connector code is left for what needs it: signing, sign-ins, reads in several steps, exports.

**When no change can express it**, the check asks for code instead (the `connector` task): a sign-in the importer could not represent, an endpoint whose ids come from other requests, or a repair model saying the API needs more than a change. The model reads the documentation and writes a connector — small JavaScript plus the authority it needs — which is loaded in the sandbox, installed on a copy of the connection and read through, exactly as a board will read it. It is kept only when that read returns records. When it does not, the model is shown what happened (the error, the requests the code sent, what it logged — never a credential) and tries again, three times at most. A connector that declares credentials nobody has pasted is kept as a draft, and the check asks for them in the documentation's words ("Paste the Key ID and Secret from your Vaultbank account"); pasting them starts the next check, which tries the code. Once a connection has code, a read that fails is a revision of the code, not a repair around it.

**A second endpoint's code is written beside the first's.** Where the connector already reads other endpoints, or signs, the model is shown the shared code, read-only, and writes only this endpoint's module (`connector.operations`). That module is loaded beside the shared code, for that endpoint's reads only. A rewrite of the shared code itself is kept only when every endpoint it read reads again with it. It is installed whole, with its `version` raised and the code it replaced kept. A check may write code for up to three endpoints, each once. Before this, code written for a second endpoint replaced the code that read the first.

**Every request connector code sends is declared.** The model lists them with the code: method, host, path, purpose and credentials. A POST is kept only at a path the documentation names, and never at one of the catalog's writes, unless it is a sign-in, search or export declared as one. Once proven, a request no template allows is refused before it leaves. What the code sent while proven completes its templates. Code is proven from a cold start, with no session kept from an earlier attempt, so its sign-in is among what it sent. Once, a session kept from a failed attempt hid the sign-in, and the next read refused it as undeclared. A connector from before templates learns them by itself, from what its code sent, once every endpoint it reads has read in a check. See `PLATFORM.md` for the controls and what they do not cover. Without a sandbox or a model, a sign-in the importer could not represent stops the check at once, with the capability named — nothing was sent, and it is never reported as a refusal. Connector code reads; a change through a connection that signs in with one is refused, not sent unsigned. See `PLATFORM.md` for what contains the code, and what does not.

How each endpoint pages is then confirmed by reading its second page (`discovery/probe-pagination.ts`). A rule is installed — with `paginationChecked` — only when the second page returned records the first did not. A proposal's cursor path is checked against the first page and replaced by the field that really holds the cursor, and a short first page is retried at the size the API returned, because an API that caps a request for 100 at 25 would otherwise read as ending after one page. A documented default for a parameter the paging rule sets is the rule's to decide: filling it in beside the rule made every paged request conflict.

What was observed is **evidence**, one rung of a ladder, never a single "complete" flag:

| Level | What it establishes |
|---|---|
| `accepted` | This request was accepted. |
| `advanced` | This continuation returned different records. |
| `traversed` | The configured continuation rule reached an end. |
| `count-reconciled` | The records retrieved match a count stated under the same scope. |
| `metric-reconciled` | A calculation matches an independent expected result. |

**How a read ended is observed, never assumed.** Every read records its `completion`:
- `traversed`, the end its rule defines: a short or empty last page, no next cursor, `has_more` false, a single answer the endpoint gives whole, time windows that add up, or connector code that says `done: "all"`;
- `partial`, with what stopped it: the page cap, a refused later page, a repeated page, a stream's window, fewer records than the API reported, or connector code that says `done: "partial"` or ran out of runs;
- `unknown`: paging nobody has confirmed, or connector code that returned records without saying whether they were all of them.

Rules that follow from it:
- **Only `traversed` lets a tile say a read went to the end.** An `unknown` read says it "may be partial" and why, and is never counted complete by default. Connector code that says nothing is asked once, while it is written, to say how its read ended. It is kept if it still does not say, since the records are real, but it claims nothing.
- **Pages are pages of records.** A sign-in or an export being prepared is a request, counted apart (`requests`), never a page.
- **A count proves something only under the read's own scope.** `scope` is a digest of the address, inputs, filters and range (`resolveReadRequest`). A stated total is reconciled only when it was stated under the same scope (`totalScope`): a total of every order is no evidence about last month's. A connector's own total counts only beside its word that it read to the end.

Each record carries its scope (with the read's digest), the configuration it was observed with (`fingerprintConnection`), when, and the limits it ran within. Only evidence gathered with the connection's current configuration counts as a claim about it (`strongestEvidence`); a changed address or key makes earlier evidence history. Evidence is kept in Dash's own database (`.dash/dash-db`, or Postgres when `DATABASE_URL` is set), bounded per endpoint, and removed with its connection. Keeping it is best-effort: a database that refuses a write is logged, and the check it describes still counts. The server closes both embedded databases on SIGINT and SIGTERM, since a process killed while one is open can leave it damaged.

**A read past a tile's own limits is carried on.** A tile reads at most its endpoint's page ceiling (`maxPages`, 50 unless set), or a connector's ten runs. Before this, a read of 1,150 records at ten a page stopped at 500, every time. Now a read that stops at its own limit says where it stopped (`FetchMeta.continuation`). That is the next request's address, with any key left out, and how far it got; for connector code, its `resume`. The server carries it on from there (`jobs/long-reads.ts`):
- **When and how much.** In the background, at background priority, within the connection's gate. It reads 50 pages a stretch, up to 2,000 pages in all.
- **When something refuses it.**
  - A rate limit is waited out (`notBefore`).
  - A refused key stops the read until the key changes.
  - Anything else is tried again later, five times at most.
- **What is kept, and for how long.** Its records, and where it got to, are kept in the job store, sealed with the vault's key, so a restart carries it on from there. They are deleted when it finishes, when the connection's configuration changes, or when the connection is removed. They are never served as a cache: this is the one exception to "no disk cache".
- **What the tile shows.** It says how far the read has got: "The rest is being read in the background: 500 of 1,150 record(s) so far." It looks again every few seconds, at no cost to the API. It is answered whole when the read reaches its end, from the memory cache, under its own key.
- **Refreshing.** A key read this way is refreshed the same way, by the keeper or by Refresh. A capped read never puts a partial answer back over the whole one.
- **One read only.** A continuation belongs to one read. Handed to another, with another filter or range, it is refused, and that read starts from its first page.

**Every record's related records, through a restart.** The per-record reads past a tile's first twenty-five (`fanout/each.ts`) are kept in the same job store while they run, each record's answer sealed. After a restart they carry on from the records not yet read.
- Forgetting or evicting a read stops the requests it has in flight.
- One record refused or missing (403, 404) is counted, and the read goes on. Only a refused key (401), or every record refused so far (three at least), stops it.
- A rate limit is waited out, and the same record read again.

## What the check's reads teach, and what a request can say

**Fields nobody declared.** An endpoint whose documentation declares no fields — prose documentation, CSV, one JSON object per line, or code-served endpoints — gets its fields from what the check read. Those are names and kinds only (`fieldsFrom: "observed"`), written to the catalog entry, and the record types that can then be described are described with nothing to press. An endpoint a read showed answering with many records becomes a collection.

**Every endpoint the documentation names.**
- Prose documentation is scanned whole for the reads it names: `GET /…`, or an address under the API's own base. The model is shown that list, and a named read it leaves out is still imported, up to 200 endpoints.
- A named record's address (`/things/{id}`) also stands for its collection (`/things`) where the page names none. Each is read before anything is built on it.
- A specification split across files has its references followed on its own site, up to 40 files, and is put back together. A reference to another organisation's site is not followed, and is named.
- A specification that names no server is served from the host that serves it, by the specification's own rule — not asked for as if it were a guess.

**An input another list supplies.** Some endpoints need an input no board gives: an organisation's projects need its id, and a workspace's tasks need the workspace. Such endpoints were left out of checks and offered to no board, so their records could never be counted. Now:
- **They are kept.** A GraphQL list with a required argument is imported with that argument as its input. One list per kind of record names a record type; a search over orders is another way to read orders.
- **A source is found for each input.** It is a relation the documentation declared, or a list named for the input (`workspace_id` and the workspaces) that can itself be read with nothing given (`integrate/inputs.ts`).
- **The check reads the source list first and settles the input.**
  - One record: its value, always.
  - The request names one ("the Marketing workspace"): that one.
  - Otherwise every one of them (`valueFrom.each`). The endpoint is read once per record and the answers are put together, each record tagged with what it was read under.
  - The value lives on the parameter (`ParamDef.valueFrom`, with its `default` where it is one value). Nothing is set from a name alone: the list must answer, and its records must hold the field.
- **A board reads it the same way.** `DependentAdapter`, outermost in the server's read chain, puts the value in place, a path's id included, or reads once per record. It reads at most 50 records' worth, and says so when there were more. The whole is read to its end only when the source and every part were.
- **What a board must still supply** is `boardInputs`: the missing inputs that no other list's records supply.

**Records the import never took.** A brief that finds no record type for a request, or a check after which none could be described, no longer ends the setup. The documentation is read again for the endpoints it names on the API's own address (`endpointsNamed`), and the ones whose path shares a word with the request are added and checked like any other (`integrate/seek.ts`). Only those that answer with records are kept. They are described, and the brief is written once more. This runs by itself, from the brief route and the benchmark alike. Nothing is added from a model's guess.

**Documentation drawn by its own scripts.** A page that is an empty shell until its scripts run is drawn by Playwright's own Chromium, headless, in a fresh context each time (`discovery/render/`).
- **Its requests.** Every request the page makes is answered through the server's own document reader (`fetchPublicDocument`): public addresses only, the SSRF guard, its size limits. Only reads go. Images, fonts, media, downloads, pop-ups and WebSockets never do. The page may move only within its own site, a few times. A render is bounded at 80 requests, 20 MB and 15 seconds.
- **What is read from it.** A specification the page fetched to draw itself is imported exactly, before anything else. Redoc, Swagger UI and their kind fetch the API's own document and link to nothing. Then a specification the drawn page holds or links to. Otherwise its prose is read like any other page.
- **The one question.** The open-source build does not ship Chromium. The first time such a page is met, discovery stops and asks: "This documentation needs a one-time download of about 150 MB to read. Download now?"
  - Yes: the download goes into `.dash/tooling`, with progress shown, and discovery runs again by itself. The answer is kept, so it is never asked again.
  - No: discovery says the page cannot be read without it, and suggests linking an OpenAPI spec instead.
  - Nothing is searched past the page while the question is open.
  - A copy Playwright already keeps on the machine, for this version, is used as it is.
- **Hosted** (`DASH_RENDERER=hosted`): Chromium is in the server's image, and nobody is asked.
- **Where it cannot run**, it says so with the one command that fixes it: `npx playwright install chromium` for a download that did not finish, or `npx playwright install-deps chromium` for Linux without Chromium's system libraries.

**Reading every collection once.**
- The check settles a handful of endpoints fully: repairs, paging, filters. It reads every one of them before reading any to its end, so reconciling one collection's count cannot spend the budget the next collection needed.
- It also reads one first page of up to 40 other collections whose documentation declared no fields, on a budget of its own, so every one can be described.
- **Which endpoints a check reads is a queue.** Each endpoint waiting for a check is kept in the job store (`jobs/check-queue.ts`), so a restart forgets none of them.
  - **Settled once, and only by evidence.** An endpoint is settled once a check has recorded evidence for it, never when its check starts. A check that fails, stops or never reaches an endpoint leaves it unsettled.
  - **Order.** A check takes the eight most pressing: a change seen on an endpoint first, then endpoints boards newly read, then those no check has settled, then a re-check somebody asked for.
  - **None left out.** A check runs again by itself while endpoints are still due, up to six back to back, so the ninth endpoint a board reads is reached.
  - **When a check fails.** An endpoint whose check failed waits before it is due again. A rate limit waits 15 minutes; any other failure waits longer each time. One that needs an input or a key waits until somebody supplies it.
  - **What makes it due again.** An endpoint is keyed by the connection narrowed to that endpoint. A new key, a new address or a change to its own request makes it due again. A check's changes to other endpoints do not.
  - `GET /api/connections/:id/evidence` lists what is waiting, and why one is blocked.
- A key refused one endpoint (403) moves the check on to the next rather than ending it. Only when every endpoint refuses is the connection blocked.
- Where a specification declares no sign-in at all, the check tries one read without a key before anything else. It records that the API needs no sign-in only if records come back. A declared sign-in that no connection can send is left to connector code, and nothing is sent before its values are pasted.
- Paging is also tried the way the answer's own "next" address does it (`next_page_url`, `next`, `info.next`): its page parameter, or an offset equal to the records read. It is confirmed like any other rule.
- A total an answer states beside its records (`total`, `meta.total`, `count`), where nothing declared one, is used only to say a read fell short, never to claim it complete.

**What a search answer leaves out** (seen with the trackwell mock API). An issue search read 50 of 264 issues and showed them as the whole, though its own answer said there were more. Four things were missing; each is generic:
- **An answer that says there is more is never complete.** With no paging rule, a list whose answer says `isLast: false`, `hasMore: true`, or gives a next token, cursor or address is partial (`said-more`), and its tile says the rest was not read. A single record's own fields (`next`, `last`) are not taken for this.
- **A token handed back under a parameter's own name is the cursor.** `nextPageToken` out, `nextPageToken` in: the check pairs them whatever they are called, and reads to the end with them.
- **Records that come back as ids are asked for their fields.** Where every record holds only what identifies it, and the documentation names a parameter that selects the fields and the value that selects all of them ("`*all` returns every field"), the check sends that value. It keeps it only when the records come back with their fields. Nothing is guessed: a parameter whose documentation names no such value is left alone.
- **What an open object holds is described.** A declared field the specification leaves open (an object with `additionalProperties`) gets the fields the records were read to hold inside it, beside the declaration. The values a request can name are read from every record the check read to the end, not only the first page.
- **The fields a request names are offered first.** The brief's list of fields to narrow by puts first those whose values the request names ("bugs" is the type, "Platform" the project's name). It never spends a place on an object, and a field whose values repeat is offered even if it is called a name.
- **A brief is sent back once over what it left out.** A value written on a field that does not show it, where another field holds it word for word, is sent back. So is a word of the request that is a value of a field nothing narrows by. A second answer is taken as meant.
- **A narrowing that matched nothing says so.** Where records went in and a narrowing by a named value let none through, the tile says none of them matched: a count of none is never shown as if none were the answer.

**Ways of paging nothing declared** (2026-09-30). Each is tried by the check and kept only when its second page returns records the first did not have.
- **The next page's address, followed as given** (`next-url`): `links.next`, HAL's `_links.next.href`, `@odata.nextLink`. For a token the address carries that no parameter declares and no page number could stand in for. Its path and query are the API's; the origin stays the connection's, since an API behind a proxy names its inner host. A key that travels in the query string is put back where the address left it out. An empty page ends the read, whatever address it still offers.
- **Pages numbered from 0.** A rule's first page must be the first page: its first record is held against the plain read's. Where `page=1` answers with the second page, the rule is tried from 0, and is never kept as it was. Left unchecked, reading on from the second page advanced, and the first page's records were missing from every number.
- **The last record's id as the cursor**, where a cursor parameter is declared (`starting_after`, `after`) and the answer holds no cursor.
- **Parameters by their usual names** (`page`, `offset` with `limit`, `page[number]`), only when the answer itself says there is more: a count above what came back, or a flag (`has_more`). A name the API ignores costs two requests and installs nothing.
- **Larger pages where the API gives them.** An offset or a next address that carries a page size under a hundred is tried at a hundred first; the size is then sent with the first request, and every address after carries it on. Kept only when the first page really came back larger. PokéAPI's 1,351 records followed 20 at a time took 68 pages, past the most a read takes, and 351 were left out.
- **An answer read as one record is never paged.** Each later answer would count as a record of its own: eight pages of thirty vehicles were once confirmed as eight records.
- **A wrapper inside the answer** (`_embedded.vehicles`, `d.results`, `data.items`) is where the records are, when the key between names a wrapper and it holds one list. A record's own nested list is left alone.

**The values an account uses.** Where a field's records hold a small set of short words, each used repeatedly — `debit`/`credit`, `USD`/`EUR` — the check keeps that set (`integrate/values.ts`). A field is kept only if every value it holds passes. Ids, dates, amounts, emails, addresses and anything unique per record are never kept.
- These are the account's data. They go to the `SeenValueStore`, per connection, and are forgotten with it. They are never written to the catalog, which is shared.
- A request's brief sees them:
  - as "in the records" only where the read's count matched the total the API reported, so it saw every record;
  - otherwise as "in some records", since a first page shows the values near the start of a list, not all of them.
  The API's declared set, when it has one, stays first, because it is complete.
- A value the brief writes that a complete set does not list (declared, or seen in every record) is sent back once with the listed values.
  - For a declared set, a second answer is taken as meant, since a specification's list can be out of date.
  - For a set seen in every record, a second answer that still names a value no record holds is said, not built: it could only count nothing.
  - A value missing from "some records" is never sent back.
  - A listed value in other letters is written in the listed spelling.
- The roster also names each record type's other plain fields ("also"), without values, so a request about a field with too many values to list can still reach it. It never names what identifies or describes a record: a field whose every value was different on the check's read, or one named like a title, description or SKU. A request is never narrowed to a product's title.
- The set is as fresh as the last check.

**The API's own filters.** An endpoint's documented query parameters are imported, from prose as from a specification, but nothing sends one until a read confirms what it filters.
- The check sends a parameter with a value the first page held. It keeps the parameter (`ParamDef.filters`) only if every record comes back holding that value, while the unnarrowed page held others.
- A number or chart narrowed to one value then asks the API for those records alone, and still narrows locally. So the API's filter can only ever read less, never different records.
- A list's narrowing stays on its filter strip, which a reader can widen.

**The API's own count.** An endpoint under a list that says how many it holds (`/breweries/meta`, `/orders/count`) is tried by the check (`integrate/count.ts`), and kept on the record type (`ResourceSpec.count`) only when its number is what a complete read of the list found, or what the list itself stated. A count that disagrees is never kept. Each confirmed filter is checked the same way: the count narrowed by it must match the list read to its end, narrowed the same way.
- "How many" is then read from it, in one request, however many records there are, where a list read page by page stops at its ceiling.
- Only for what the count was checked under: a range, a flag, two values or a filter it was not checked with read the records instead.
- The tile claims no records: its one row is a number.

**Reading to the end.**
- A page shorter than the first ends a page-numbered read that declares no page size, unless the API's count says there is more.
- A 404 after the first page is the end of the pages, unless a stated count says otherwise.
- A short rate limit part-way through ("try again in 10s", at most 30 s, three times) is waited out, and the same page read again. This applies only to reads safe to send twice: a GET or a GraphQL query.
- Once a check has confirmed how an endpoint pages, the endpoint may read as many pages as the API's stated count takes. Where the API states no count, it may read up to the ceiling of 50. A number needs every record, and boards read in the background, paced by the connection's gate.

**What a tile says it read.** Beside the row count, the footer states the highest level the read itself supports:
- "all N read" when the API's own count matches;
- "every page read" when the pages ran out;
- "read in one request" otherwise.

A read cut short says what it left out instead.

**A widget's own time.** A request that names a time — "since 1 June", "in July" — is read over that window, not only narrowed within the board's (`WidgetSpec.timeWindow`, `paramsForWidget`).
- The tile says so beside its count ("since 2026-06-01"), so the board's range is not mistaken for it.
- Connector code that reads the window (`ctx.range`, ISO strings) is cached under the window. Its contract says to read every record in it, window by window where the API allows only shorter ones.
- Read within the board's thirty days, a total asked for since June once counted one month of it, silently.

**Money in more than one currency.** A total of a sum over records that carry a currency code (`currency`, `currency_code`, `ccy`), where the request did not narrow to one currency, also counts the codes it added. When there is more than one, the tile says the total adds amounts in more than one currency as if they were one. This comes from a `caveat` pipeline step: a condition the compiler declares, checked on the rows, and said when any row meets it.

**What a number was.** Most APIs cannot be asked what a count was last month, so the host keeps it (`SnapshotStore`, `history/record.ts`).
- Each time the keeper reads an endpoint for a board, every number tile that read feeds is worked out as the board would work it out, and its value kept for that day. The last value of a day stands.
- Only a number read by a single request is kept. A tile that reads two endpoints, or narrows the request its own way, is not kept from another tile's read.
- The tile draws the line once there are two days, and says "History starts {date}". It never claims a history from before the board was looked after.
- Values are kept for 400 days (`historyDays`), and forgotten with the board.

**Every record's related records.** An endpoint that answers for one record at a time (a vendor's bills, a lease's charges) is read once per record.
- A tile reads the first 25 itself, so it can draw, and says the rest are missing.
- The server then reads every record, up to 500 (`FAN_OUT_WHOLE_MAX`), behind every board's own reads and paced by the connection's gate (`/api/query/each`, `EachReads`). The tile says how far it has got. When it is done, its answer replaces the first 25, and so do its notes.
- One held already, such as the tile's own first 25, is not asked again. One not held is read without being stored, so two hundred of them cannot push a board's reads out of the cache.
- A refusal of the account (401/403), or a wait longer than a read waits (429), stops the whole read, and the tile says why. A record whose own read failed is counted and said. What each record's own read left out (a page cap, paging not yet confirmed) is said once, since the whole answer is no more complete than its parts.
- Records past 500 are said, never guessed at.

**What a number means.** Every number and chart a brief builds carries its metric (`WidgetSpec.metric`, `packages/spec/src/metric.ts`). The tile shows it where nobody wrote a description: "Sum of Total over Invoices whose Status is paid, dated by Issue date, in each record's own currency."
- It states what is counted or added, over which records, each narrowing, the date that decides the window, and where the currency comes from (a currency field on the records, or the one code the request narrowed to). It never assumes a currency from a symbol. It also says when the API made the count.
- A word that reads several ways ("revenue": billed or collected, before or after refunds) is built as the likelier reading, and the tile says which (`reading`). The other reading is offered beside it, as one click. Another measure or narrowing of the same records counts as another reading.
- Records are counted as they arrive. Two rows are never counted as one without a declared identity and grain, and nothing declares one yet.
- **Parts that should add up to a total** (a subtotal with tax, shipping or discount beside a field named as the total) are checked on every record read. Because the rule is read from names, a mismatch is a question on the tile ("On 3 of the 400 Invoices read, Subtotal + Tax − Discount is not Total. The total may include something the parts do not name."), never an error, and never corrected.

**Nothing asked for is dropped in silence.**
- A brief can narrow by whether a field holds anything (`empty`): "leave out cancelled orders" is a cancelled date that holds nothing. It is applied for every kind of widget and said, like a range.
- A narrowing the request states that nothing here can express goes in the brief's `unmet`, in the request's words. The tile says it on every read ("This does not leave out what was asked, because nothing here can express it: …"), and so does the metric. Before this, "leave out cancelled orders" was dropped while the model's reason said it had been done, and a total was 5.7% high.
- A number the documentation says is in the smallest currency unit ("12500 is $125.00") is recorded as that claim (`format: "minor_units"`). It is never rescaled on the claim alone. The brief sees it, and writes an amount a request names in that unit ("more than $250" is above 25000). A total over such a field says it is in that unit.
- **A number whose request named no time counts every record** (2026-09-30). On an endpoint that reads the board's time range, a number or a breakdown by category reads all time (`timeWindow: { all: true }`): its date bounds resolve to nothing and are left out of the request, and the tile says "all time". Lists and charts over time keep the board's range, and a chart's sentence says "within the board's time range". A count of 30 days of 1,840 payments once said nothing.
- Such an endpoint may read up to the platform's ceiling of pages. The check sizes an endpoint's pages from what it read, which for these is only the board's range.
- A later page the API refuses ("page × limit must be at most 1000") ends the read with what was read, and says so. It no longer fails the whole read. A refusal of the first page, a sign-in, a permission or a rate limit still does.
- **A list the API will not read past a point is read in narrower time windows**, where the endpoint takes both ends of a time range and says how many records a range holds (`packages/adapters/src/rest.ts`). The range is halved until each part holds no more than the API listed before it refused, and each part is read to its end. One request per part says how many it holds, so no part is asked past the limit. A record stamped exactly on a boundary is counted once. The result is called complete only when the records read are as many as the API said the whole range holds; otherwise the first read stands, with what it said. 1,840 payments behind a 1,000-result limit are read whole in 46 requests.
- **Both ends of a time range are sent where the endpoint declares both** (`created[gte]` with `created[lt]`), and a range is sent only to endpoints that take it. One range parameter found anywhere in a specification used to be sent to every list. An end that is a date, not a moment, is not sent: an API that excludes its last day would drop today.
- **The documentation's words about a field reach the brief.** Beside each field a request can narrow or total by, the roster carries the specification's own sentence about it ("True when refunded in full"), kept where the description pass wrote none of its own. Two fields can answer to the same word, and only that sentence tells them apart: "refunded, in full or in part" once counted only full refunds, silently.
- Connector code whose read returns no records is revised, whenever that read happens. Code written before the key was pasted gave up waiting on an export, answered with nothing, and was taken for an empty account.

**None of these.** When no record type is what a request is about, the brief says so and nothing is built. The nearest record type is never counted instead: with no Pokémon record type, "how many Pokémon" once counted evolution chains.

**A field that holds years** (`year`, `fiscal_year`) is compared in years when a request names a time on it: from 1 January 2026 up to 1 January 2027 is 2026. It is never read as a moment, where 2026 was 2026 seconds after 1970 and "closed this year" counted nothing, silently.

**Time.** A "changed since" parameter (`modifiedAfter`, `updated_since`) is not installed as the dashboard's time window, since it selects records changed since a time, not records that happened in it. A request can say a range — `above`/`below` for numbers, `from`/`to` (exclusive) for times — and a time range on a field that cannot hold a time is refused and said.

## Reads that are not a plain GET, and signing in

**Reads sent with POST.** A search or report that needs a request body is imported as a read only when the specification marks it read-only, or when its name says it reads (search, list, query, report…), nothing in it says it changes something, and it answers with a list of records. That is evidence of intent, not proof, and it is recorded as such (`readSafety.basis`). A read on such a basis is sent only while somebody is looking at it — never warmed in the background, never retried — and every send is journalled, so if one ever did change something, when and how often is on record. A GraphQL body is parsed, and a document that contains a mutation or subscription is refused as a read outright. Paging values can travel in the body or in GraphQL's variables.

**Inputs outside the query string.** Header and cookie parameters are read from the specification and sent with each request; a header allowed a single value (a version) is sent with it, and counts as supplied. Lists are written as the specification says, and a deepObject filter becomes the parameters it sends (`filter[account]`). A response's stated total — a declared `totalPath` or an `X-Total-Count` header — is read on the first page and carried as `reportedTotal`.

**OAuth.** An OAuth scheme with a flow the broker can run is imported as a real OAuth connection, not a pasted token. The person gives the app's client ID and secret once; for the sign-in flow they also sign in once on the provider's page (PKCE), the one click nothing can take for them. Tokens are fetched, stored in the vault, renewed a minute before they expire, and renewed again after a refusal: the refused page is read again and the read carries on from there, so a token running out part-way through costs nothing already read. Rotating refresh tokens are each used once. A grant the provider withdraws removes the tokens, and the connection asks to be signed in again rather than reporting a wrong key. The app's secret is only ever sent to a sign-in address on the API's own domain or a known identity provider. A write is never retried.

**Reads through connector code.** An endpoint a connector serves carries a `readSafety` of `model-inferred` when its code may send POST (to start an export, or to search), so it is treated like any other read on an intent basis: never warmed, never retried, journalled each time. Its records say how many there were when the code knows (`total`), and a read the code says it stopped short of the end (`done: "partial"`), or that falls short of its own total, says so on the tile. One the code never says it finished (`done: "all"`) says it may be partial. A login's session token is kept like OAuth's, in the vault, and reused until it expires.

**The same request, whichever way an endpoint is read.** REST and connector code resolve a read's request with one function (`resolveReadRequest` in `packages/adapters/src/request.ts`): the endpoint's path, query, headers, cookies and body, with every input in place. Those inputs are the widget's own values, the board's filters and range, and each parameter's documented default. Connector code is handed both the resolved request (`ctx.request`) and every input by name (`ctx.inputs`). Inputs nobody supplied are listed for the code to find, not refused. Before this, a connector's request was rebuilt from the endpoint's defaults alone, so a widget narrowed by a value read every record. The check asks a filter the way a widget will (as the widget's own value), so a filter is confirmed on a connector-served endpoint only when its code honours it. A read sent with POST and no body is sent with POST; it was once sent as a GET.

**The journal** keeps every change to a connected account, and every read that might not have been one, in Dash's database (`dash_journal`). Which reads is decided by the endpoint's `readSafety`, not its method. Keeping an event never costs the read it describes.

**GraphQL, from its schema.** A GraphQL API's reads are generated from its schema, not written per API by a model (`discovery/graphql.ts`). The schema is SDL the documentation publishes, in the page or in a schema file it links to on the same site.
- One read per list the query type offers: a Relay connection (`nodes`, or `edges { node }`, with `pageInfo`), a plain list, or a wrapper around one (`results` beside `info { count }`).
- Each read selects the record's own plain fields, and the nested objects it carries up to three levels (`totalPriceSet.shopMoney.amount`). It never selects a deprecated field, a nested list or connection, or a cycle.
- Paging is what the schema declares: `after` from `pageInfo.endCursor`, `page`, or `offset` with a limit. A page is sized so its objects stay under a cost ceiling the documentation may not state.
- A list that needs an input nobody supplies (an id, a search term) is left out, and the import says so.
- The prose read's own guess at the endpoint is replaced; its address and sign-in are kept. An address that is the endpoint itself is split, so a read is not sent to `graphql.json/`.
- Every generated query is checked as a read by protocol (`graphql-query`): it can only query.
- Where the documentation publishes no schema, the check asks the endpoint for one (introspection) before reading it as REST, with the key. The endpoint is replaced by the reads written from the answer, and the catalog entry learns them. An API that limits query depth is asked a type at a time: Rick and Morty refuses anything deeper than four levels, and set itself up that way (3 lists, 126 of 126 locations and 51 of 51 episodes read).
- An answer that is only GraphQL `errors`, with no `data`, is a failed read, whatever its status. Read as one record, it once let a check say "ready" about an endpoint nothing had read.

**Answers that are not JSON.** An endpoint's answer is read as what its content type says it is (`packages/adapters/src/parse/`): JSON, XML, a table of rows (CSV, TSV), or one record a line. No code is needed for any of them.
- The format is never guessed from an answer's first characters, with one exception: a body that is not JSON and is plainly an XML document, not a web page, is read as XML. A web page is still the error it always was.
- **XML** is read by a small parser of our own. It processes no DTD at all, so an entity a document declares is left as written and nothing external is ever fetched. Elements and attributes become fields, a name that repeats becomes a list, plain numbers become numbers (long ids and leading zeros stay text), namespaces are dropped, and a SOAP envelope is opened to what its Body holds. A SOAP Fault is the service's refusal, said in its own words.
- An XML collection's records are found by reading it, like any undeclared shape; a count written as an attribute of the top element (`<notices total="173">`) is the API's stated total.
- Connector code gets the same reader (`XML.parse`, or `as: "xml"`), so it no longer picks XML apart with regular expressions. A request that must itself be XML (a SOAP call) is still connector code's to send.
- **An answer that is only an error, whatever its status, is a failed read.** GraphQL's `errors` with no `data`; one top element named for an error (`ErrorResponse`, `Fault`); an answer that says of itself that it failed and holds no records. A record that failed (a payment whose status is "failed") is still a record. Read as a record, an XML API's error answer was described as a record type and offered.

**A stream of events** (`text/event-stream`) is read for a window: up to a hundred events or five seconds by default (`op.stream`), then the connection is closed. Each event is a record — its data's fields, with its name and id beside them — and only whole events are kept. The tile always says it shows one window of a stream, not everything the stream has carried. Checked by hand against Wikimedia's public stream (19 events in under a second). WebSocket streams are not read.

**A SOAP service** is set up from its WSDL (`discovery/wsdl.ts`; WSDL 1.1, document/literal). Each operation named for reading becomes an endpoint: a POST of the envelope the WSDL describes (`body.type: "xml"`), its SOAPAction header, and its simple inputs as parameters. An input nobody gave is left out of the envelope rather than sent empty, and every value is escaped. Where the answer's schema repeats one element, that is where the records are. The rule for which operations read is the one MCP tools follow, and the reads have the same standing (`docs-inferred`). Checked by hand against a public service (CountryInfoService: nine list operations set up, continents read). A sign-in inside the envelope, and RPC-style services, are for connector code.

**An MCP server as a connection** (`apps/server/src/mcp/`). Pasting an MCP server's address sets it up like any other: the address is asked whether it is one, its tools are listed, and the ones that read become endpoints. A server that refuses without a token is asked for one, and its tools are listed once the token is in.
- A tool is a call, and nothing in the protocol says a call reads. A tool becomes an endpoint on the server's own word (`readOnlyHint`), or, where the server says nothing either way, on its name: it begins with a word for reading and holds no word for a change. Which of the two is recorded (`readSafety`), and either way the read is never warmed in the background, never retried, and journalled each time it is sent.
- A tool the server marks as changing or destroying things, or whose name does not say it reads, is never called for a board. The import names the ones left out.
- A tool's arguments are the endpoint's parameters, and a tool that declares what it answers with (`outputSchema`) says where its records are and what they hold. One that does not is read once and observed, like any undeclared shape.
- The client is our own, over the same guarded transport and credential broker as every other read, so the SSRF guard and the host pin hold. Checked by hand against a public server (DeepWiki: three tools, two read by name, one left out).
- Not yet: signing in through OAuth's dynamic client registration (a token is pasted), and servers started as a local process.

**A connector read too long for one run** says where it got to (`resume`) and is carried on in another run: a fresh sandbox and a fresh allowance each time, ten runs at most. The allowance still bounds each run; it no longer cuts a read short. Code that returns the same place twice, or needs more runs than that, is stopped and the tile says so.

**An endpoint with nothing to page** is confirmed as one page: it takes none of the parameters the documentation pages with, its answer names no total above what came back, no next page and no "more", and it is not a page-sized answer. Before, an export of 96 rows said "only the first page was read" for ever, because another endpoint of the same API paged.

**A value a read must send that nothing supplies** (a search expression, a start time, a restriction the API insists on) is written from the documentation, by the check's model repair, and chosen so the read returns every record: a search that matches everything, the earliest time allowed. It goes where the endpoint takes it: the endpoint's query, a body parameter's default, or the body it already sends. A required input no longer stops the check unless it is an id of one record. A proposed value that is a template, or names the key's parameter, a path id or a paging parameter, is refused. The model is shown the whole request: method, parameters (which are required), and body.

**Signing in, beyond one pasted key.** Each of these is read from the documentation, asked for in the documentation's own words, and proven by a read before the connection is called ready.
- **Keys wherever the API wants them.** A key in a cookie, or several keys that go in different places at once (a header, the address, a cookie), are one sign-in whose parts each say where they go. A key in a cookie is sent beside an endpoint's own cookies, not in place of them.
- **OpenID Connect.** A specification that names only a discovery address is followed to it, and the sign-in and token addresses it publishes become an ordinary OAuth connection (PKCE). The discovery document must be on the API's own site or a known identity provider.
- **HTTP Digest.** A username and password that are never sent: the server's challenge is answered (MD5 or SHA-256, `qop=auth`), and later pages reuse the challenge, counted on. A server whose challenge expires part-way through a read is answered afresh on that page. A wrong password is refused after two answers, not asked forever.
- **Client certificates (mutual TLS).** The certificate and key are pasted once, kept in the vault, and presented only to the API's own host and only over https. A certificate pasted as one line is put back into lines. They sit beside whatever key the API also asks for.
- **AWS Signature Version 4.** A built-in signer (`packages/adapters/src/sigv4.ts`, checked against AWS's published test signatures), so no model writes signing code and the secret access key never leaves the server. Every request is signed as it is sent: its address, its body, the time. The region and service come from the address where it is an AWS one, so an account in another region is signed for its own. For an API at its own domain they come from the documentation, or from AWS's refusal when it names them. A region nobody stated is never tried. An API Gateway key (`x-api-key`) is sent beside the signature where the specification asks for both.
- Any other signing scheme, and a login that issues a session token, are still connector code's to do.

## An API that changes after it was checked

Every fresh answer from an endpoint a board reads is held against the shape that endpoint was accepted in (`apps/server/src/drift/`). The shape is names and kinds only, never a value, kept per connection and endpoint (`ShapeStore`). The first fresh answer is the shape kept.

- **What counts as a change.** A field every record held that no record holds now; a field that holds another kind of thing (text where there was a number); records no longer where the endpoint reads them, while a list of records sits elsewhere in the answer. An optional field missing from a page, a new field, an empty account and a page of one or two records are not changes.
- **What happens.** Every tile that reads the endpoint says what changed, in the API's own field names, and that what it shows may be wrong until it is rebuilt. Where exactly one new field of the same kind shares a word with a removed one, the note says it may be what the old one became. The endpoint that changed is checked again by itself, before anything else waiting for a check, once per change.
- **What never happens.** Nothing is repaired into a saved widget. A rename is suggested in words, not applied.
- **When it stops.** When the answers are back in shape, or when nothing saved reads what changed: a change no saved widget names is taken as the new shape, with no note at all.
- `GET /api/connections/:id/drift` lists what is open on a connection.

## APIs on a private network

An API on the office network or a VPN is reached only when two people say so (`EgressPolicy` in `apps/server/src/safe-fetch.ts`): the server's operator lists the address (`DASH_PRIVATE_EGRESS`: hostnames, `*.suffix`, CIDR ranges), and the connection says it is on a private network — a choice shown on its address step and in the connections list. Without both, a private address is refused as it always was, and the refusal says which is missing. Link-local addresses, where cloud metadata lives, are never reached. The address checked is the address connected to: a private one is pinned for the request, so a name that resolves somewhere else a moment later cannot be used to slip past. The connection's own host pin still holds.

## Sharing what was worked out

A catalog entry holds only facts about an API, never about an account, so one person's setup can start the next person's (`apps/server/src/registry/`).
- **Versions.** An entry's `version` moves each time what it says about the API changes. Recording a check on it is not such a change.
- **Evidence travels with the entry, as rungs only.** After a check that read something, the entry keeps when it was checked, which version, the outcome, and the rung each endpoint reached (`evidence`); `verifiedAt` when it was ready. No count and no value from the account goes with it.
- **Pulling a registry** (`DASH_CATALOG_REGISTRY`): an index and one file per entry, pulled at start and once a day into a tier between what ships with the code and what this instance worked out itself; a local entry always wins. An entry held at the listed version is not fetched again. Each entry is validated like a local one or skipped and said, and a file must sit under the registry's own address.
- **What is never taken from a registry.** Connector code: an entry that needed code arrives without it, its endpoints as documented, and this instance's check writes and proves its own. Nor is a pulled entry `verified` here: that word means a request on this instance returned rows. What the registry checked is kept as its word.
- **Serving one** (`serveRegistry`): verified entries only, without their code.

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
