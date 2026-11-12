---
"@freebirdai/phone": minor
"@freebirdai/dash-spec": minor
"@freebirdai/connect-spec": minor
---

Dash Phone, Phase 0: the provider contract (`@freebirdai/phone`: `PhoneProvider`, `NumberAdapter`, `TextAdapter`, `VoiceAdapter`, `RegistrationAdapter`, `CallPlacer`) and a fake carrier that implements all of it; the normalized phone shapes as Zod schemas in `dash-spec` (`InboundText`, `DeliveryUpdate`, `BrandProfile`, `CampaignDraft`, `CampaignUse`, `RegistrationStatus` and the rest); `connection.phone` beside `connection.mailbox`; and a sandbox world's `phone` lines on the fake carrier.
