# @freebirdai/react — AI integration guide

Instructions for an AI assistant adding FreeBird's React UI to a host app.

## What this is

Headless React bindings: a provider, hooks, and render-prop primitives over `@freebirdai/core-state`. No styles ship here — every primitive stamps `data-freebird-*` attributes for your CSS. For a pre-styled UI, add `@freebirdai/react-tailwind` on top.

Use for any React 18+ app (Next.js, Vite, CRA). The server half is `@freebirdai/server` — wire it first.

## Install

```bash
pnpm add @freebirdai/react @freebirdai/core
```

## Minimal integration

1. Create a client registry (ids MUST match the server registry) and wrap the app:

```tsx
// lib/freebird.client.tsx
"use client"; // Next.js App Router only
import { FreeBirdProvider, createComponentRegistry } from "@freebirdai/react";
import type { ReactNode } from "react";
import { RevenueChart } from "@/components/RevenueChart";

export const registry = createComponentRegistry<ReactNode>();
registry.register({
  id: "revenueChart",                       // same id as server side
  title: "Revenue",
  description: "30-day revenue",
  grid: { minW: 4, minH: 3, maxW: 12, defaultAspect: "wide" },
  render: (props) => <RevenueChart {...props} />,
});

export const AppFreeBird = ({ children }: { children: ReactNode }) => (
  <FreeBirdProvider registry={registry} /* transport defaults to /freebird */>
    {children}
  </FreeBirdProvider>
);
```

2. Compose the UI:

```tsx
import { ChatPanel, DynamicGrid, useSession } from "@freebirdai/react";

function Chrome() {
  useSession({ autoCreate: true });
  return (
    <>
      <DynamicGrid />
      <ChatPanel.Root>
        <ChatPanel.Messages>
          {({ messages, streamingText }) => (
            <>
              {messages.map((m) => <ChatPanel.Message key={m.id} message={m} />)}
              {streamingText && <div>{streamingText}</div>}
            </>
          )}
        </ChatPanel.Messages>
        <ChatPanel.Form>
          <ChatPanel.Input placeholder="Ask anything..." />
          <ChatPanel.Submit>Send</ChatPanel.Submit>
        </ChatPanel.Form>
      </ChatPanel.Root>
    </>
  );
}
```

3. If using actions, scope them per page and add the confirmation UI:

```tsx
const fb = useFreeBird();
useEffect(() => {
  fb.setActiveComponentIds(["settings"]);
  return () => fb.setActiveComponentIds([]);
}, [fb]);

<ActionPreview hideWhileExecuting>
  {({ pending, phase, error, confirm, cancel, pause }) => (/* your dialog */)}
</ActionPreview>
```

`<ActionPreview />` with no children renders a minimal unstyled fallback dialog.

## Key APIs

- Hooks: `useFreeBird`, `useSession`, `useChat`, `useLayout`, `useCustomTabs`, `useActionState`, `useActionJournal`, `useActionEvents`
- Components: `ChatPanel.Root/Messages/Message/Form/Input/Submit/Citations`, `DynamicGrid`, `LockToggle`, `InfoTrigger`, `CustomTabBar.*`, `ActionPreview`, `ActionJournal`, `FreeBirdNavLinks`
- Provider props: `registry`, `transport` (from `createFetchTransport` for custom baseUrl/auth), initial state
- Re-exported types: `ActionDefinition`, `ActionState`, `ActionRecord`, `PendingAction`, `ActionEvent`, `ComponentCitation`

## Works with

- `@freebirdai/server` — mount at `/freebird` (the transport default) or pass a custom transport.
- `@freebirdai/react-tailwind` — pre-styled versions of these components.
- `@freebirdai/core-state` — `createFetchTransport({ baseUrl, getAuthToken, onUnauthorized })` for authenticated apps.

## Common pitfalls

- **Client/server id drift** → the client and server registries must register the same component ids; use `freebird check` (create-freebird) or a shared ids module to enforce.
- **Next.js: provider in a Server Component** → the provider and registry file need `"use client"`.
- **Chat resets on route change** → keep `FreeBirdProvider` (and the ChatPanel) mounted in a layout above your routes.
- **Actions never offered** → `setActiveComponentIds` was never called with the relevant component ids (or was cleared by an unmount).
- **Citations chips don't navigate** → pass `onCitationNavigate` to `ChatPanel.Citations` to route via your router; default is `location.assign`.

## Verify

Run the app, send "show me revenue" in the chat, and confirm: SSE streams into the panel, a layout appears in `DynamicGrid`, and no console errors. `examples/next-starter` in the FreeBird repo is the reference implementation.
