# @freebirdai/server

Host-agnostic route handlers for [FreeBird](../../README.md), plus thin integrations for Express, Fastify, and Next.js App Router.

## Install

```bash
pnpm add @freebirdai/server @freebirdai/core
# plus whichever host you're using
pnpm add express
```

## Express

```ts
import express from "express";
import { createFreeBirdRouter } from "@freebirdai/server/express";

const app = express();
app.use(express.json());
app.use("/freebird", createFreeBirdRouter({
  db, llm, email, registry,
  scheduler: "inProcess",         // or "external"
  getAuthContext: (req) => ({ userId: req.user?.id }),
}));
```

## Fastify

```ts
import { createFreeBirdPlugin } from "@freebirdai/server/fastify";
fastify.register(createFreeBirdPlugin({ db, llm, email, registry }), { prefix: "/freebird" });
```

## Next.js App Router

```ts
// app/freebird/[...route]/route.ts
import { createFreeBirdRouteHandlers } from "@freebirdai/server/next";
export const { GET, POST, PATCH, DELETE } = createFreeBirdRouteHandlers({
  db, llm, email, registry,
});
```

## Routes mounted

| Method | Path | Description |
|---|---|---|
| POST   | `/sessions` | Create a chat session. |
| GET    | `/sessions/:sessionId/messages` | List messages. |
| GET    | `/sessions/:sessionId/layout`   | Active layout (client-driven by default). |
| POST   | `/chat` | Stream a chat turn (SSE). |
| POST   | `/chat/explain` | Stream an explanation for a component id (SSE). |
| GET    | `/tabs` | List saved custom tabs. |
| POST   | `/tabs` | Save a custom tab. |
| GET    | `/tabs/:id` | Get one. |
| PATCH  | `/tabs/:id` | Update title / layout / digest. |
| DELETE | `/tabs/:id` | Delete. |

## Middleware

```ts
import { rateLimit, promptGuard } from "@freebirdai/server/middleware";
```

## Digest scheduler

- `scheduler: "inProcess"` — the router starts an in-process cron that polls `DbAdapter.listDueDigests` every minute and runs the digest engine. Good for single-replica deployments.
- `scheduler: "external"` (default) — run [`@freebirdai/digest-worker`](../digest-worker) as a separate process.

Both share the same `DigestEngine` from `@freebirdai/core`, so behavior is identical.
