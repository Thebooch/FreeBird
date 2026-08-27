# @freebirdai/digest-worker

Standalone cron worker for FreeBird digests. Shares the exact same `DigestEngine` as `@freebirdai/server`, so behavior is identical whether you run the in-process scheduler or this worker.

## When to use

- **Single replica** — use `@freebirdai/server`'s `scheduler: "inProcess"`.
- **Multi-replica production** — run this worker as its own process. It takes a DB-backed distributed lock to avoid duplicate sends.

## Install

```bash
pnpm add @freebirdai/digest-worker @freebirdai/core
```

## Programmatic usage

```ts
import { createDigestEngine } from "@freebirdai/core";
import { createDigestWorker } from "@freebirdai/digest-worker";

const digest = createDigestEngine({ db, llm, email, registry });
const worker = createDigestWorker({ digest, db, pollMs: 60_000 });
worker.start();
```

## CLI usage

Write a bootstrap file that constructs a worker and default-exports it:

```ts
// freebird.worker.ts
import { createDigestEngine } from "@freebirdai/core";
import { createDigestWorker } from "@freebirdai/digest-worker";
import { db, llm, email, registry } from "./infra";

export default createDigestWorker({
  digest: createDigestEngine({ db, llm, email, registry }),
  db,
});
```

Then:

```bash
freebird-digest-worker --config ./dist/freebird.worker.js
# or run once (useful for cron-managed containers)
freebird-digest-worker --config ./dist/freebird.worker.js --once
```

## Refreshing auth for long-running digests

Tabs save the auth context that was active *at save time*. With JWTs or
short-lived service tokens that's wrong by the time the digest fires. Pass
`refreshAuth` to the **engine** (the worker uses the engine's hook
automatically) to mint a fresh context per run:

```ts
import type { AuthContext, CustomTab } from "@freebirdai/core";

const digest = createDigestEngine({
  db,
  llm,
  email,
  registry,
  refreshAuth: async (savedAuth: AuthContext, tab: CustomTab) => {
    const token = await mintServiceToken({
      ownerId: tab.ownerId,
      audience: "freebird-digest",
      ttlSeconds: 300,
    });
    return { ...savedAuth, extra: { ...savedAuth.extra, token } };
  },
});
```

Behaviour:

- `refreshAuth` runs immediately before each tab's `dataSource()` call.
- The returned `AuthContext` replaces the resolved one for that run only —
  `db.updateTab` and downstream `dataSource` adapters all see the fresh
  value.
- Throwing aborts the run for that tab and the error is reported in the
  `DigestRunResult.error`. The next poll will retry, so transient failures
  (e.g. token mint timeouts) self-heal.
