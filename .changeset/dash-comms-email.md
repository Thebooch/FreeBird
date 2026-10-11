---
"@freebirdai/connect-spec": minor
"@freebirdai/connect": minor
"@freebirdai/connect-server": minor
"@freebirdai/dash-spec": minor
"@freebirdai/dash-react": minor
---

Email in Communications: Gmail and Outlook mailboxes, merged, with agents' replies sent only through the review.

- Connect spec: a connection can be a mailbox (`mailbox`: provider, address, and its owner, the team or one agent). OAuth sign-in takes `authorizeParams`, the provider's own fixed values (Google's `access_type=offline`). A write endpoint can declare its `role` (for one whose path does not say it, like Gmail's `POST /messages/send`), and a write body can be an email (`mime`): its `to`, `cc`, `subject`, `text` and threading headers are reviewed as fields and sent as one encoded message.
- Connect: the write service encodes such a body after the review is built, so the digest covers what is sent; the REST write sends a body that is already text as it is.
- Dash spec: Communications (`comms.ts`): one message shape for both providers, drafts, what agents did with each message, the areas (Your comms, and one per agent), and one small search syntax (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `before:`, `after:`) with `matchesMailQuery` for filtering what is shown. A `message_received` workflow trigger and a **Reply to the email** step (`outreach.reply`). Contacts can come from an email (`origin: "email"`).
- Dash react: Communications' styles (`styles-comms.ts`), part of `DASH_REACT_STYLES`.
