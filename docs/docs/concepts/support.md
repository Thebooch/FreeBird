# Customer service & support tickets

FreeBird includes a first-class **customer-service / escalation** subsystem. It helps every host app:

1. **Detect** when a user is reporting a problem or requesting something missing
2. **Classify** the issue as a **bug**, **feature**, or **behavior** and assign **severity** (`low` | `medium` | `high`)
3. **Remedy first** — try tools/actions and explain how things work before escalating
4. **Escalate** via the `report_issue` LLM tool when remedy is exhausted
5. **Confirm** a ticket draft with the user, then **file** canonical JSON through a host `ticketSink`

FreeBird does **not** persist tickets. The host decides what to do (save, email, display, webhook).

## Severity semantics

| Ticket type | `severity` meaning |
|-------------|-------------------|
| `bug` | Impact/severity of the defect |
| `feature` | Perceived implementation complexity |
| `behavior` | How an AI agent responded in conversation: `high` = technically broken reply (leaked prompt/instructions, raw JSON, non-conversational output); `medium` = incorrect information/answer; `low` = stylistic/wording only, information accurate |

`behavior` is for complaints about an **AI agent's conversational response** — not app behavior. Because many such complaints are configurable (tone, persona, instructions, KB), the model is told to fix them via settings tools/actions first and only escalate a `behavior` ticket when no tool can correct it.

The LLM picks `low`, `medium`, or `high` using prompt guidance in `buildSupportPrompt()`.

## Enable in your server

```ts
import { createChatEngine, buildSupportPrompt } from "@freebirdai/core";

const chat = createChatEngine({
  db,
  llm,
  registry,
  knowledge,
  systemPrompt: "You are …",
  support: {
    enabled: true,
    prompt: "Before escalating, try …", // host-specific remedy hints
    requireConfirmation: true,
  },
});
```

When `support` is set (and `enabled !== false`), the chat engine:

- Injects the universal support prompt block after your global system prompt
- Exposes `report_issue` while the action layer is `idle`
- Emits `issue_classified` and `ticket_drafted` SSE events when the model escalates

## Ticket JSON

Draft shape (Zod: `ticketDraftSchema`):

- `type`: `bug` | `feature` | `behavior`
- `severity`: `low` | `medium` | `high`
- `title`, `summary`
- `stepsToReproduce` (bugs), `desiredOutcome` (features), `observedResponse` (behavior)
- `attemptedRemedies`, `relatedComponentIds`, `tags` (optional)

Filed ticket (`Ticket`) adds server-stamped fields: `id`, `userId`, `sessionId`, `createdAt`, optional `orgId`, `subject`, `transcriptExcerpt`, `metadata`.

## Filing tickets

**Client:** after `ticket_drafted`, a ticket confirmation card appears in chat. The user clicks **File ticket** or replies with an affirmative message (e.g. "looks good", "yes", "submit"). That calls `store.fileTicket()` which POSTs to `/support/tickets`.

**Server:** implement `ticketSink` on the router:

```ts
createFreeBirdRouter({
  // …
  ticketSink: {
    async fileTicket(ticket, ctx) {
      // save / email / webhook — your choice
      return { externalId: "…" };
    },
  },
  onTicketEvent: (event, auth) => {
    console.info("[support]", event.kind, event);
  },
});
```

## Review flows (host UI)

FreeBird supplies the **escalation conversation** and ticket JSON. Host apps typically build a **review modal** that:

- Lists domain items (call logs, sessions, etc.)
- Lets users dismiss or flag rows
- Seeds chat with `supportContext.subject` when reporting an issue

Pass context on send:

```ts
await store.send("I want to report an issue with this call", {
  supportContext: {
    subject: { callId, callerName, summary },
    transcriptExcerpt: "…",
  },
});
```

## SSE events

| Event | When |
|-------|------|
| `issue_classified` | Model called `report_issue` with type/severity |
| `ticket_drafted` | Full draft + preview ready for user confirmation |
| `ticket_created` | Optional — if auto-file path used |
| `ticket_failed` | Filing error |

Client state lives in `FreeBirdState.supportState` (`@freebirdai/core-state`).
