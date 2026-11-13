---
"@freebirdai/adapters-phone-telnyx": minor
"@freebirdai/adapters-phone-sip": minor
"@freebirdai/adapters-phone-twilio": minor
"@freebirdai/phone": minor
"@freebirdai/dash-spec": minor
"@freebirdai/connect-spec": minor
---

Dash Phone, Phase 4: a second provider. `@freebirdai/adapters-phone-telnyx` (numbers, texts with Telnyx's idempotency key and Ed25519-signed webhooks, 10DLC registration, SIP connections for calls, and `TelnyxSimulator`); `@freebirdai/adapters-phone-sip` for any carrier's calls over a SIP trunk, voice only; `@freebirdai/phone/testing` with the provider contract as one set of cases every adapter runs; `PhoneProviderError`, which `TwilioError` and `TelnyxError` now extend; the text status `none` for a calls-only line; and a line view's `capabilities`.
