# @freebirdai/connect-server

HTTP routes for `@freebirdai/connect`, the same set on three frameworks.

```ts
import { createConnect } from "@freebirdai/connect";
import { connectRouter } from "@freebirdai/connect-server/express";

const connect = createConnect({ llm });
app.use("/connect", express.json(), connectRouter(connect));
```

| Route | What it does |
|---|---|
| `GET /connections` | Every connection, and what each still needs |
| `POST /connections` `{ from }` | Add an API from its docs, OpenAPI address, MCP server or name |
| `GET /connections/:id` | One connection |
| `DELETE /connections/:id` | Remove it and its keys |
| `PUT /connections/:id/key` `{ key }` or `{ keys }` | Save its key; it is checked next, by itself |
| `POST /connections/:id/integrate` | Check it now: read, repair, confirm paging |
| `GET /connections/:id/records` | The record types it knows |
| `POST /connections/:id/read` `{ op \| record, params, filter, fresh }` | Read |
| `POST /connections/:id/changes` `{ entity, kind, id, values }` | Prepare a change and see the review |
| `POST /changes/:pendingId/commit` `{ digest }` | Make the change you reviewed |
| `DELETE /changes/:pendingId` | Drop it |

- Fastify: `connectFastify(connect)` from `@freebirdai/connect-server/fastify`.
- Next.js: `connectRouteHandlers(connect)` from `@freebirdai/connect-server/next`.

Pass `actor` to say who is asking; the engine's `authorize` decides what they
may change. The Fastify entry also exports the integrate, map and OAuth route
plugins a host serving `createEngine` mounts, as Dash does.
