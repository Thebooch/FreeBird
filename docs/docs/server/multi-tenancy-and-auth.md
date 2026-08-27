# Multi-tenancy & auth

FreeBird enforces identity and tenancy at three layers: the transport (client → server), the auth context (server → storage), and optional multi-tenant registry/LLM resolution for hosts serving many sites from one process.

## The auth context

`getAuthContext(req)` is the single server-side auth hook. Every integration (Express, Fastify, Next.js) accepts it; the returned `AuthContext` (`{ userId?, orgId?, ... }`) is passed to **every** `DbAdapter` call, so tenancy is enforced at the storage boundary — not sprinkled through handlers:

```ts
createFreeBirdRouter({
  db, llm, registry,
  getAuthContext: async (req) => {
    const session = await yourAuth.validate(req);
    if (!session) return null;           // → 401
    return { userId: session.user.id, orgId: session.org.id };
  },
});
```

The same `AuthContext` reaches action `authorize` hooks, `readCurrent`, `handler`, digest rendering, and MCP tools — one identity shape everywhere.

## Client-side: authenticated transport

`FetchTransport` sends `Authorization` headers from `getAuthToken()` and single-flights 401 refresh via `onUnauthorized()` — see [core-state](../packages/core-state.md#authenticating-the-transport) for the full contract.

## Middleware: rate limiting & prompt guards

Plain Express-style middleware from `@freebirdai/server/middleware`:

```ts
import { rateLimit, promptGuard } from "@freebirdai/server/middleware";

app.use("/freebird", rateLimit({ windowMs: 60_000, max: 30 }));
app.use("/freebird", promptGuard()); // strips known jailbreak patterns
```

## Multi-tenant serving

A single FreeBird server can serve many *sites* (tenants), each with its own component registry and LLM configuration — the model behind managed/hosted backends. `@freebirdai/server`'s tenancy layer accepts resolver forms instead of static instances:

```ts
import { createFreeBirdRouter } from "@freebirdai/server/express";

const router = createFreeBirdRouter({
  db,
  // Resolve per-request instead of passing one registry/llm:
  registry: async (req) => registryCache.forSite(siteIdFrom(req)),
  llm: async (req) => llmForSite(siteIdFrom(req)),
  getAuthContext,
});

// The integration exposes a handle for cache invalidation:
router.freebird.invalidateRegistry(siteId);
```

Static instances remain the fast path — single-tenant apps pass plain objects and nothing changes.

### Tenant-scoped storage

The Postgres and Prisma adapters carry an optional `tenant_id` on sessions, messages, and tabs. When your `AuthContext` includes a tenant discriminator, rows are scoped automatically; without one, the adapters behave exactly as single-tenant (the column stays null). Migrations ship with the adapters — see [Adapters](../packages/adapters.md).

### Metering LLM usage

For billing or quotas, wrap any LLM adapter's usage stream: `ChatEngine`'s `onLlmUsage` hook receives token counts (and optional USD estimates via `estimateLlmCostUsd`) per completion, with the session's auth context available for attribution. Emit to your metering pipeline from there.

## Security checklist

- `authorize` on every sensitive action — `setActiveComponentIds` is UX scoping, not security.
- `getAuthContext` returning `null` yields 401s across chat, actions, tabs, and digests.
- Rate-limit the chat route — it fans out to your LLM provider.
- The [Registration Manifest](../tooling/manifest-and-codegen.md) is pure data: actions compile only to an allowlist (local DOM, ticket filing, *named* webhooks resolved server-side), so scanned pages can't inject execution targets.
