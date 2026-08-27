# @freebirdai/server — AI integration guide

Instructions for an AI assistant wiring FreeBird's HTTP layer into a host app.

## What this is

Host-agnostic route handlers over `@freebirdai/core`, plus thin integrations for **Express**, **Fastify**, and **Next.js App Router**. Mount one of these and the client transport (`@freebirdai/core-state`, used by every UI binding) works with zero fetch code.

Use it in every FreeBird integration that has a Node server. Skip it only if you're pointing the client at an existing managed FreeBird backend.

## Install

```bash
pnpm add @freebirdai/server @freebirdai/core
# plus the host framework you already use: express | fastify | next
```

## Minimal integration

Pick ONE host form. All three take the same deps object: `{ db, llm, email?, registry, getAuthContext?, scheduler?, onActionEvent?, ticketSink? }`.

**Express:**

```ts
import express from "express";
import { createFreeBirdRouter } from "@freebirdai/server/express";
import { registry } from "./freebird.server.js";

const app = express();
app.use(express.json());
app.use("/freebird", createFreeBirdRouter({
  db, llm, registry,
  scheduler: "inProcess",                       // in-process digest cron; default "external"
  getAuthContext: (req) => ({ userId: req.user?.id }),
}));
```

**Fastify:**

```ts
import { createFreeBirdPlugin } from "@freebirdai/server/fastify";
fastify.register(createFreeBirdPlugin({ db, llm, registry, getAuthContext }), { prefix: "/freebird" });
```

**Next.js App Router** — create `app/freebird/[...route]/route.ts`:

```ts
import { createFreeBirdRouteHandlers } from "@freebirdai/server/next";
export const { GET, POST, PATCH, DELETE } = createFreeBirdRouteHandlers({ db, llm, registry, getAuthContext });
```

Then point the client at the mount path (e.g. `baseUrl: "/freebird"`). The UI bindings default to `/freebird`.

## Key APIs

- Routes mounted: `POST /sessions`, `GET /sessions/:id/messages`, `GET /sessions/:id/layout`, `POST /chat` (SSE), `POST /chat/explain` (SSE), `GET|POST /tabs`, `GET|PATCH|DELETE /tabs/:id`, `POST /actions/confirm|cancel|update-args`, support-ticket routes.
- `getAuthContext(req)` — return `AuthContext` (`{ userId?, orgId?, … }`) or `null` for 401. Flows into every DbAdapter call, action `authorize`, and digests.
- Middleware: `import { rateLimit, promptGuard } from "@freebirdai/server/middleware"` — apply to the mount path.
- `onActionEvent(event, auth)` — server-side audit stream (`action.executed/failed/cancelled/unauthorized/blocked`, `source: "http" | "mcp" | "chat"`).
- Multi-tenant: `registry` and `llm` also accept per-request resolver functions; the returned integration exposes `.freebird.invalidateRegistry(...)`.
- `scheduler: "inProcess" | "external"` — external means you run `@freebirdai/digest-worker` separately.

## Works with

- `@freebirdai/core` — build the `registry` and pick adapters there first.
- `@freebirdai/core-state` / React / Vue / Angular bindings — their default `FetchTransport` calls exactly these routes.
- `@freebirdai/adapters-*` — db/llm/email deps.
- `@freebirdai/embed` — point `data-api` at this mount for static sites.

## Common pitfalls

- **Express: bodyless 400s** → `express.json()` must be installed before the router.
- **SSE buffered/not streaming** → a proxy (nginx, Vercel edge) is buffering; disable buffering for the chat routes or use a runtime that supports streaming responses.
- **401 loops on the client** → `getAuthContext` returned `null`; the client transport's `onUnauthorized` must mint a fresh token or the stream won't reopen.
- **Digests never send** → with the default `scheduler: "external"` nothing runs in-process; either set `"inProcess"` (single replica only) or run `@freebirdai/digest-worker`.
- **Actions 403** → the action's `authorize` denied; check the `AuthContext` your `getAuthContext` actually returns.

## Verify

Start the server, then:

```bash
curl -X POST localhost:3000/freebird/sessions -H 'content-type: application/json' -d '{"title":"t"}'
# → 201 with a session id
curl -N -X POST localhost:3000/freebird/chat -H 'content-type: application/json' \
  -d '{"sessionId":"<id>","text":"hello"}'
# → SSE stream ending in an assistant_saved event
```
