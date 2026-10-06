---
"@freebirdai/connect": minor
"@freebirdai/dash-spec": minor
---

Changes made by workflows and agents are journalled as such.

- `WriteEvent.via` (and `prepare`'s `via`) can now be `"workflow"` or `"agent"` beside `"form"` and `"chat"`, and an event can carry `onBehalfOf: { kind: "agent", id }`. The actor is still the person whose permission the change used.
- The single read behind `connect.read()` is exported as `createRecordReader`, so a host can read records the same way for its own background work.
- Dash spec: workflows (`workflow.ts`): a trigger, an optional source and criteria, and steps that are each `auto` or `approve`, with an optional condition. A new `workflows.manage` permission.
