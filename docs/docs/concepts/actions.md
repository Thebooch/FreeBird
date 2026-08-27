# Actions

The action layer lets the chat *do* things on the user's behalf — safely. You declare Zod-typed actions on registered components; the LLM collects arguments in conversation (slot-filling), shows a preview, and executes only after confirmation. Every execution is validated, authorized, and auditable.

> The complete, always-current deep dive lives in the repo:
> [ACTIONS.md](https://github.com/Thebooch/FreeBird/blob/main/ACTIONS.md).
> This page covers the model and the 4-step integration.

## The 4 steps

```text
1. Define an action on a registered component (Zod schema + handler).
2. Tell FreeBird which components are "active" on the current page.
3. Drop in <ActionPreview /> for the confirm-before-apply UI.
4. (Optional) Listen to ActionEvents for audit / undo / persistence.
```

## 1. Define the action

Actions live on `ComponentDefinition.actions[]`:

```ts
import { z } from "zod";
import { createComponentRegistry } from "@freebirdai/core";

export const registry = createComponentRegistry();

registry.register({
  id: "settings",
  title: "Settings",
  description: "User preferences panel",
  grid: { minW: 4, minH: 3 },
  actions: [
    {
      id: "set_theme",
      description: "Set the app theme.",
      schema: z.object({ theme: z.enum(["light", "dark", "system"]) }),
      // Optional: capture the "before" snapshot for undo/diff workflows.
      readCurrent: async (_args, ctx) => myDb.getUserPrefs(ctx.auth.userId),
      handler: async (args, ctx) => {
        await myDb.updateUserPrefs(ctx.auth.userId, { theme: args.theme });
        return { theme: args.theme };
      },
      requiresConfirmation: "preview", // "none" | "preview" | "strict"
      previewStrategy: "component",     // "text" | "component" | { component }
    },
  ],
});
```

Key fields: `schema` drives slot-filling ("missing fields") and gates confirmation; `handler` receives validated args plus `ActionContext { auth, sessionId }`; `readCurrent` captures the before-state for the journal; `authorize` is the server-side permission gate (below).

## 2. Scope to active components

The chat harness only offers actions for components currently on screen — the LLM can't invoke things the user can't see:

```tsx
// React — Vue's useFreeBird() and Angular's FreeBirdService expose the same call
const fb = useFreeBird();
useEffect(() => {
  fb.setActiveComponentIds(["settings", "profile"]);
  return () => fb.setActiveComponentIds([]);
}, [fb]);
```

Passing an empty array (or omitting) exposes *every* registered action — that's what enables cross-page navigation actions on embed sites.

## 3. Confirmation UI

`<ActionPreview />` is headless — bring your own styles, or render it with no children for a minimal default dialog with stable `data-freebird-action-*` attributes:

```tsx
import { ActionPreview } from "@freebirdai/react";

<ActionPreview hideWhileExecuting>
  {({ pending, phase, error, confirm, cancel, pause }) => (
    <Dialog open>
      <DialogTitle>{pending.label ?? `${pending.componentId}:${pending.actionId}`}</DialogTitle>
      <pre>{JSON.stringify(pending.args, null, 2)}</pre>
      {error ? <Alert>{error}</Alert> : null}
      <Button onClick={() => confirm()} disabled={phase === "executing"}>Apply</Button>
      <Button onClick={() => cancel("user")}>Cancel</Button>
      <Button onClick={() => pause()}>Pause</Button>
    </Dialog>
  )}
</ActionPreview>
```

The same component exists in [Vue](../frameworks/vue.md#actions) and [Angular](../frameworks/angular.md#actions).

## 4. Audit, undo, persistence

The journal of action records is in-memory by design — persistence is a host concern. Subscribe to the audit stream on either side:

- **Client:** `useActionEvents((e) => …)` — `action.executed` events carry `before` (from `readCurrent`) and `changed` keys, enough to power undo toasts.
- **Server:** the `onActionEvent` handler dep receives every execution/failure/cancellation/denial, with `source: "http" | "mcp" | "chat"`.

## Securing actions: `authorize`

`authorize(args, ctx)` runs **server-side** after Zod validation and before `readCurrent`/`handler` — on every path that can execute an action (HTTP confirm, chat auto-apply, MCP). Denials return 403 (or a custom status) and emit `action.unauthorized`:

```ts
authorize: async (args, ctx) => ctx.auth.role === "admin",
```

`setActiveComponentIds` is a UX scoping mechanism, **not** a security boundary — `authorize` is.

## Pause & resume

Users can pause a half-configured action ("do that later") and resume it from the journal. `ActionJournal` components render paused/completed history with `resume`/`discard` affordances; resuming re-enters slot-filling with the stashed args.

## Harness UX knobs

Three `ChatEngine` options shape a turn (details in [ACTIONS.md](https://github.com/Thebooch/FreeBird/blob/main/ACTIONS.md#harness-ux-knobs-chat-engine)):

- `harnessArgsMode: "typed" | "loose"` — whether `start_action` gets the pending action's real Zod schema (default) or a loose object for providers that struggle with discriminated unions.
- `maxToolSteps` (default 3) — auto-loop budget: after a tool-only turn lands in `collecting`/`awaiting_confirmation`, the engine runs another LLM step in the same stream so the model can ask the missing question.
- `fallbackToolOnlyPhrase` — host-supplied copy for a turn that would otherwise get the engine's generic summary. Every turn persists a visible assistant message either way.

## Server endpoints

`@freebirdai/server` adds these automatically alongside the chat routes; the default `FetchTransport` already calls them:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/actions/confirm` | Validate args, run `authorize`, `readCurrent`, `handler`, emit audit |
| POST | `/actions/cancel` | Mark the journal record terminated, emit `action.cancelled` |
| POST | `/actions/update-args` | Re-validate slot-filled args; return updated `missing[]` |

## External agents (MCP)

`@freebirdai/mcp` exposes the same actions to external agents through the same `runAction()` pipeline — see [MCP server](../tooling/mcp.md). Remember: `authorize` is the boundary there too.
