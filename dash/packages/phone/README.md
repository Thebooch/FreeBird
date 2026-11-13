# @freebirdai/phone

Dash Phone's provider contract: one interface per capability, so a provider
can offer some and not others (a SIP-only carrier has voice but no text API).

- `PhoneProvider`: id, title, the credentials a person pastes, `verify(keys)`,
  capabilities, and the adapters below. A server registers each provider as an
  `OpenPhoneProvider`, opened with one line's keys (read from the vault) for each use.
- `NumberAdapter`: search, buy, list, route, release.
- `TextAdapter`: `send` (at most once per `key`), `verify` (the signature, on the
  raw request, before anything is parsed), `parseInbound`, `parseStatus`.
- `VoiceAdapter`: point the carrier's SIP trunk at the media layer.
- `RegistrationAdapter`: A2P 10DLC brand, `useCases`, campaign, numbers, status, `explain`.
- `CallPlacer`: Dash's own seam for placing a call (the voice worker), not a carrier's.

The normalized shapes (`InboundText`, `DeliveryUpdate`, `BrandProfile`,
`CampaignDraft`, `RegistrationStatus` and the rest) are Zod schemas in
`@freebirdai/dash-spec`.

Two rules every adapter keeps: **at most once** on the send key, and **spend is
capped outside the adapter** (Dash counts each line's daily ceilings before a
send or a dial).

## The fake carrier

`FakeCarrier` implements every interface with nothing leaving the process. It
records sends and calls, makes signed webhooks for inbound texts, STOP replies
and delivery updates, fails delivery to the numbers it is told to, rejects
registrations on demand, and refuses a repeated send key. Sandboxes use it
(`world.workspace.phone`), and so do tests.

```ts
import { FakeCarrier, FAKE_SECRET } from "@freebirdai/phone";

const carrier = new FakeCarrier();
const provider = carrier.open({ secret: FAKE_SECRET });
await provider.text!.send({ from: "+15550100100", to: "+15550100200", body: "Hi", key: "once" });
const webhook = carrier.inboundText({ from: "+15550100200", to: "+15550100100", body: "Thanks" }, "https://dash.example/api/public/local/phone/line/text");
provider.text!.verify(webhook, { secret: FAKE_SECRET }); // true
```
