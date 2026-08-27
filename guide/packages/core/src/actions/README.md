# `@freebirdai/core/actions` — server-side action contract

> **When to read this:** you're defining actions on the server (the
> `ActionDefinition` shape), or you're working on the harness that drives
> LLM tool selection. Skip this if you only need to wire up a UI — read
> [`/ACTIONS.md`](../../../../ACTIONS.md) instead.
>
> **Audience:** human contributors and AI agents touching server-side
> action types, harness gating, or server-side validation utilities.

## Symbols covered

- `ActionDefinition` — the per-component action shape (`packages/core/src/types.ts`).
- `ConfirmationPolicy` — `"none" | "preview" | "strict"`.
- `PreviewStrategy` — `"text" | "component" | { component: string }`.
- `ActionContext<TAuth>` — `{ auth, sessionId }` passed to `readCurrent`/`handler`.
- `buildHarnessTurn(input)` — phase-gated LLM tool builder (`./harness.ts`).
- `validateActionArgs(schema, raw)` — Zod adapter producing `{ ok, data, missing, error }` (`./diff.ts`).
- `diffKeys(before, after)` — shallow object diff used to fill `ActionRecord.changed` (`./diff.ts`).
- Action types (`ActionPhase`, `ActionState`, `ActionRecord`, …) — defined in `./types.ts`.

## ActionDefinition shape

```ts
interface ActionDefinition<TArgs, TResult, TAuth> {
  id: string;                                      // e.g. "set_theme"
  description: string;                             // one-sentence summary for LLM
  schema: z.ZodType<TArgs>;                        // arg validation
  authorize?:   (args, ctx) =>                     // server-side permission gate
    | boolean
    | { ok: false; reason?: string; status?: number }
    | Promise<…>;
  readCurrent?: (args, ctx) => Promise<unknown>;   // "before" snapshot
  handler:      (args, ctx) => Promise<TResult>;   // the mutation
  requiresConfirmation?: ConfirmationPolicy;       // default "preview"
  previewStrategy?:      PreviewStrategy;          // default "component"
}
```

### `authorize` contract

- Runs **server-side** in `handleConfirmAction` after Zod validation
  passes and before `readCurrent` / `handler`. Also runs in
  `handleUpdateActionArgs`, but only when the slot-fill round produced
  a fully-valid payload (so partial rounds don't leak whether a
  completed call would be allowed).
- Return `true` to proceed. Return `false` or
  `{ ok: false, reason?, status? }` to deny — the request returns
  HTTP 403 (or `status`) and the server emits an `action.unauthorized`
  event for audit.
- Throwing is treated as a **500 denial** (fail-closed). Do permission
  lookups inside; never assume the function is allowed to throw to mean
  "allow".
- `authorize` runs on `requiresConfirmation: "none"` actions too — it's
  a security boundary, not a UX boundary.

### `readCurrent` contract

- Called **before** the handler runs, on the server, with the same
  validated `args` and `ctx`.
- The returned value is stored in `ActionRecord.before` and emitted on
  `action.executed` so hosts can build undo/diff UIs without re-querying.
- It must be side-effect-free.
- If it throws, the action is failed *before* any mutation runs — treat
  this as the safe default.

### `handler` contract

- Receives `args: TArgs` (already passed Zod), `ctx: ActionContext<TAuth>`.
- Whatever you return is included on `action.executed` for clients that
  want to show the new state without re-fetching.
- Throwing surfaces as a `failed` transition + `action.failed` event;
  the client returns to the `error` phase.

### `requiresConfirmation`

| Value       | Behavior                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `"none"`    | Auto-execute as soon as `args` are complete. Use only for low-risk reads or reversible toggles.                  |
| `"preview"` | (default) Pause in `awaiting_confirmation`; client renders `<ActionPreview />`; user clicks confirm.             |
| `"strict"`  | Reserved. Same as `preview` in v1 but signals to hosts that you may want extra friction (e.g. re-prompt for OK). |

### `previewStrategy`

Surfaced to the client so it can pick how to render the preview.
`<ActionPreview />` ignores this for the default fallback (it always
shows the JSON dump), but custom render-prop bodies can branch on it:

```tsx
<ActionPreview>
  {({ pending, … }) =>
    pending.previewStrategy === "text"
      ? <p>{summarize(pending)}</p>
      : <FormPreview {...pending} />
  }
</ActionPreview>
```

## `buildHarnessTurn(input)`

Pure function. Given the registry, the current `ActionState`, and a list
of currently active component ids, returns:

```ts
interface HarnessTurn {
  tools: Record<string, LlmTool>; // injected into the LLM call
  systemMessages: LlmMessage[];   // injected after the global system prompt
  phase: ActionPhase;             // echoed for logging
  activeActionIds: string[];      // "componentId:actionId" pairs
}
```

### Phase → tools

| Phase                  | Tools                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `idle` / `error`       | `start_action` (if any active component has actions), `resume_action` (if paused exists). |
| `collecting`           | `update_action_args`, `request_clarification`, `cancel_action`, `pause_action`.        |
| `awaiting_confirmation`| `cancel_action`, `pause_action`.                                                       |
| `executing`            | (none — the user can't change a running action.)                                       |

### Tool schemas

All tools use Zod schemas defined in [`harness.ts`](./harness.ts). Notable details:

- `start_action.action` is a `z.enum([...])` of valid `componentId:actionId`
  refs **filtered** by `activeComponentIds`. The LLM cannot start an
  action for a component not on screen.
- `start_action.args` is **schema-aware**: in the default `"typed"` mode
  the harness emits a `z.discriminatedUnion("action", [...])` with one
  variant per ref, and each variant's `args` is the action's own
  `z.object(...).partial()`. In `"loose"` mode it falls back to
  `z.record(z.unknown())`. See `HarnessArgsMode` below.
- `update_action_args.args` mirrors the same opt-in: in `"typed"` mode
  it uses the **pending** action's `partial()` schema; in `"loose"`
  mode, `z.record(z.unknown())`.
- `resume_action.recordId` is also a `z.enum([...])` of paused journal
  ids so the LLM can't fabricate a record id.

### `HarnessArgsMode`

```ts
type HarnessArgsMode = "typed" | "loose";

buildHarnessTurn({
  registry,
  actionState,
  activeComponentIds,
  argsMode: "typed", // default
});
```

Plumbed all the way to `createChatEngine({ harnessArgsMode })`. Use
`"loose"` only if your provider adapter can't represent the typed
discriminated union. Per-action schemas that aren't `z.object` (e.g. a
plain `z.string()`) are passed through as `args: schema.optional()` —
the discriminated-union scaffold still wraps them.

### System messages

The harness injects short, phase-specific guidance after the global
system prompt:

- `idle` with paused records: "If the user references them with phrases
  like 'go back to'… call `resume_action` with the matching id."
- `collecting`: lists collected fields, names missing fields, and tells
  the LLM to **reply with a brief plain-text question** for the missing
  fields. `update_action_args` is reserved for the next turn (after the
  user answers).
- `awaiting_confirmation`: tells the LLM to summarize and wait — the
  user clicks confirm; no tool call needed.

The chat engine adds an additional inner-step system hint when it
auto-loops after a tool-only `start_action` (see
[`chat/engine.ts`](../chat/engine.ts) → `renderInnerStepHint`), pushing
the model to produce the question/summary as plain text rather than
re-emitting tool calls.

## `validateActionArgs(schema, raw)`

```ts
interface ValidateArgsResult<T> {
  ok: boolean;
  data?: T;          // present when ok
  missing: string[]; // dotted paths to undefined-required fields
  error?: string;    // human-readable for non-missing failures
}
```

Used by the server (`/actions/confirm`, `/actions/update-args`) and the
harness to distinguish "ask the user for more" (`missing`) from "this
input is wrong" (`error`). The state machine treats `missing` as a
prompt to stay in `collecting`; `error` typically goes to `failed`.

## `diffKeys(before, after)`

Shallow per-key diff used to populate `ActionRecord.changed` after a
successful execution. Intentionally shallow:

- For nested structures, write your own diff in `onActionEvent` or
  shape `readCurrent`'s output to mirror the action's argument shape so
  the shallow diff is meaningful.
- Returns `["__root__"]` when comparing two non-objects that aren't
  `Object.is`-equal.

## Files in this folder

| File           | Purpose                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| `types.ts`     | `ActionPhase`, `ActionRecordStatus`, `PendingAction`, `ActionRecord`, `ActionState`. The single source of truth for action shapes; `@freebirdai/core-state` re-exports them. |
| `harness.ts`   | `buildHarnessTurn` + per-phase tool & system-message builders.                           |
| `diff.ts`      | `diffKeys`, `validateActionArgs`, `ValidateArgsResult`.                                  |
| `harness.test.ts` | Tool-gating tests per phase (idle/collecting/awaiting/executing/error).               |

## Common tasks

- **Add a new tool to a phase:** edit `harness.ts`. Keep the function
  pure; wire its handling into `chat/engine.ts` `handleActionToolCall`
  and add a `ChatStreamEvent` kind if it needs to update client state.
- **Add a new field to `ActionRecord`:** edit `types.ts` only. The
  reducer in `core-state` and the audit pipeline in `server` both spread
  the shape; the field will flow through automatically once you set it
  in the relevant transition.
- **Tighten validation:** prefer adding to the action's Zod schema over
  custom logic in `handler`. The schema is the contract the LLM sees
  via `update_action_args` and the contract the server enforces in
  `/actions/confirm`.
