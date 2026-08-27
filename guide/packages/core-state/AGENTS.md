# @freebirdai/core-state — AI integration guide

Instructions for an AI assistant using FreeBird's framework-agnostic client store.

## What this is

The client state store + HTTP/SSE transport all FreeBird UI bindings share. `FreeBirdStore` holds session/layout/tabs/messages/streaming/action/support state with a minimal pub/sub; `FetchTransport` talks to `@freebirdai/server`.

**Do not install directly** if the host app uses React, Vue, or Angular — the bindings (`@freebirdai/react`, `@freebirdai/vue`, `@freebirdai/angular`) wrap this already. Install directly only for a custom framework adapter or fully bespoke UI (vanilla JS, Svelte, etc.).

## Install

```bash
pnpm add @freebirdai/core-state @freebirdai/core
```

## Minimal integration (custom adapter)

```ts
import { FreeBirdStore, createFetchTransport } from "@freebirdai/core-state";

const store = new FreeBirdStore(
  createFetchTransport({ baseUrl: "/freebird" }),
);

// 1. Mirror state into your reactivity system — subscribe returns unsubscribe.
const unsubscribe = store.subscribe((state) => {
  // state: { sessionId, layout, tabs, messages, streaming, streamingText,
  //          latestReferences, actionState, activeComponentIds,
  //          lastLlmUsage, supportState }
  render(state);
});

// 2. Create/attach a session, then chat.
const session = await store.transport.createSession({ title: "Chat" });
store.setSessionId(session.id);
store.send("Hello!");
```

Bridge per framework: React `useSyncExternalStore(store.subscribe, store.getSnapshot)`; Vue `ref()` updated in `subscribe`; Angular `signal()` in an `@Injectable`.

## Key APIs

- `FreeBirdStore` — `send(text)`, `explain(componentId)`, `abort()`, `setSessionId`, `setActiveComponentIds`, `refreshTabs`, `toggleLock`, `getLockedCells`, `subscribe`, `getState`/`getSnapshot`
- Action layer — `confirmAction`, `cancelAction`, `pauseAction`, `resumeAction`, `discardActionRecord`, `mergeActionArgs`, `onActionEvent(fn)`
- Support/tickets — support state machine + `onSupportEvent(fn)`
- `createFetchTransport({ baseUrl, headers?, getAuthToken?, authScheme?, onUnauthorized? })`
- `FreeBirdTransport` — implement this interface for a non-HTTP transport

## Authenticated transport

```ts
const transport = createFetchTransport({
  baseUrl: "/freebird",
  getAuthToken: () => sessionStorage.getItem("token"),   // read before every request
  authScheme: "Bearer",                                   // default
  onUnauthorized: async () => {                           // single-flighted on 401
    const fresh = await refreshSession();
    if (fresh) sessionStorage.setItem("token", fresh);
    return fresh;                                         // null = give up
  },
});
```

A second consecutive 401 surfaces as `TransportUnauthorizedError`. Mid-stream token rotation is not supported — re-open the stream after refresh.

## Works with

- `@freebirdai/server` — the transport's wire counterpart; mount it at `baseUrl`.
- `@freebirdai/react` / `@freebirdai/vue` / `@freebirdai/angular` — prefer these instead of direct use.

## Common pitfalls

- **UI never updates** → you read `getState()` once instead of subscribing; every mutation produces a fresh state reference delivered via `subscribe`.
- **`send()` does nothing** → no `sessionId` set; create a session first.
- **Duplicate messages after reconnect** → `addMessage` upserts by id — always pass server-issued message ids through unchanged.
- **Actions stuck in `collecting`** → the harness needs `activeComponentIds` synced via `setActiveComponentIds` on page/component changes.

## Verify

With `@freebirdai/server` running: create a session, `store.send("hello")`, and assert your `subscribe` callback eventually sees `streaming: false` with a new assistant message in `state.messages`.
