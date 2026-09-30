# Plug-in points

Dash runs on a laptop out of the box, and is built to run as a hosted service or on somebody else's infrastructure without being forked. Every piece of infrastructure it depends on is a plug-in point: an interface, with a local implementation the open-source build uses. A hosted build or a fork supplies its own through `buildServer(options)` (`apps/server/src/server.ts`); nothing else has to change.

This file lists the plug-in points that exist today. It grows as each one is added.

| Plug-in point | Interface | Local default | Supplied through |
|---|---|---|---|
| Evidence about each endpoint | `EvidenceStore` (`apps/server/src/evidence/store.ts`) | `DbEvidenceStore` over Dash's database; `MemoryEvidenceStore` in tests | `BuildServerOptions.evidence` |
| Dash's own relational state | `DashDb` (`apps/server/src/platform/db.ts`) | Embedded Postgres (PGlite) under `.dash/dash-db` | `DATABASE_URL`, or `openDashDb({ databaseUrl })` |
| Chat storage | `ChatDb` (`apps/server/src/chat/db.ts`) | PGlite under `.dash/chat-db` | `DATABASE_URL`, or `BuildServerOptions.chat` |
| Response cache | `CacheStore` (`apps/server/src/cache/store.ts`) | In memory, bounded; deliberately never on disk | `BuildServerOptions.cache` |
| Everything below, together | `DashPlatform` (`apps/server/src/platform/local.ts`) | `createLocalPlatform`: files under `DASH_ROOT`, the embedded databases, the local vault | A hosted build writes its own `create…Platform` and hands it to `buildServer` |
| Boards, connections, capability reports | `SpecRepository` (`apps/server/src/store.ts`) | `SpecStore`: JSON files under `DASH_ROOT` | `BuildServerOptions.store` |
| Credentials | `SecretRepository` (`apps/server/src/vault.ts`), encrypting through `SecretVault` | `KeyStore` over `LocalAesVault` | `BuildServerOptions.keys` — a hosted build backs it with its key management service |
| Who is asking | `IdentityResolver` (`apps/server/src/identity/`) | `localOwner` — one person, on this machine; or `oidcJwtResolver` when `DASH_OIDC_ISSUER` and `DASH_OIDC_AUDIENCE` are set | `BuildServerOptions.identity` |
| What they may do | `Policy` | `ownerPolicy`; `rolePolicy` (roles, then scoped grants) with an identity provider | `BuildServerOptions.policy` |
| Workspaces, members, invitations | `MembershipStore` (`apps/server/src/identity/members.ts`) | `DbMembershipStore` over Dash's database when signing in; none otherwise | read by `rolePolicy` and `oidcJwtResolver`; invitations keep a hash of their token (`identity/invites.ts`) |
| One keeper per connection across servers | `LeaseLock` (`apps/server/src/platform/lease.ts`) | None: one server does all of it; `DbLeaseLock` when `DATABASE_URL` names a shared database | `BuildServerOptions.leases` |
| Record of changes to accounts, and of reads that might not be reads | `WriteJournal` (`apps/server/src/writes/journal.ts`) | `DbWriteJournal` over Dash's database; `nullJournal` in tests | `BuildServerOptions.journal` |
| When OAuth tokens expire | `CredentialMetaStore` (`apps/server/src/auth/credential-meta.ts`) | `DbCredentialMetaStore`; memory in tests | `BuildServerOptions.credentialMeta` |
| What a number tile showed, day by day | `SnapshotStore` (`apps/server/src/history/store.ts`) | `DbSnapshotStore` over Dash's database, per workspace, board and tile; memory in tests | `BuildServerOptions.snapshots`, `historyDays` (400) — forgotten with the board |
| The values each account's records hold, where a field holds a small set | `SeenValueStore` (`apps/server/src/values/store.ts`) | `DbSeenValueStore` over Dash's database, per workspace and connection; memory in tests | `BuildServerOptions.seenValues` — account data: never written to the catalog, forgotten with the connection |
| The shape each endpoint was accepted in, and any change seen since | `ShapeStore` (`apps/server/src/drift/store.ts`) | `DbShapeStore` over Dash's database, per workspace, connection and endpoint; memory in tests | `BuildServerOptions.shapes` — names and kinds only, never a value; forgotten with the connection |
| Catalog entries somebody else worked out | `CatalogRegistry` (`apps/server/src/registry/registry.ts`) | None; with `DASH_CATALOG_REGISTRY` set, `httpRegistry` pulled at start and daily into a tier beneath this instance's own entries | `DASH_CATALOG_REGISTRY` — a hosted build serves one with `BuildServerOptions.serveRegistry`. Code is never taken from a registry, and nothing pulled counts as verified here |
| Where an OAuth app's client id and secret come from | `OAuthAppRegistry` (`apps/server/src/auth/broker.ts`) | `vaultApps`: what the person pasted | `BuildServerOptions.oauthApps` — a hosted build that registered its own apps supplies them, and nobody registers anything |
| Where requests may go | `EgressPolicy` (`apps/server/src/safe-fetch.ts`) | `publicOnlyEgress`; `allowlistEgress` from `DASH_PRIVATE_EGRESS` (hosts, `*.suffix`, CIDR ranges) | `configureEgress` at start. A private address needs the operator's allowance and the connection's own `privateNetwork`; it is pinned for the request, and link-local is never allowed |
| How an API is reached | `HttpFetch` (`packages/adapters`) | `nodeHttp`: SSRF-guarded, pinned to the connection's host. A request may carry `clientCertificate` (mutual TLS), which is presented to that host only, over https only | `BuildServerOptions.http` — a transport supplied here must present `clientCertificate` when a request carries one, or refuse the request; never send it without. This is also the relay seam: a hosted build that reaches a customer's network through an agent they run supplies a transport that sends there |
| Reading published documentation | `FetchDocument` | `fetchPublicDocument`, SSRF-guarded | `BuildServerOptions.fetchDocument` |
| Drawing documentation rendered in the browser | `DocsRenderer` (`apps/server/src/discovery/index.ts`) | None: such a page is said to be unreadable | `BuildServerOptions.renderDocs` — a hosted build supplies a rendering service that reaches public addresses only; a local headless browser is not bundled |
| AI models | `LlmAdapter` (`packages/agent`) | Anthropic or OpenAI from the environment, per task | `BuildServerOptions.llm` |
| Repairs the integration loop tries | `RepairStrategy` (`apps/server/src/integrate/strategies.ts`) | `DEFAULT_STRATEGIES` | `IntegrateDeps.strategies` |
| Where connector code runs | `ConnectorSandbox` (`apps/server/src/connector/sandbox.ts`) | `QuickJsSandbox`: QuickJS compiled to WebAssembly, one worker thread and a fresh interpreter per run | `BuildServerOptions.connectorSandbox` — a hosted build supplies a process or microVM runner |
| A connector's session tokens | `ConnectorTokenStore` (`apps/server/src/connector/host.ts`) | `VaultConnectorTokens`: the vault, with expiry in the credential meta store | `BuildServerOptions.connectorTokens` |

## Rules for a new one

- **An interface, and a local implementation that works with nothing installed.** A fresh clone must run.
- **Every durable store carries a workspace key from its first row**, even though the open-source build has one workspace (`local`). A hosted build that keeps many workspaces in one database then needs no migration.
- **Relational or append-only state goes in `DashDb`**, with its DDL in `DASH_SCHEMA_SQL` (idempotent, applied on open). Specifications — connections, dashboards, the catalog — stay files until the hosted work moves them behind repositories.
- **The response cache stays memory-only.** History, where it is wanted, is a separate store with its own lifecycle.

## Connector code: what contains it, and what does not

Some APIs need code: every request signed, a login for a session token, records that exist only as a file an export produces. The integration loop writes that code from the documentation (the `connector` model task), and it runs only inside the `ConnectorSandbox`, never in the server's own process. The code is plain JavaScript that defines hooks (`CONNECTOR_CONTRACT` in `packages/spec/src/connector.ts`). It can do nothing outside itself except ask the server, and `apps/server/src/connector/host.ts` decides every request.

**The controls, each exercised by `connector/connector.test.ts`:**

| Control | Where | What it stops |
|---|---|---|
| No network, file system, process or clock of its own | QuickJS has none; the worker gets an empty environment | Reaching anything but the host's functions. `Date` and `Math.random` are the server's (`prelude.js`). |
| Memory cap | The WebAssembly memory has a hard maximum (64 MB by default) | A run that allocates without bound fails inside the code as "out of memory". QuickJS's own memory limit is not enforced in this build, so it is not relied on. |
| CPU cap | Time spent running the code is counted and the interpreter interrupted past it (5 s) | Code that never ends. |
| Wall-clock cap | The worker is terminated at the authority's `wallMs` (60 s by default), whatever it is doing | A run that waits forever, or anything the CPU count misses. |
| Destinations | Every request's host must be listed in the authority, and the method allowed for it | Sending anywhere else. GET, HEAD and POST only: anything that changes an account is refused, and changes go through the write service's review. |
| Credential binding | `{{secret:name}}` is filled in only for a host bound to `name`; the code never receives a value | A key sent to the wrong host. |
| Identifiers | A pasted value the connector declared `secret: false` — a key ID, an account number — can be read with `credentials.identifier`, so it can go inside something the code signs. One named or labelled like a secret, password or token never can, whatever it declares | Secrets handed to code under another name. |
| Signatures | `crypto.hmac` and `crypto.derive` run in the server; every signature a run makes is remembered, and a request carrying one to a host not bound to its key is refused | A signature used somewhere it was not meant for. |
| Downloads | A `download` host carries no credential and is reached only at an address the API itself answered with in the same run | Code inventing an address to send data to. |
| Redirects | Never followed across hosts: the transport pins each request to its destination's host (`safe-fetch.test.ts`), and a POST is never redirected | A redirect carrying a request somewhere else. |
| Echoes | Every credential value this run resolved is removed from answers, headers and log lines before the code or a log sees them | An API that repeats a key back. |
| Budgets | Requests per run, total waiting time, and retries (reads only) come from the authority | A run that hammers an API. |
| Pinning | The code is stored with its SHA-256; a mismatch is refused before anything runs | Code changed after it was proven. |
| Installation | The loop keeps code only when a read through it returns records, and refuses an authority whose API hosts are not the service's own site | Code proven against nothing, or granted another organisation's hosts. |

**Residual risks.** The tests show each control working on the attempt it exists for. They do not prove there is no other way around one:

- **A transformed signature.** A signature is refused when it is sent verbatim to an unbound host. The same signature reversed, split or re-encoded is not recognised, so code could carry one to another host the authority lists. The authority's API hosts must share the service's site, so this matters only when a connector lists more than one.
- **A secret declared an identifier.** A model can declare a pasted secret `secret: false` under a name and label that do not look like one ("reference", "code"). The code then reads it, and can send it anywhere its authority reaches. Identifiers are not searched for in requests or taken out of answers, since they are not secret. The word check catches the obvious cases only.
- **Timing and volume.** Code can signal through when, and how many, requests it sends to the hosts it may reach.
- **What the API returns.** Anything the API answers with — other than a credential value this run resolved — reaches the code and the records it returns. That is the point of a read, and why answers are treated as untrusted data everywhere else.
- **The interpreter.** A flaw in QuickJS or in the WebAssembly engine could reach the worker thread, which holds no secrets and no environment but runs in the server's process. A hosted build should run connectors in a separate process or microVM behind the same interface.
- **The worker's own heap.** Answers are copied through the worker as text. They are capped at 16 MB each, and the worker's heap has a Node resource limit, but a run can still hold several answers at once.
- **Model-written code is judged by its read.** The loop keeps code whose read returns records; it does not prove those are the right records. The benchmark's answer keys are what measure that.
