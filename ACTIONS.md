# ACTIONS.md — adding LLM-driven actions to your FreeBird app

> **When to read this:** you want the chat to *do* things (toggle a
> setting, save a value, switch a mode) on the user's behalf, not just
> render components. This is the end-to-end how-to.
>
> **Prerequisites:** a working FreeBird install — see
> [`GETTING_STARTED.md`](GETTING_STARTED.md). React, Vue, and Angular all
> have first-class action bindings; this guide shows React for brevity
> and notes framework deltas at the end.

## What you'll build in 4 steps

```text
1. Define an action on a registered component (Zod schema + handler).
2. Tell FreeBird which components are "active" on the current page.
3. Drop in <ActionPreview /> for the confirm-before-apply UI.
4. (Optional) Listen to ActionEvents for audit / undo / persistence.
```

## Step 1 — Define the action

Actions live on `ComponentDefinition.actions[]`. They are typed with Zod
so the LLM extracts arguments safely and the server validates again
before running.

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
      // Optional: capture the "before" snapshot so the journal can
      // power undo/diff workflows on your side.
      readCurrent: async (_args, ctx) => {
        return await myDb.getUserPrefs(ctx.auth.userId);
      },
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

### Field reference

| Field                   | Required | Notes                                                                                          |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `id`                    | yes      | Unique within the component. The LLM addresses actions as `componentId:actionId`.              |
| `description`           | yes      | One-sentence summary the LLM reads when choosing which action to start.                        |
| `schema`                | yes      | Zod schema. Used to drive slot-fill ("missing fields") and to gate confirmation.               |
| `handler`               | yes      | The mutation. Receives validated `args` and `ActionContext { auth, sessionId }`.               |
| `authorize`             | no       | Server-side permission gate. See [Securing actions](#securing-actions-authorize) below.        |
| `readCurrent`           | no       | Returns the "before" snapshot. Stored in the journal entry's `before` for audit / undo.        |
| `requiresConfirmation`  | no       | `"preview"` (default), `"none"` (auto-apply), `"strict"` (reserved for future re-prompt flow). |
| `previewStrategy`       | no       | How `<ActionPreview />` should render: `"text"`, `"component"` (default), or a custom id.      |

## Step 2 — Tell FreeBird which components are active

The harness only offers actions for components currently on screen. This
prevents the LLM from invoking things the user can't see.

```tsx
// React
import { useFreeBird } from "@freebirdai/react";

const Page = () => {
  const fb = useFreeBird();
  useEffect(() => {
    fb.setActiveComponentIds(["settings", "profile"]);
    return () => fb.setActiveComponentIds([]);
  }, [fb]);
  // …
};
```

> Vue exposes `fb.setActiveComponentIds(ids)` from `useFreeBird()`.
> Angular exposes the same on `FreeBirdService`.

## Step 3 — Drop in the confirmation UI

Headless preview component; bring your own styles.

```tsx
import { ActionPreview } from "@freebirdai/react";

<ActionPreview hideWhileExecuting>
  {({ pending, phase, error, confirm, cancel, pause }) => (
    <Dialog open>
      <DialogTitle>{pending.label ?? `${pending.componentId}:${pending.actionId}`}</DialogTitle>
      <pre>{JSON.stringify(pending.args, null, 2)}</pre>
      {error ? <Alert>{error}</Alert> : null}
      <Button onClick={() => confirm()} disabled={phase === "executing"}>
        Apply
      </Button>
      <Button onClick={() => cancel("user")}>Cancel</Button>
      <Button onClick={() => pause()}>Pause</Button>
    </Dialog>
  )}
</ActionPreview>
```

If you want a built-in default UI, render `<ActionPreview />` with no
children — it produces a minimal unstyled dialog with stable
`data-freebird-action-*` attributes you can target via CSS.

## Step 4 — (Optional) Audit, undo, persistence

The journal is in-memory by design — FreeBird never writes it for you.
Instead, every state change emits an `ActionEvent`. Subscribe and wire
your own persistence / undo / analytics.

```tsx
import { useActionEvents } from "@freebirdai/react";

useActionEvents((event) => {
  switch (event.kind) {
    case "action.executed":
      myAuditLog.write({
        recordId: event.recordId,
        before: event.before,
        changed: event.changed,
        result: event.result,
      });
      break;
    case "action.failed":
      reportError(event.error);
      break;
    case "journal.recorded":
    case "journal.discarded":
      // optional persistence of paused/completed records
      break;
  }
});
```

The **server** also emits its own audit hook so you can log securely:

```ts
import { createFreeBirdRouter } from "@freebirdai/server/express";

app.use(
  "/freebird",
  createFreeBirdRouter({
    chat,
    db,
    registry,
    onActionEvent: async (event, auth) => {
      // event.kind ∈ "action.executed" | "action.failed" | "action.cancelled"
      await myAudit.append({ ...event, userId: auth.userId });
    },
  }),
);
```

## Securing actions (`authorize`)

`setActiveComponentIds` controls what the LLM can *see*, not what the
host can *do*. A determined caller can hit `POST /freebird/actions/confirm`
directly. Use `authorize` to enforce row-level / role-based permissions
on every action.

```ts
{
  id: "set_channel_topic",
  description: "Update the topic for a channel.",
  schema: z.object({
    channelId: z.string(),
    topic: z.string().min(1),
  }),
  // Runs server-side, after Zod validation, before readCurrent / handler.
  authorize: async (args, ctx) => {
    if (ctx.auth.role === "admin") return true;
    return await canEditChannel(ctx.auth.userId, args.channelId);
  },
  handler: async (args) => myDb.setTopic(args.channelId, args.topic),
}
```

Return shapes:

| Return                                 | Effect                                                          |
| -------------------------------------- | --------------------------------------------------------------- |
| `true`                                 | Proceed to `readCurrent` / `handler`.                           |
| `false`                                | Reject with **HTTP 403** + `action.unauthorized` server event.  |
| `{ ok: false, reason, status? }`       | Same, with custom reason / status (default 403).                |
| Throws                                 | Treated as a **500** denial (fail-closed).                      |

### Where it runs

- `POST /actions/confirm` — gates the actual mutation. Always runs.
- `POST /actions/update-args` — gates slot-fill rounds, **only after the
  payload fully validates**. Partial rounds (still missing fields) skip
  authorize so they don't leak whether a completed call would be allowed.

### Audit

Every denial fires `onActionEvent({ kind: "action.unauthorized", … })`
on the server with the same `(args, recordId, sessionId, componentId, actionId, reason)`
shape as other action events — log it like any other audit row.

## Pause & resume (sequence management)

The action machine has a built-in **journal**: every action records an
entry with status `in_progress` → `completed` / `terminated` / `paused`
/ `failed`. The LLM can pause the current action when the user pivots,
and resume it later via natural-language cues ("let's go back to
configuring my digest").

You don't have to do anything for this to work — the LLM gets
`pause_action` / `resume_action` tools automatically based on phase. To
*display* paused records to the user, drop in `<ActionJournal />`:

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

## What the LLM sees per phase

The harness gates which tools are exposed. You don't need to prompt for
this — the system messages and tools are injected automatically.

| Phase                  | Tools exposed                                                      |
| ---------------------- | ------------------------------------------------------------------ |
| `idle` / `error`       | `start_action`, `resume_action` (only if a paused record exists)   |
| `collecting`           | `update_action_args`, `request_clarification`, `cancel_action`, `pause_action` |
| `awaiting_confirmation`| `cancel_action`, `pause_action` (preview is shown to the user)     |
| `executing`            | none                                                               |

## Harness UX knobs (chat engine)

Three options on `createChatEngine` shape how the harness drives a single
turn. All three default to the most ubiquitous behaviour — set them to
opt out or out-of-the-box specialise.

```ts
import { createChatEngine } from "@freebirdai/core";

const chat = createChatEngine({
  db, llm, registry, knowledge,

  // 1. Typed args (default: "typed")
  harnessArgsMode: "typed",

  // 2. Auto-loop (default: 3 — set to 1 to disable)
  maxToolSteps: 3,

  // 3. Tool-only fallback phrase (default: null — emit a placeholder event)
  fallbackToolOnlyPhrase: null,
});
```

### 1. `harnessArgsMode: "typed" | "loose"`

In `"typed"` mode (default), `start_action` is shaped as a discriminated
union — one variant per registered action ref, each with the action's
own Zod schema for `args`. Likewise, `update_action_args` is scoped to
the **pending** action's schema. The LLM no longer has to remember
"label vs args" or "what fields does this action take" — its tool schema
*is* the action's schema.

| Mode      | `start_action.args`                                              | `update_action_args.args`           |
| --------- | ---------------------------------------------------------------- | ----------------------------------- |
| `"typed"` | `discriminatedUnion("action", per-ref objects with .partial())`  | `pending.schema.partial()`          |
| `"loose"` | `z.record(z.unknown())`                                           | `z.record(z.unknown())`             |

Use `"loose"` only if your provider adapter struggles to convert
discriminated unions to its tool-schema format.

### 2. `maxToolSteps: number` (default `3`)

If a turn produces only tool calls (no user-visible text) and lands in
`collecting` or `awaiting_confirmation`, the engine runs another LLM
completion in the same SSE stream so the model can ask the missing
question or summarize the preview — without forcing the user to send a
"hello?" follow-up.

The loop only runs after a *progress-making* transition
(`action_started`, `action_args_updated`, `action_resumed`).
`request_clarification`, `cancel_action`, and `pause_action` are
deliberate "wait for the user" turns and never auto-loop. Capped at
`maxToolSteps` inner LLM calls per `send()`. Set to `1` to disable.

### 3. `fallbackToolOnlyPhrase: string | (ctx) => string | null | null`

Every turn persists a visible assistant message. When the LLM only fired
tool calls and produced no prose (even after the auto-loop), the engine
fills the bubble from a fallback chain; this option lets the host take
over the wording:

```ts
// (a) Default — the engine's built-in phase summary fills the bubble
//     ("I'm working on X. I still need: …", "I've prepared X. Review …").
fallbackToolOnlyPhrase: null

// (b) Stamp a verbatim phrase. Streamed as text_delta and persisted.
fallbackToolOnlyPhrase: "Working on that…"

// (c) Per-context phrase. Returning null falls back to the built-in summary.
fallbackToolOnlyPhrase: ({ phase, pending }) =>
  phase === "awaiting_confirmation" ? "Ready to apply." : null
```

Precedence: a summary of executed tool results (which carries real
information, e.g. an error) wins over the host phrase; the host phrase
wins over the engine's generic summaries and suppresses the extra
LLM summary call that `requireAssistantReply` would otherwise run.

## Server endpoints (added automatically)

`@freebirdai/server` adds these alongside the existing chat routes:

| Method | Path                       | Purpose                                                                                |
| ------ | -------------------------- | -------------------------------------------------------------------------------------- |
| POST   | `/actions/confirm`         | Validate `args`, run `authorize`, call `readCurrent`, run `handler`, emit audit.        |
| POST   | `/actions/cancel`          | Mark journal record `terminated`, emit `action.cancelled`.                              |
| POST   | `/actions/update-args`     | Re-validate slot-filled args; if complete, run `authorize`; return updated `missing[]`. |

The default `FetchTransport` already calls these — you don't write fetch
code yourself.

## Framework deltas

| Concept            | React                                  | Vue                                       | Angular                                                        |
| ------------------ | -------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Hook / composable  | `useActionState()`                     | `useActionState()`                        | `inject(FreeBirdService).actionState`                          |
| Journal            | `useActionJournal({ status })`         | `useActionJournal({ status })`            | `inject(FreeBirdService).pausedActions` / `actionJournal`      |
| Confirm UI         | `<ActionPreview>` render-prop          | `<FreeBirdActionPreview>` scoped slot     | `<fb-action-preview><ng-template …>`                           |
| Journal UI         | `<ActionJournal>` render-prop          | `<FreeBirdActionJournal>` scoped slot     | `<fb-action-journal><ng-template …>`                           |
| Audit subscription | `useActionEvents(fn)`                  | `useActionEvents(fn)`                     | `inject(FreeBirdService).onActionEvent(fn)`                    |

## What FreeBird *does not* do

- **Persist the journal.** It's in-memory; your `onActionEvent` hook is
  the persistence boundary.
- **Undo for you.** `before` and `changed` are captured on
  `action.executed`; you decide whether to expose Undo UI.
- **Render a styled preview.** The headless components ship unstyled.
  Use `@freebirdai/react-tailwind` or your own design system for polish.

## MCP (external agents)

`@freebirdai/mcp` is an **opt-in** MCP server — if you don't construct it,
no MCP surface exists. When enabled, agents use the same `runAction()`
pipeline as `POST /actions/confirm`.

| Concern | Behavior |
| ------- | -------- |
| Activation | Host calls `createFreeBirdMcpServer({ registry, mode, getAuthContext })` |
| Access | Global `read-only` \| `read-write` \| `write-only` + per-action `mcp.expose` / `mcp.requireConfirmation` |
| Schema / missing fields | FreeBird-owned via `freebird_prepare_action` → `missing[]` (same as chat harness) |
| Security boundary | `ActionDefinition.authorize` — **not** `setActiveComponentIds` |
| Audit | `onActionEvent` with `source: "mcp"` |

See [`guide/packages/mcp/README.md`](guide/packages/mcp/README.md) for tool reference and setup.

## Where to go next

- Type/contract reference: [`guide/packages/core/src/actions/README.md`](guide/packages/core/src/actions/README.md)
- State machine + journal: [`guide/packages/core-state/src/actions/README.md`](guide/packages/core-state/src/actions/README.md)
- Framework specifics: see the **Actions** section of each framework's
  README.
