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

## To guard when managed lands

These routes change stored state. They run for anyone who can reach the server today:
- **dashboards:** `POST/PUT/DELETE /api/dashboards…`, widget approve/unapprove, and briefs (`boards.edit`)
- **connections:** `PUT/DELETE /api/connections/:id`, `…/key`, `…/address`, `…/ops`, `…/resources`, `…/rhythm`, and `POST /api/connections/from-catalog` (`connections.manage`)
- **catalog:** `PUT /api/catalog/:id`, `…/entities/:entity/layout`, `…/reference`, and the map, describe, views and categories passes (`connections.manage`)
- **parts and models:** `PUT/DELETE /api/parts/:kind/:id` and `PUT /api/models`
- **chat board actions:** `remove_widget`, `group_widgets`, `create_dashboard`, `rename_dashboard` and `delete_dashboard`. Each has an `authorize` hook to extend.

## Also bound to the one local identity

- `ScratchDraftStore` and `ScratchFocusStore` are built with `LOCAL_USER_ID` when the server starts (`server.ts`). They must take the principal per request.
- The chat registry's `tenantKey` is the dashboard id only. It must include the workspace.
- `publicConnection` and `GET /api/connections` do not depend on who is asking. They must filter by the member's grants.
- `getAuthContext` never sets `orgId` or `extra.tenantId`. The chat store scopes sessions by either one, and sessions saved so far have neither. Moving chat tenancy to the workspace needs a migration, not a flag.
