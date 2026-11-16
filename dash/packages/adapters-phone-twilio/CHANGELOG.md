# @freebirdai/adapters-phone-twilio

## 0.2.0

### Minor Changes

- 1d9f113: Dash Phone, Phase 3: calls. Twilio's `voice` adapter (`connectTrunk`, `disconnectTrunk` over Elastic SIP Trunking); a line's `calls` settings (who answers: agent, forward or voicemail; forward number; recording on by default; the business's own opening words) and `voice.media`; `openingLine`, `RECORDING_NOTICE` and `callRecordSchema` in `dash-spec`; texts of kind `call`; the contact origin `call`; call lines in sandbox worlds.
- b0b369e: Dash Phone: seams for lines a server's host provides. `connection.phone.source` (a line made by the host's line source, its keys the host's for each use) and `connection.phone.suspended` (a per-line suspend switch); a line view's `provided` and `suspended`. The Twilio adapter takes keys scoped to a subaccount: the subaccount's own SID and token, or the subaccount's SID with `parentSid` and the parent's token (Twilio's other hosts then use the subaccount's own token, `subaccountToken` or read once per use).
- e563684: Dash Phone, Phase 2: text registration. The registration draft, its steps and timeline, and policy scans in `dash-spec`; Twilio's A2P 10DLC registration (Trust Hub profile and trust product, brand, use cases, campaign, numbers, status, and `explain` with the field to fix).
- bb58141: Dash Phone, Phase 4: a second provider. `@freebirdai/adapters-phone-telnyx` (numbers, texts with Telnyx's idempotency key and Ed25519-signed webhooks, 10DLC registration, SIP connections for calls, and `TelnyxSimulator`); `@freebirdai/adapters-phone-sip` for any carrier's calls over a SIP trunk, voice only; `@freebirdai/phone/testing` with the provider contract as one set of cases every adapter runs; `PhoneProviderError`, which `TwilioError` and `TelnyxError` now extend; the text status `none` for a calls-only line; and a line view's `capabilities`.
- 2f37e54: Dash Phone, Phase 1: the Twilio adapter (account check with trial detection, numbers, texts, signed webhooks), and in `dash-spec` text consent on contacts, STOP/HELP/START keywords, kept texts, and a consent basis on a text's delivery.

### Patch Changes

- Updated dependencies [474e53c]
- Updated dependencies [cacc921]
- Updated dependencies [be9f5ec]
- Updated dependencies [4175415]
- Updated dependencies [35ba3ac]
- Updated dependencies [3d5061b]
- Updated dependencies [3826ac3]
- Updated dependencies [ee1d19b]
- Updated dependencies [098e39e]
- Updated dependencies [f1fa41c]
- Updated dependencies [76dc96c]
- Updated dependencies [c33586c]
- Updated dependencies [bea96ca]
- Updated dependencies [bda2139]
- Updated dependencies [346b117]
- Updated dependencies [24ecda1]
- Updated dependencies [c8bbee6]
- Updated dependencies [fd7fcf7]
- Updated dependencies [2512638]
- Updated dependencies [1d9f113]
- Updated dependencies [be74895]
- Updated dependencies [b0b369e]
- Updated dependencies [e563684]
- Updated dependencies [bb58141]
- Updated dependencies [2f37e54]
- Updated dependencies [3cc3f53]
  - @freebirdai/dash-spec@0.2.0
  - @freebirdai/phone@0.2.0
