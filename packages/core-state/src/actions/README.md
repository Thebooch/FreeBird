# `@freebirdai/core-state/actions` — client state machine + audit stream

> **When to read this:** you are extending the action state machine,
> adding a transition, hooking the journal into custom persistence, or
> reasoning about which `ActionEvent`s fire when. If you only need to
> *use* actions in a UI, read [`/ACTIONS.md`](../../../../ACTIONS.md)
> instead.

## Symbols covered

- `ActionState` (re-exported from `@freebirdai/core`) — top-level slice.
- `ActionPhase` — `"idle" | "collecting" | "awaiting_confirmation" | "executing" | "error"`.
- `ActionRecord` — a single journal entry with `before` / `changed` / `result` / `error`.
- `ActionRecordStatus` — `"in_progress" | "paused" | "completed" | "terminated" | "failed"`.
- `PendingAction` — the snapshot of the *active* action.
- `ActionTransition` — discriminated union of all reducer inputs (`./state.ts`).
- `applyTransition(state, t, opts)` — the pure reducer.
- `initialActionState`, `lastPaused`, `pausedRecords`, `deriveMissingFields` — selectors.
- `ActionEvent`, `ActionEventListener` — audit stream types (`./events.ts`).

## Why this lives here

The pure state machine + event types live in `@freebirdai/core-state`
because they're reduced over by:

1. **The client store** (`FreeBirdStore`) — drives the UI.
2. **The server harness** (`buildHarnessTurn`, in `@freebirdai/core`) —
   reads `ActionState` to gate which LLM tools to expose per turn.

Both shapes must agree. The action *types* themselves
(`ActionPhase`, `ActionState`, `ActionRecord`, `PendingAction`) are
defined once in `@freebirdai/core` (`packages/core/src/actions/types.ts`)
and re-exported from this folder so the reducer code reads naturally.

## State diagram

```text
       ┌─ start (missing>0) ──────────────┐
       │                                  ▼
       │                          ┌──────────────┐
       │  cancelled  ◀────────────│  collecting  │──── pause ──▶ idle
       │                          └─────┬────────┘            (record paused)
       │                                │ merge_args (missing=0)
       │                                ▼
       │                       ┌────────────────────────┐
   idle ─┼──────── start ──────▶│ awaiting_confirmation  │── pause ─▶ idle
       │  (missing=0,           └─────┬──────────────────┘            (record paused)
       │   policy=preview)            │ begin_executing
       │                              ▼
       │                       ┌──────────┐
       │                       │ executing │── executed ─▶ idle (record completed)
       │                       └─────┬─────┘── failed   ─▶ error (record failed)
       │
       └─ start (missing=0, policy=none) ─▶ executing ──▶ idle/error
```

`resume(recordId)` moves a `paused` record back into `pending`
(phase=`collecting`) so the LLM can pick up where it left off.

## ActionRecord shape

```ts
interface ActionRecord {
  id: string;                          // matches PendingAction.recordId
  componentId: string;
  actionId: string;
  args: Record<string, unknown>;
  status: ActionRecordStatus;
  startedAt: Date;
  updatedAt: Date;
  finishedAt?: Date;                   // set on completed/terminated/failed
  label?: string;                      // human-friendly summary
  before?: unknown;                    // captured by readCurrent
  changed?: string[];                  // top-level keys that differ
  result?: unknown;                    // returned by handler
  error?: { message: string };         // present when status=failed
}
```

### Auditability fields

`before` and `changed` exist so hosts can build undo / diff UIs without
the action layer making decisions for you:

- `before` is the value `readCurrent` returned **before** `handler` ran.
- `changed` is `diffKeys(before, result ?? args)` — see
  `packages/core/src/actions/diff.ts`.
- Hosts that need richer diffs subscribe to `action.executed` and roll
  their own — both `before` and `args` are on the event payload.

## ActionTransition reference

| Type                     | Pre-conditions                                                 | Effect                                                                          |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `start`                  | `pending == null` (or `phase=error`).                          | Adds new `in_progress` record; phase = `collecting` / `awaiting_confirmation` / `executing` based on `missing` + `requiresConfirmation`. |
| `merge_args`             | pending exists.                                                | Spreads new args; recomputes phase from `missing.length`.                        |
| `ready_for_confirmation` | pending exists.                                                | `phase = "awaiting_confirmation"`. (Used by host that pre-validates.)           |
| `begin_executing`        | pending exists.                                                | `phase = "executing"`.                                                          |
| `executed`               | pending exists.                                                | Record → `completed`; `before`/`changed`/`result` recorded; phase=`idle`.       |
| `failed`                 | pending exists.                                                | Record → `failed`; `error.message` recorded; phase=`error`; `lastError` set.    |
| `cancelled`              | pending exists, OR `phase=error`.                              | Record (if any) → `terminated`; phase=`idle`.                                   |
| `pause`                  | pending exists.                                                | Record → `paused`; pending cleared; phase=`idle`.                                |
| `resume`                 | record exists & is `paused`; no current pending.               | Record → `in_progress`; pending populated; phase=`collecting`.                  |
| `discard_record`         | record id is **not** the active pending.                       | Removes it from journal.                                                        |
| `hydrate_journal`        | always.                                                        | Replaces journal (e.g. on app boot from server-persisted history).              |

Invalid transitions return the unchanged state (referentially equal),
which makes pub/sub subscribers skip render trivially.

## Journal cap (`opts.journalCap`)

`applyTransition` accepts `{ journalCap }` (the store passes its
configured cap, default `50`). When the journal exceeds the cap:

1. Drop the **oldest non-paused** record first (paused = resumable).
2. If everything is paused, drop the oldest one (failsafe).

This keeps the user's resumable conversations alive even after long
runs of audit history.

## ActionEvent stream

`FreeBirdStore.onActionEvent(listener)` returns an unsubscribe. Events
are best-effort — listeners that throw are caught and logged.

| `kind`               | When                                                  | Useful for                                       |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| `action.started`     | `start` accepted.                                     | Logging "user kicked off X".                     |
| `action.args_updated`| `merge_args` accepted (server slot-fill confirmed).   | Telemetry on collection rounds.                  |
| `action.confirmed`   | User clicked confirm in UI; before server executes.   | Optimistic loading states.                       |
| `action.executed`    | Server `handler` returned successfully.               | **Audit logs, undo toasts, downstream caches.**  |
| `action.failed`      | Server threw or validation failed.                    | Error reporting, retry UX.                       |
| `action.cancelled`   | User or LLM cancelled.                                | "Action discarded" UX.                            |
| `action.paused`      | LLM/user paused mid-flow.                             | Showing the paused record in your nav.            |
| `action.resumed`     | A paused record was resumed.                          | "Continuing from where you left off" toasts.      |
| `journal.recorded`   | A new record entered the journal (via start).         | Mirroring journal to your DB.                    |
| `journal.discarded`  | A record was removed via `discard_record`.            | Cleaning up your DB mirror.                       |

## Persistence is a host concern

The journal is **in-memory by design**. If you want cross-session
resume:

```ts
const store = new FreeBirdStore({ transport, registry });

store.onActionEvent(async (event) => {
  switch (event.kind) {
    case "journal.recorded":
    case "action.paused":
    case "action.executed":
    case "action.failed":
      await myDb.upsertActionRecord(event.record);
      break;
    case "journal.discarded":
      await myDb.deleteActionRecord(event.recordId);
      break;
  }
});

// On app boot:
const records = await myDb.loadRecentActionRecords(userId);
store.hydrateJournal(records);
```

## Files in this folder

| File             | Purpose                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `state.ts`       | Pure reducer (`applyTransition`), `initialActionState`, selectors.      |
| `state.test.ts`  | 21 unit tests covering happy paths, rejections, journal cap, selectors. |
| `events.ts`      | `ActionEvent` discriminated union + `ActionEventListener` alias.        |

## Common tasks

- **Add a new transition:** extend `ActionTransition` in `state.ts`,
  add a `case` to `applyTransition`, write at least one test in
  `state.test.ts`. If it should surface to listeners, also emit a new
  `ActionEvent` from the store (`packages/core-state/src/store.ts`).
- **Persist the journal:** subscribe to `onActionEvent` and call
  `hydrateJournal` on boot. Don't try to mutate `state.actionState`
  directly — go through `applyActionTransition`.
- **Drive a custom UI from journal:** prefer the framework hooks
  (`useActionJournal` / `inject(FreeBirdService).actionJournal`) over
  reading the raw store; they handle reactivity and filtering.
