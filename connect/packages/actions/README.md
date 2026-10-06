# @freebirdai/connect-actions

Any API, from a FreeBird chat. A guide component and two chat tools over
`@freebirdai/connect`, so a chat on your site can connect an API, answer
questions from its records, and change a record after the person reviews
exactly what will change.

```ts
import { createConnect } from "@freebirdai/connect";
import { createConnectKit } from "@freebirdai/connect-actions";
import { createFreeBirdRouter } from "@freebirdai/server/express";

const connect = createConnect({ llm });
const kit = createConnectKit(connect, {
  authorize: (actor, intent) => mayChange(actor.userId, intent), // your own rule
});
registry.register(kit.component);

app.use("/freebird", createFreeBirdRouter({ db, llm, registry, extraTools: kit.tools, executeExtraTool: kit.executeTool }));
```

| | |
|---|---|
| `connect_list_apis` (tool) | What is connected, what each still needs, and its record types. |
| `connect_read` (tool) | Read by record type or endpoint, filtered, optionally combined into one number (count, sum, average, min, max). The answer comes back into the turn. |
| `add_api` (action) | Connect an API from its docs, OpenAPI address, MCP server or name. Confirmed first. |
| `check_api` (action) | Run the engine's check and, with a model, work out the record types. |
| `change_record` (action) | Create, update, delete or act on one record. Strict confirmation: the card is the engine's own review, field by field. |

**How a change stays honest.** `preflight` asks the engine for the review
before the card is shown, so the card shows the real before and after. The
handler asks for the review again rather than trusting the card's arguments
(within one conversation the engine hands back the same one) and commits only
that. A review the model writes into the arguments is ignored.

**Keys never go through the chat.** Whatever is typed there reaches the model
and the conversation's history. The chat says a connection needs a key; the
site collects it in its own form (`connect.connections.setKey`, or
`PUT /connections/:id/key` from `@freebirdai/connect-server`).

`authorize` is asked before the record is read for the review, and again by
guide before the change runs; the engine's own `authorize` applies as well.

A runnable app is in [`examples/connect-express`](../../../examples/connect-express).
