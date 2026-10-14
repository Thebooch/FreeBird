# @freebirdai/connect-spec

## 0.2.0

### Minor Changes

- 474e53c: Move the integration engine into `@freebirdai/connect`: discovery, sign-in, mapping, the response cache and keeper, jobs, drift, evidence and reviewed writes, the REST and MCP source adapters (formerly `@freebirdai/dash-adapters`), and the API-mapping half of the authoring agent. `@freebirdai/dash-agent` re-exports the moved agent passes. A saved connection's `onboarding` and a category's `starters` are now stored by the engine without being read; Dash reads them through `onboardingOf` and `startersOf`.
- be9f5ec: Split the connection side of Dash's spec into its own package, `@freebirdai/connect-spec`: connections, connectors, catalog entries, record types and their relations, evidence, rhythm and writes. `@freebirdai/dash-spec` re-exports all of it, so existing imports keep working. This is the first step toward the standalone `@freebirdai/connect` integration engine.
- ee1d19b: Email in Communications: Gmail and Outlook mailboxes, merged, with agents' replies sent only through the review.
  - Connect spec: a connection can be a mailbox (`mailbox`: provider, address, and its owner, the team or one agent). OAuth sign-in takes `authorizeParams`, the provider's own fixed values (Google's `access_type=offline`). A write endpoint can declare its `role` (for one whose path does not say it, like Gmail's `POST /messages/send`), and a write body can be an email (`mime`): its `to`, `cc`, `subject`, `text` and threading headers are reviewed as fields and sent as one encoded message.
  - Connect: the write service encodes such a body after the review is built, so the digest covers what is sent; the REST write sends a body that is already text as it is.
  - Dash spec: Communications (`comms.ts`): one message shape for both providers, drafts, what agents did with each message, the areas (Your comms, and one per agent), and one small search syntax (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `before:`, `after:`) with `matchesMailQuery` for filtering what is shown. A `message_received` workflow trigger and a **Reply to the email** step (`outreach.reply`). Contacts can come from an email (`origin: "email"`).
  - Dash react: Communications' styles (`styles-comms.ts`), part of `DASH_REACT_STYLES`.

- f1fa41c: Communications, the rest of plan 7: agents start email conversations, the team hears by email, contacts fill and type themselves, and calendars sync.
  - Connect spec: a mailbox can carry `calendar` (whose it is, keep its busy times free, put appointments in it).
  - Dash spec: `CommsSettings.noticesTo`, where team notices go for anyone without an email of their own. `MailboxView` says how its calendar is used and how writing to it last went.
  - Dash spec: a contact field can fill from email (`fromEmail`, with what to look for); a match rule can name a contact type (`type`), and `contactTypes` gives a contact's types from the rules it is linked by. Contacts can come from email (`origin: "email"`).
  - Dash react: styles for Comms' settings link.

### Patch Changes

- ce27094: Make Connect usable on its own: a README with a five-minute quickstart, an `AGENTS.md` integration guide, a docs-site section, and two runnable examples (`examples/connect-node`, `examples/connect-express`). After a check, the engine now describes the API's record types by itself when a model is configured, so `read({ record })` works without a host wiring it up.
- Updated dependencies [cacc921]
- Updated dependencies [24ecda1]
  - @freebirdai/expr@0.2.0
