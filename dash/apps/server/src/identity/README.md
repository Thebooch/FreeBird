# Identity, policy and the journal — the seams

The open-source build has one person in it. `localOwner()` answers every request with the same principal, which owns the whole workspace. `ownerPolicy` lets the owner do everything. `nullJournal` keeps nothing. Nobody signs in, because the server listens on `127.0.0.1` and whoever can reach it already controls it.

A managed build replaces all three through `BuildServerOptions`. There is no mode flag.
- `identity`: an `IdentityResolver` that reads a session and returns a member of a workspace, or `null`, which the server turns into a 401.
- `policy`: a `Policy` that reads the member's role and scoped grants (`@freebirdai/dash-spec` `access.ts`) from a `MembershipStore`.
- `journal`: a `WriteJournal` that stores every `WriteEvent` for review and reversal.

The lead user is the workspace `owner`. Invitations store a token hash, never the token.

## Guarded today

- Every change to a connected account, through `WriteService`. Policy is asked on prepare and again on commit. This covers both the REST routes and the chat's `change_record` / `remove_record`.
- The write-field overrides, switching an endpoint off or on (`PUT …/writes/:opId/offered`), "Match fields" and `POST /api/catalog/:id/writes/refresh`. All require `connections.manage`. There is no per-connection switch for writes: the policy is the only gate, so a managed build's roles and grants are what limit who may change which record types.

## Guarded now

Every route that changes stored state asks the policy before it runs, from one table (`identity/guard.ts`, `GUARDED_ROUTES`): boards and briefs need `boards.edit`; connections, the catalog, discovery, onboarding, sign-in and models need `connections.manage`; reading a sample or what may be changed needs `records.read`. Reads need nothing beyond being in the workspace. A change to a connected account keeps its own finer check on prepare and commit, so a member granted one record type is not refused at the door.

The open-source build still has one owner and no sign-in, and it refuses to listen anywhere but this machine unless an identity provider signs every request in (`bindAllowed`). With `DASH_OIDC_ISSUER` and `DASH_OIDC_AUDIENCE` set, `oidcJwtResolver` verifies each bearer token against the issuer's published keys (never `alg: none`, never a shared secret, keys only from the issuer's own host), and the workspace's `MembershipStore` says each person's role. The first owner is named with `DASH_OWNER_SUB` and `DASH_WORKSPACE`.

## Was the list to guard (kept for reference)

These routes change stored state. Before they were guarded, they ran for anyone who could reach the server:
- **dashboards:** `POST/PUT/DELETE /api/dashboards…`, widget approve/unapprove, and briefs (`boards.edit`)
- **connections:** `PUT/DELETE /api/connections/:id`, `…/key`, `…/address`, `…/ops`, `…/resources`, `…/rhythm`, and `POST /api/connections/from-catalog` (`connections.manage`)
- **catalog:** `PUT /api/catalog/:id`, `…/entities/:entity/layout`, `…/reference`, and the map, describe, views and categories passes (`connections.manage`)
- **parts and models:** `PUT/DELETE /api/parts/:kind/:id` and `PUT /api/models`
- **chat board actions:** `remove_widget`, `group_widgets`, `create_dashboard`, `rename_dashboard` and `delete_dashboard`. Each has an `authorize` hook to extend.

## Several workspaces on one server

A host holds one server per workspace (`platform/workspaces.ts`, `WorkspaceHost`). Each request is resolved by the identity provider, and the member's workspace's server answers it. One request names its workspace instead: a webhook's call, `POST /api/workflow-hooks/<workspace>/<token>`, which another system makes with nobody signed in. The host hands it to that workspace's server without resolving anyone, and only when `holds` says the workspace is there. That server lets that one route through without a principal (`installIdentity`'s `open` routes, matched on the route Fastify chose). The token, minted for one waiting case, is the authority. That server is `buildServer` with the workspace's own stores (`createLocalPlatform().forWorkspace(id)`):
- its connections, boards and reports under `workspaces/<id>/`, its keys in its own vault file;
- its rows in Dash's database under its own key: evidence (`scopedEvidence`), the journal, credential expiry, seen values, shapes, history, jobs and check queue, and leases;
- its own catalog tier. The shipped catalog and the registry tier stay shared;
- its own keeper, cache, connection gate and jobs.

The first workspace (`DASH_WORKSPACE`, or `local` in the open-source build) keeps its data where it always was: the root folders and the `local` key.

Within a server:
- **Who is asking is checked against the workspace.** A member of another workspace is refused (403), whatever route sent them.
- **Per person.** Concierge drafts and a conversation's record focus are kept per person, in the chat database's scratch table, keyed by workspace and person.
- **Chat.** Sessions, messages and custom tabs are kept under the workspace as the chat store's tenant (`orgId`). The registry cache is keyed by workspace and board. Sessions saved before workspaces existed were moved to `local` when the chat database opened (`chat/db.ts`).
- **Reads are filtered by grants.** `GET /api/connections` lists only what the member may read. Every `GET /api/connections/:id…`, `/api/query` and `/api/query/each` asks the policy for `records.read` on that connection. Every role that reads at all reads everything, as before; a narrower grant narrows.

Run a host with `DASH_WORKSPACES=many`, with sign-in configured (`DASH_OIDC_ISSUER`, `DASH_OIDC_AUDIENCE`). Without it the server is one workspace, as it always was. A workspace nobody has asked anything of for twenty minutes is closed, and built again when asked.
