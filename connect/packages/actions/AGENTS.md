# @freebirdai/connect-actions — AI integration guide

Adds third-party APIs to a FreeBird guide chat. Self-contained.

## Install

```bash
pnpm add @freebirdai/connect @freebirdai/connect-actions @freebirdai/core zod
```

## Minimal integration

```ts
import { createConnect } from "@freebirdai/connect";
import { createConnectKit } from "@freebirdai/connect-actions";

const connect = createConnect({ llm }); // the same adapter guide uses
const kit = createConnectKit(connect, {
  actor: (auth) => ({ userId: auth?.userId ?? "anonymous", workspaceId: auth?.orgId ?? "local" }),
  authorize: (actor, intent) => canChange(actor, intent), // changes only
});
registry.register(kit.component);
// with @freebirdai/server:
createFreeBirdRouter({ db, llm, registry, extraTools: kit.tools, executeExtraTool: kit.executeTool });
```

Pass the tools as `extraTools` (always offered). Passed only as
`processingToolCatalog`, they are offered only while `connectedApis` is an
active component.

## Pitfalls

- **Without `executeExtraTool` the model asks and nothing answers.** Always pass both.
- **Keys:** never add an action or tool that takes a key. Collect it in your own UI and call `connect.connections.setKey`.
- **Record types need a model.** Until `check_api` runs with an `llm`, reads must name an endpoint (`op`).
- **`authorize` runs in `preflight`**, before the record is read, and guide runs it again before execution. Return `false` to block.

## Verification

- `kit.executeTool("connect_list_apis", {})` lists your connections.
- `kit.executeTool("connect_read", { connection, op })` returns `{ count, rows }`.
- `runAction(registry, { componentId: "connectedApis", actionId: "change_record", … })` returns `executed` only after the engine's review, and `blocked` when `authorize` says no.
