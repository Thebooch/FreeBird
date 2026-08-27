# @freebirdai/core-state

Framework-agnostic client state store and HTTP transport for FreeBird.

This package is consumed by the framework-specific bindings:

- [`@freebirdai/react`](../react)
- [`@freebirdai/vue`](../vue)
- [`@freebirdai/angular`](../angular)

You usually do not install this directly unless you are building your own framework adapter.

## Exports

- `FreeBirdStore` — pure TS class holding `sessionId`, `layout`, `tabs`, `messages`, `streaming` state plus the chat/explain streaming logic
- `FetchTransport` / `createFetchTransport` — default HTTP+SSE client talking to `@freebirdai/server`
- `FreeBirdTransport` — the interface a transport must satisfy

## Design

The store uses a minimal pub/sub model (`subscribe(fn)` returns unsubscribe). Each framework adapter bridges this into its own reactivity system once:

| Framework | Binding |
|-----------|---------|
| React     | `useSyncExternalStore` |
| Vue       | `ref()` + `watchEffect` |
| Angular   | `signal()` inside an `@Injectable` |

## Authenticating the transport

`FetchTransport` has first-class hooks for token-based auth so hosts don't have to subclass it.

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

Behaviour:

- Each call sends `Authorization: <authScheme> <token>` when `getAuthToken()` returns a value.
- On a 401, `onUnauthorized()` is invoked **once** even if many requests are in flight; the failing request retries with the new token. A second 401 surfaces as `TransportUnauthorizedError`.
- SSE streams use the same pipeline for the initial POST that opens the stream. Mid-stream rotation is not supported in v1 — the client should re-open the stream after `onUnauthorized()` runs.

Static headers and the auth header coexist; both are sent on every request.
