---
"@freebirdai/adapters-phone-twilio": minor
"@freebirdai/dash-spec": minor
"@freebirdai/connect-spec": minor
---

Dash Phone: seams for lines a server's host provides. `connection.phone.source` (a line made by the host's line source, its keys the host's for each use) and `connection.phone.suspended` (a per-line suspend switch); a line view's `provided` and `suspended`. The Twilio adapter takes keys scoped to a subaccount: the subaccount's own SID and token, or the subaccount's SID with `parentSid` and the parent's token (Twilio's other hosts then use the subaccount's own token, `subaccountToken` or read once per use).
