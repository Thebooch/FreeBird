# @freebirdai/connect

Connect to an API you have never seen, work out what its records are, keep
their data fresh, and make changes a person reviews first. With no dashboard,
no server and no database unless you want them.

```bash
npm i @freebirdai/connect
```

## Five minutes

```ts
import { createConnect } from "@freebirdai/connect";

const connect = createConnect();

// From an OpenAPI or GraphQL address, a docs page, an MCP server, or the API's name.
const api = await connect.connections.add({ from: "https://api.apis.guru/v2/openapi.yaml" });

// Most APIs need a key; this one does not.
if (connect.connections.status(api.id).needsKey) await connect.connections.setKey(api.id, process.env.API_KEY!);

// Read what matters, repair what the documentation got wrong, confirm how each endpoint pages.
await connect.integrate(api.id);

const { rows } = await connect.read(api.id, { op: "getProviders", fresh: "5m" });
console.log(rows.length); // 677
```

A runnable version is in [`examples/connect-node`](../../../examples/connect-node).

With a model, the engine also works out what the API's records are, and a
read can name one instead of an endpoint:

```ts
import { createAnthropicAdapter } from "@freebirdai/adapters-llm-anthropic";

const connect = createConnect({ llm: createAnthropicAdapter() });
// …add, key and integrate as above…
connect.records(api.id); // [{ id: "tenant", name: { one: "Tenant", many: "Tenants" }, … }, …]
const late = await connect.read(api.id, { record: "tenant", filter: { status: "late" } });
```

The model is only needed to map an API and to repair it when the built-in
repairs are not enough. Reading never calls a model. The adapters are guide's
(`@freebirdai/adapters-llm-anthropic`, `-openai`), so FreeBird plugs a model in
one way everywhere.

## What it does

| | |
|---|---|
| **Discovery** | Finds the API's description from whatever you give it: an OpenAPI or GraphQL document, a documentation site, an MCP server, or a name to search for. |
| **Sign-in** | API keys, multi-part credentials, OAuth (tokens fetched, renewed and retried by themselves) and client certificates. Keys are encrypted at rest. |
| **The check** | `integrate` reads the endpoints that matter and repairs what the docs got wrong: the address, how the key is sent, where the rows are, how it pages. Reads only; it never changes the account. |
| **Mapping** | With a model: the API's record types, their fields, how they relate, how a list of each reads best. Worked out once per API and kept, so the next account to connect it inherits it. |
| **Reads** | `read` by endpoint or record type, with inputs, a filter and a freshness bound. Every API is paced (three at a time, a fifth of a second apart, environment-overridable), backs off when refused, and is answered from memory while fresh enough. |
| **Freshness** | `keep` refreshes reads in the background, each on its endpoint's own rhythm. A read that stops at the page limit is carried on in the background to its end. |
| **Reviewed changes** | `writes.prepare` returns the review: what will change, field by field, and a digest. `writes.commit` makes exactly that change and nothing else. Every change and every read that might not be one is journalled. |
| **Safety** | Every request goes through an SSRF guard pinned to the connection's own host. Connector code the engine writes runs only in a sandbox, and only if you install one. |

## Options

```ts
createConnect({
  dir: ".connect",        // where keys (encrypted), cadences and worked-out APIs are kept
  llm,                    // an adapter, or (task) => adapter | null
  authorize: (actor, permission, scope) => boolean, // your permission check for changes
  store,                  // where connections live (default: memory)
  keys,                   // where keys live (default: an encrypted file under `dir`)
  catalog,                // what is known about each API (default: under `dir`)
  stores,                 // evidence, jobs, journal, shapes… (default: memory)
  cache,                  // cached responses (default: this process)
  sandbox,                // where generated connector code runs (default: refused)
  renderDocs,             // reads documentation drawn in a browser (default: skipped)
  search,                 // web search, for finding an API by name
});
```

Everything heavy is a separate package:

| Add-on | What it adds |
|---|---|
| [`@freebirdai/connect-postgres`](../postgres) | `openConnectDb` and `createDbStores`: evidence, jobs, the journal, shapes, seen values, credential expiry and leases in Postgres, or an embedded PGlite. |
| [`@freebirdai/connect-sandbox`](../sandbox) | `QuickJsSandbox`: runs the connector code the engine writes for an API a declaration cannot describe. |
| [`@freebirdai/connect-browser`](../browser) | `BrowserDocsRenderer`: reads documentation that only appears once a browser runs it. |
| [`@freebirdai/connect-server`](../server) | The HTTP routes, for Fastify, Express and Next.js. |
| [`@freebirdai/connect-actions`](../actions) | Connect, read and change APIs from a FreeBird guide chat. |

## Events

```ts
const stop = connect.on((event) => {
  // { type: "read" | "read-failed" | "checked" | "write", connection, … }
});
```

## Changes

```ts
const review = await connect.writes.prepare(
  { connection: api.id, entity: "tenant", kind: "update", id: "t1", values: { phone: "555-0100" } },
  { userId: "u1", workspaceId: "acme" },
);
// show `review` to the person; on yes:
await connect.writes.commit(review, { userId: "u1", workspaceId: "acme" });
```

`authorize` is asked before every review and every commit.

## How well it handles APIs it has never seen

FreeBird keeps a benchmark of APIs written by somebody who never reads the
integration code, scored against answer keys fixed before anything runs. The
latest figures, with the engine driven end to end by FreeBird Dash, are in
[`dash/bench/RESULTS.md`](../../../dash/bench/RESULTS.md):

- **Real public APIs:** 12 of 12 correct.
- **Unseen, held-out mock APIs:** 6 of 12 correct, with 1 wrong number not flagged as such.

## For hosts

`createEngine` is the same machinery without the wrapper, for a host that
serves it itself: it hands back the broker, adapter registry, cache, gate,
job runners, write service and integration loop. FreeBird Dash builds one per
workspace. What such a host needs beyond it (the catalog and vault,
discovery, the stores' interfaces, the query helpers) is exported from
`@freebirdai/connect/host`.

## License

MIT
