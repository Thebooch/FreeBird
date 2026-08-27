---
title: "@freebirdai/server"
---

# @freebirdai/server

One Node library, three framework integrations.

```ts
// Express
import { createFreeBirdRouter } from "@freebirdai/server/express";
app.use("/freebird", createFreeBirdRouter({ db, llm, email, registry, scheduler: "inProcess" }));

// Fastify
import { createFreeBirdPlugin } from "@freebirdai/server/fastify";
await fastify.register(createFreeBirdPlugin({ db, llm, registry }));

// Next.js App Router — app/freebird/[...route]/route.ts
import { createFreeBirdRouteHandlers } from "@freebirdai/server/next";
export const { GET, POST, PATCH, DELETE } = createFreeBirdRouteHandlers({ db, llm, registry });
```

### Routes mounted

- `POST /freebird/chat` — streaming chat (SSE).
- `POST /freebird/layout/plan` — non-streaming plan.
- `GET/POST/PATCH/DELETE /freebird/tabs` — tabs CRUD.
- `POST /freebird/tabs/:id/digest` — configure digest.
- `POST /freebird/knowledge` — runtime knowledge upserts.

### Auth & middleware

Every integration accepts a `getAuthContext(req)` hook — return `{ userId,
orgId }` or `null` to reject. Middleware like `rateLimit` and `promptGuard`
are exported from `@freebirdai/server/middleware`.
