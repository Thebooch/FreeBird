# Conversation review

The **review** capability lets the assistant walk a user through a list of host-provided items — call logs, invoices, form submissions, moderation queues — discussing each one and dispatching it with a disposition. FreeBird owns the LLM contract (normalized item shape, dispositions, prompt); the host owns the data and the rendering.

## Declaring a reviewable component

Add a `review` capability to any registered component:

```ts
registry.register({
  id: "callLog",
  title: "Call log",
  description: "Recent support calls",
  grid: { minW: 6, minH: 4 },
  review: {
    itemNoun: "call",                          // default "item"
    dispositions: ["dismiss", "flag", "report"], // default: all three
    guidance: "Flag calls where the customer sounded frustrated.",
  },
});
```

The chat engine option `review: { enabled }` defaults to on — review auto-activates whenever the registry has components declaring the capability, injecting the review prompt and exposing the `review_items` tool.

## Supplying the items

The host executes the `review_items` tool call and returns normalized `ReviewableItem`s:

```ts
interface ReviewableItem {
  id: string;
  title?: string;
  summary?: string;
  flagged?: boolean;     // already marked by a user
  concerning?: boolean;  // heuristically concerning (host or framework hint)
  createdAt?: string | Date;
  payload?: Record<string, unknown>; // raw host data, carried into ticket subjects
}
```

## Dispositions

Three built-in dispositions, host-filterable per component:

- **`dismiss`** — nothing to see; drop it from the queue.
- **`flag`** — mark for human follow-up on the host side.
- **`report`** — escalate: this bridges into the [support/ticket flow](./support.md), attaching the item (including `payload`) as the ticket's `supportContext.subject`.

## Rendering

Rendering stays entirely host-side — FreeBird doesn't ship a review modal. A typical host UI lists the items, mirrors flag/dismiss state, and lets the conversation drive it: "dismiss the first two, report the one from Tuesday" resolves through the same tool pipeline as any other action, so audit hooks see everything.

MCP hosts can expose the same queue to external agents via `executeReviewItems` on the [MCP server](../tooling/mcp.md).
