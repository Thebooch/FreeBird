# Connect: a plain Node script

Reads an API with `@freebirdai/connect`: no server, no database, no dashboard.

```bash
pnpm install
pnpm --filter freebird-connect-node-example start
```

By default it adds [APIs.guru](https://apis.guru), which needs no key, checks
it, and reads every provider it lists (twice, to show the second read coming
from memory). Point it at any other API:

```bash
API_KEY=... pnpm --filter freebird-connect-node-example start https://api.example.com/openapi.json
```

Set `ANTHROPIC_API_KEY` and the engine also works out the API's record types,
so a read can name one (`{ record: "invoice" }`) instead of an endpoint.

Keys are kept encrypted under `.connect/` in this folder.
