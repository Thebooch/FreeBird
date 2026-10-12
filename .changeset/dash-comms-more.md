---
"@freebirdai/connect-spec": minor
"@freebirdai/dash-spec": minor
"@freebirdai/dash-react": patch
---

Communications, the rest of plan 7: agents start email conversations, the team hears by email, contacts fill and type themselves, and calendars sync.

- Connect spec: a mailbox can carry `calendar` (whose it is, keep its busy times free, put appointments in it).
- Dash spec: `CommsSettings.noticesTo`, where team notices go for anyone without an email of their own. `MailboxView` says how its calendar is used and how writing to it last went.
- Dash spec: a contact field can fill from email (`fromEmail`, with what to look for); a match rule can name a contact type (`type`), and `contactTypes` gives a contact's types from the rules it is linked by. Contacts can come from email (`origin: "email"`).
- Dash react: styles for Comms' settings link.
