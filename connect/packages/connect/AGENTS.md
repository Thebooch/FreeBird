# @freebirdai/connect — AI integration guide

Instructions for an AI assistant adding FreeBird Connect to a host app. Self-contained.

## What this is

An integration engine for APIs nobody has written a connector for. Give it an API's documentation or OpenAPI address and a key. It works out how to sign in and read the API, repairs what the documentation got wrong, and keeps reads fresh. With a model, it also maps the API's record types and makes changes a person reviews first. Server-side TypeScript (Node ≥ 20).

Use it when the host needs data from, or changes in, a third-party API it does not control. It is not a UI; pair it with your own, or with `@freebirdai/connect-server` for HTTP routes.

## Install

```bash
pnpm add @freebirdai/connect zod
# optional, per need:
pnpm add @freebirdai/adapters-llm-anthropic   # or -openai: mapping and repairs
pnpm add @freebirdai/connect-server           # HTTP routes (Fastify / Express / Next)
pnpm add @freebirdai/connect-postgres         # durable stores
pnpm add @freebirdai/connect-sandbox          # run generated connector code
pnpm add @freebirdai/connect-browser          # read docs drawn in a browser
```

## Minimal integration

```ts
import { createConnect } from "@freebirdai/connect";

export const connect = createConnect({
  dir: ".connect",                       // keys (encrypted), cadences, worked-out APIs
  llm: null,                             // optional; reads never need one
  authorize: (actor, permission, scope) => canChange(actor.userId, permission, scope), // changes only
});
connect.start();                         // carry on work a previous run left

const api = await connect.connections.add({ from: "https://api.example.com/openapi.json" });
if (connect.connections.status(api.id).needsKey) await connect.connections.setKey(api.id, key);
await connect.integrate(api.id);         // the check; reads only
const { rows } = await connect.read(api.id, { op: "listInvoices", params: { status: "open" }, fresh: "5m" });
```

## Key APIs

| Call | Notes |
|---|---|
| `connections.add({ from, id? })` | `from` is an OpenAPI/GraphQL URL, a docs URL, an MCP server, or a name (name needs `search` and `llm`). Throws when nothing is found. |
| `connections.status(id)` | `{ needsKey, missingKeys, needsAddress }`. |
| `connections.setKey(id, key \| { [keyRef]: value })` | Several values by `keyRef` for multi-part sign-in. Triggers a check. |
| `integrate(id)` | Returns `{ outcome, changes, ops, requests, modelCalls, log }` or `{ error, status }`. With `llm`, then describes record types. |
| `records(id)` | Record types; empty until mapped (needs `llm`). |
| `read(id, { op \| record, params?, filter?, fresh?, range? })` | `op` matches case-insensitively. `filter` is equality on row fields, applied after the read. `fresh` is ms or `"30s" / "5m" / "1h" / "1d"`; default 5 minutes. |
| `keep(id, { ops?, every? })` | Background refresh; returns a stop function. |
| `writes.prepare(intent, actor?)` → review | `intent`: `{ connection, entity, kind: "create" \| "update" \| "delete" \| "action", id?, parents?, values? }`. |
| `writes.commit(review, actor?)` | Commits exactly the reviewed change (`pendingId` + `digest`). |
| `on(listener)` | `read`, `read-failed`, `checked`, `write` events. |

## Pitfalls

- **Private addresses are refused.** Every request goes through an SSRF guard; `localhost` and private ranges fail. Allow specific ones with `configureEgress(allowlistEgress("10.0.0.5,api.internal"))` from `@freebirdai/connect`.
- **No model, no record types.** `read({ record })` fails until `integrate` ran with an `llm`. Read by `op` instead.
- **Connector code needs a sandbox.** An API the engine can only read with generated code needs `sandbox: new QuickJsSandbox()` from `@freebirdai/connect-sandbox`; without it that code is refused, and the check says so.
- **Memory by default.** Connections, cache and the journal are lost on restart unless you pass `store` and `stores` (see `@freebirdai/connect-postgres`). Keys persist under `dir`.
- **Never log keys.** `setKey` stores them encrypted; nothing the engine returns carries one.
- **Set `DASH_MASTER_KEY`** (64 hex characters) in production; otherwise a dev key file is created under `dir`.

## Verification

```ts
const status = connect.connections.status(api.id);    // needsKey false
const run = await connect.integrate(api.id);          // "outcome" in run, outcome "ready"
const { rows, cache } = await connect.read(api.id, { op });
// rows.length > 0; a second read within `fresh` has cache "hit"
```

`examples/connect-node` runs this against APIs.guru, which needs no key: `pnpm --filter freebird-connect-node-example start`.
