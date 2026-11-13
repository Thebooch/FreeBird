# @freebirdai/phone

## 0.2.0

### Minor Changes

- be74895: Dash Phone, Phase 0: the provider contract (`@freebirdai/phone`: `PhoneProvider`, `NumberAdapter`, `TextAdapter`, `VoiceAdapter`, `RegistrationAdapter`, `CallPlacer`) and a fake carrier that implements all of it; the normalized phone shapes as Zod schemas in `dash-spec` (`InboundText`, `DeliveryUpdate`, `BrandProfile`, `CampaignDraft`, `CampaignUse`, `RegistrationStatus` and the rest); `connection.phone` beside `connection.mailbox`; and a sandbox world's `phone` lines on the fake carrier.
- bb58141: Dash Phone, Phase 4: a second provider. `@freebirdai/adapters-phone-telnyx` (numbers, texts with Telnyx's idempotency key and Ed25519-signed webhooks, 10DLC registration, SIP connections for calls, and `TelnyxSimulator`); `@freebirdai/adapters-phone-sip` for any carrier's calls over a SIP trunk, voice only; `@freebirdai/phone/testing` with the provider contract as one set of cases every adapter runs; `PhoneProviderError`, which `TwilioError` and `TelnyxError` now extend; the text status `none` for a calls-only line; and a line view's `capabilities`.

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
