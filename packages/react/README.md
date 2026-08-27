# @freebirdai/react

React bindings for [FreeBird](../../README.md). Ships headless primitives and hooks that talk to `@freebirdai/server` over HTTP+SSE.

## Install

```bash
pnpm add @freebirdai/react @freebirdai/core
```

## Quick start

```tsx
import { FreeBirdProvider, ChatPanel, DynamicGrid, LockToggle, InfoTrigger, useSession, createComponentRegistry } from "@freebirdai/react";

const registry = createComponentRegistry<React.ReactNode>();
registry.register({
  id: "revenueChart",
  title: "Revenue",
  description: "30-day revenue",
  grid: { minW: 4, minH: 3, maxW: 12, defaultAspect: "wide" },
  render: (props) => <RevenueChart {...props} />,
});

function App() {
  return (
    <FreeBirdProvider registry={registry}>
      <Chrome />
    </FreeBirdProvider>
  );
}

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

## What's headless and what's not

All visual decisions are yours. Every primitive stamps `data-freebird-*` attributes you can hook CSS onto. For a ready-made look, install [`@freebirdai/react-tailwind`](../react-tailwind).

## Hooks

| Hook | Purpose |
|---|---|
| `useFreeBird()` | Raw context (registry, transport, current state). |
| `useSession()` | Manage the active chat session id. |
| `useChat()` | Stream messages, auto-handle `freebird:explain`. |
| `useLayout()` | Read/modify the live `LayoutPlan`, toggle locks. |
| `useCustomTabs()` | Save, load, list, delete custom tabs. |
| `useActionState()` | Active action snapshot + control fns (confirm/cancel/pause/mergeArgs). |
| `useActionJournal()` | Filterable journal records + resume / discard. |
| `useActionEvents(fn)` | Subscribe to audit events. |

## Actions

> **When to read this:** you want the chat to *do* things (toggle a
> setting, save a value) on the user's behalf. For the full how-to
> read [`/ACTIONS.md`](../../ACTIONS.md); this section is the React-only
> cheat sheet.

### Symbols covered

- `useActionState`, `useActionJournal`, `useActionEvents` hooks.
- `<ActionPreview>` — render-prop confirmation UI.
- `<ActionJournal>` — render-prop paused/completed history.
- Re-exported types: `ActionDefinition`, `ActionState`, `ActionRecord`,
  `PendingAction`, `ConfirmationPolicy`, `PreviewStrategy`, `ActionEvent`.

### Tell FreeBird which components are active

Actions are only offered for components currently on screen. Set the list
on mount; clear it on unmount.

```tsx
const fb = useFreeBird();
useEffect(() => {
  fb.setActiveComponentIds(["settings", "profile"]);
  return () => fb.setActiveComponentIds([]);
}, [fb]);
```

### Confirm before applying

`<ActionPreview>` is render-prop based. Render with no children for the
default unstyled fallback.

```tsx
import { ActionPreview } from "@freebirdai/react";

<ActionPreview hideWhileExecuting>
  {({ pending, phase, error, confirm, cancel, pause }) => (
    <Dialog open>
      <h2>{pending.label ?? `${pending.componentId}:${pending.actionId}`}</h2>
      <pre>{JSON.stringify(pending.args, null, 2)}</pre>
      {error ? <Alert>{error}</Alert> : null}
      <button onClick={() => confirm()} disabled={phase === "executing"}>
        Apply
      </button>
      <button onClick={() => cancel("user")}>Cancel</button>
      <button onClick={() => pause()}>Pause</button>
    </Dialog>
  )}
</ActionPreview>
```

### Show paused / completed history

```tsx
import { ActionJournal } from "@freebirdai/react";

<ActionJournal status="paused">
  {({ records, resume, discard }) => (
    <ul>
      {records.map((r) => (
        <li key={r.id}>
          {r.label ?? `${r.componentId}:${r.actionId}`}
          <button onClick={() => resume(r.id)}>Resume</button>
          <button onClick={() => discard(r.id)}>×</button>
        </li>
      ))}
    </ul>
  )}
</ActionJournal>
```

### Audit / undo

The journal is in-memory. Persist what you care about by listening:

```tsx
import { useActionEvents } from "@freebirdai/react";

useActionEvents((e) => {
  if (e.kind === "action.executed") {
    myUndoToast.show({
      label: e.record.label,
      before: e.before,
      changed: e.changed,
    });
  }
});
```

See [`/ACTIONS.md`](../../ACTIONS.md) for the full event list and the
server-side `onActionEvent` hook.
