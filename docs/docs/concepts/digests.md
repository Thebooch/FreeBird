---
title: Digests
---

# Digests

Every saved tab can carry a `DigestConfig { intervalCron, email, format }`.
At each interval, FreeBird:

1. Calls each component's `dataSource()` to snapshot live data.
2. Sends the snapshot bundle to the LLM with a summary prompt.
3. Sends the rendered summary via your configured email adapter.

### Two ways to run it

**In-process scheduler** (small deployments):

```ts
createFreeBirdRouter({ db, llm, email, registry, scheduler: "inProcess" })
```

**Standalone worker** (multi-replica production, required to avoid
duplicate sends once you run more than one API node):

```bash
pnpm add @freebirdai/digest-worker
node -e "require('@freebirdai/digest-worker/bin')"
```

Both share `core/digest/engine.ts`, so behavior is identical. The worker
takes a DB-backed lock so you can horizontally scale it safely too.
