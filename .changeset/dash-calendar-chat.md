---
"@freebirdai/dash-spec": minor
"@freebirdai/dash-react": minor
---

Everything on the calendar and contacts screens can be asked for in the chat, and is done only on Approve.

- Dash spec: `DASH_SCREENS`, the id and page of each calendar and contacts screen the chat can change (calendar, bookings, appointment types, blocks, people and pools, scheduling settings, contacts, contact fields), shared by server and web.
- Dash react: `styles-chat-cards.ts`, part of `DASH_REACT_STYLES`: the approval card (what the change does, each setting before and after, Approve and Cancel), the card for a link shown once, and the ring on a setting a citation chip opens.
