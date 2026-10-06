# Connect: an Express app

Serves `@freebirdai/connect` over HTTP with `@freebirdai/connect-server`.

```bash
pnpm install
pnpm --filter freebird-connect-express-example start
```

```bash
# add an API
curl -X POST localhost:3030/connect/connections -H 'content-type: application/json' \
     -d '{"from":"https://api.apis.guru/v2/openapi.yaml"}'

# read it
curl -X POST localhost:3030/connect/connections/apis-guru/read -H 'content-type: application/json' \
     -d '{"op":"getProviders","fresh":"5m"}'

# give a connection its key
curl -X PUT localhost:3030/connect/connections/<id>/key -H 'content-type: application/json' -d '{"key":"..."}'
```

The `authorize` function in `src/server.ts` is where your own permission check
goes: this one allows reads and refuses every change. The `actor` callback says
who is asking, from your own sign-in; here, an `x-user` header.

Every route is listed in [`connect/packages/server/README.md`](../../connect/packages/server/README.md).
