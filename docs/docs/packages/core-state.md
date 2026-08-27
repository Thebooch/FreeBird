# core-state

`@freebirdai/core-state` is the framework-agnostic client state store and HTTP/SSE transport for FreeBird. The React, Vue, and Angular bindings are all thin reactive wrappers over this one package, so behavior stays identical across frameworks.

You usually don't install it directly — it comes in through your UI binding. Install it yourself when you're building a **custom framework adapter** or a fully bespoke UI.

## Exports

- `FreeBirdStore` — pure TypeScript class holding `sessionId`, `layout`, `tabs`, `messages`, `streaming` state plus the chat/explain streaming state machine, the action-layer state machine, and the support/ticket state.
- `FetchTransport` / `createFetchTransport` — default HTTP+SSE client talking to `@freebirdai/server`.
- `FreeBirdTransport` — the interface a custom transport must satisfy.
- Action-layer types and reducers: `ActionState`, `ActionRecord`, `ActionTransition`, `ActionEvent`.

## Design

The store uses a minimal pub/sub model — `subscribe(fn)` returns an unsubscribe function, and every mutation produces a fresh state reference. Each framework adapter bridges this into its own reactivity system exactly once:

| Framework | Binding |
|-----------|---------|
| React     | `useSyncExternalStore` |
| Vue       | `ref()` + `watchEffect` |
| Angular   | `signal()` inside an `@Injectable` |

Writing your own adapter is the same pattern:

```ts
import { FreeBirdStore, createFetchTransport } from "@freebirdai/core-state";

const store = new FreeBirdStore(createFetchTransport({ baseUrl: "/freebird" }));
const unsubscribe = store.subscribe((state) => {
  // mirror state into your framework's reactivity
});
store.send("Hello!");
```

## Authenticating the transport

`FetchTransport` has first-class hooks for token-based auth so hosts don't subclass it:

```ts
import { createFetchTransport } from "@freebirdai/core-state";

const transport = createFetchTransport({
  baseUrl: "/freebird",
  // Resolved before every fetch + SSE stream open. Return null for "no auth yet".
  getAuthToken: () => sessionStorage.getItem("token"),
  // Custom scheme. Defaults to "Bearer".
  authScheme: "Bearer",
  // Called once when a request 401s. Return a fresh token (or null to give up).
  // Concurrent 401s are single-flighted into a single onUnauthorized() call.
  onUnauthorized: async () => {
    const fresh = await refreshSession();
    if (fresh) sessionStorage.setItem("token", fresh);
    return fresh;
  },
});
```

Behavior:

- Each call sends `Authorization: <authScheme> <token>` when `getAuthToken()` returns a value.
- On a 401, `onUnauthorized()` is invoked **once** even if many requests are in flight; the failing request retries with the new token. A second 401 surfaces as `TransportUnauthorizedError`.
- SSE streams use the same pipeline for the initial POST that opens the stream. Mid-stream token rotation is not supported — re-open the stream after `onUnauthorized()` runs.
- Static headers and the auth header coexist; both are sent on every request.
