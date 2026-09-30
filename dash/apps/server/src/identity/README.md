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

## Guarded now (plan, track G)

Every route that changes stored state asks the policy before it runs, from one table (`identity/guard.ts`, `GUARDED_ROUTES`): boards and briefs need `boards.edit`; connections, the catalog, discovery, onboarding, sign-in and models need `connections.manage`; reading a sample or what may be changed needs `records.read`. Reads need nothing beyond being in the workspace. A change to a connected account keeps its own finer check on prepare and commit, so a member granted one record type is not refused at the door.

The open-source build still has one owner and no sign-in, and it refuses to listen anywhere but this machine unless an identity provider signs every request in (`bindAllowed`). With `DASH_OIDC_ISSUER` and `DASH_OIDC_AUDIENCE` set, `oidcJwtResolver` verifies each bearer token against the issuer's published keys (never `alg: none`, never a shared secret, keys only from the issuer's own host), and the workspace's `MembershipStore` says each person's role. The first owner is named with `DASH_OWNER_SUB` and `DASH_WORKSPACE`.

## Was the list to guard (kept for reference)

These routes change stored state. Before track G they ran for anyone who could reach the server:
- **dashboards:** `POST/PUT/DELETE /api/dashboards…`, widget approve/unapprove, and briefs (`boards.edit`)
- **connections:** `PUT/DELETE /api/connections/:id`, `…/key`, `…/address`, `…/ops`, `…/resources`, `…/rhythm`, and `POST /api/connections/from-catalog` (`connections.manage`)
- **catalog:** `PUT /api/catalog/:id`, `…/entities/:entity/layout`, `…/reference`, and the map, describe, views and categories passes (`connections.manage`)
- **parts and models:** `PUT/DELETE /api/parts/:kind/:id` and `PUT /api/models`
- **chat board actions:** `remove_widget`, `group_widgets`, `create_dashboard`, `rename_dashboard` and `delete_dashboard`. Each has an `authorize` hook to extend.

## Still bound to one workspace per server

A signed-in member is checked against their workspace's roles, but every store still holds one workspace's data per server. What remains before one server can hold several workspaces:

- `ScratchDraftStore` and `ScratchFocusStore` are built with `LOCAL_USER_ID` when the server starts (`server.ts`). They must take the principal per request.
- The chat registry's `tenantKey` is the dashboard id only. It must include the workspace.
- `publicConnection` and `GET /api/connections` do not depend on who is asking. They must filter by the member's grants.
- `getAuthContext` never sets `orgId` or `extra.tenantId`. The chat store scopes sessions by either one, and sessions saved so far have neither. Moving chat tenancy to the workspace needs a migration, not a flag.
