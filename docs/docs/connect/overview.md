---
title: "Connect: the integration engine"
---

# FreeBird Connect

`@freebirdai/connect` connects to an API nobody has written a connector for.
Give it the API's documentation or OpenAPI address and a key. It works out how
to sign in and read the API, repairs what the documentation got wrong, and
keeps the data fresh. With a model, it also maps the API's record types and
makes changes a person reviews first.

It is the engine inside FreeBird Dash, packaged to be used without a
dashboard.

```bash
npm i @freebirdai/connect
```

```ts
import { createConnect } from "@freebirdai/connect";

const connect = createConnect();
const api = await connect.connections.add({ from: "https://api.apis.guru/v2/openapi.yaml" });
await connect.integrate(api.id);
const { rows } = await connect.read(api.id, { op: "getProviders", fresh: "5m" });
```

## The pieces

| Package | What it is |
|---|---|
| `@freebirdai/connect` | The engine: discovery, sign-in, the check, mapping, reads, freshness and reviewed changes. Memory stores and a local encrypted key file by default. |
| `@freebirdai/connect-spec` | The types: connections, catalog entries, record types, evidence, rhythm, writes. |
| `@freebirdai/connect-server` | HTTP routes for Fastify, Express and the Next.js App Router. |
| `@freebirdai/connect-postgres` | Postgres or embedded PGlite stores. |
| `@freebirdai/connect-sandbox` | Runs generated connector code in QuickJS. |
| `@freebirdai/connect-browser` | Reads documentation drawn in a browser. |

## Reads

`read(id, request)` takes an endpoint (`op`) or, once the API is mapped, a
record type (`record`), plus inputs, a filter and a freshness bound:

```ts
await connect.read(api.id, { record: "invoice", params: { status: "open" }, filter: { currency: "USD" }, fresh: "1h" });
```

An answer younger than `fresh` comes from memory. Each API is asked at most
three requests at a time, a fifth of a second apart, and a refusal makes the
engine back off for that API. `keep(id)` refreshes reads in the background on
each endpoint's own rhythm.

## Reviewed changes

```ts
const review = await connect.writes.prepare({ connection: api.id, entity: "invoice", kind: "update", id: "in_1", values: { memo: "Paid by check" } });
// show the review; on yes:
await connect.writes.commit(review);
```

`authorize(actor, permission, scope)` in `createConnect`'s options is asked
before every review and every commit.

## Over HTTP

```ts
import { connectRouter } from "@freebirdai/connect-server/express";
app.use("/connect", express.json(), connectRouter(connect));
```

`connectFastify` and `connectRouteHandlers` (Next.js) serve the same routes.

## Examples

- `examples/connect-node`: a plain Node script.
- `examples/connect-express`: the routes on Express.
