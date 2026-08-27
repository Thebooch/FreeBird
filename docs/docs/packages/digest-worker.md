---
title: "@freebirdai/digest-worker"
---

# @freebirdai/digest-worker

Standalone cron worker for digests. Required once your host server runs
more than one replica (otherwise you'll double-send).

```ts title="worker.ts"
import { DigestWorker } from "@freebirdai/digest-worker";
import { db, llm, email, registry } from "./freebird.shared";

const worker = new DigestWorker({ db, llm, email, registry, tickMs: 60_000 });
worker.start();
```

Or run via the CLI: `pnpm exec freebird-digest-worker ./worker.js`.

Uses the same `@freebirdai/core/digest/engine` as the in-process scheduler,
so behavior is identical. Safe to run multiple replicas — the worker takes
a DB-backed lock per digest run.
