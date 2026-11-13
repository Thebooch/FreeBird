# @freebirdai/adapters-phone-telnyx

Telnyx for Dash Phone (`@freebirdai/phone`), beside Twilio.

- **Account:** `verify({ apiKey, publicKey })` checks the API key on the
  account's balance and names the account from its profile. The public key is
  the one Telnyx's webhooks are checked with.
- **Numbers:** search local US numbers by area code, order, list, route a
  number's texts to a line's webhook (a messaging profile per line), release.
- **Texts:** send with Telnyx's `Idempotency-Key`, so a repeated key is never
  sent twice; webhooks checked for their Ed25519 signature on the raw body and
  a fresh timestamp before anything is read, then `parseInbound` and
  `parseStatus`.
- **Registration (10DLC):** brand, use cases the brand qualifies for, campaign,
  numbers, status and `explain()`. A sole proprietor is refused: Telnyx verifies
  one with a one-time PIN the wizard does not take yet.
- **Calls:** `connectTrunk` makes an FQDN connection to the media layer's SIP
  host (LiveKit's), with an outbound voice profile and a credential the media
  layer dials out through `sip.telnyx.com` with.

```ts
import { createTelnyxProvider } from "@freebirdai/adapters-phone-telnyx";

const telnyx = createTelnyxProvider({
  statusCallback: (from) => `https://dash.example/api/public/local/phone/${lineFor(from)}/status`,
});
const account = await telnyx({}).verify({ apiKey: "KEY…", publicKey: "…" });
```

`TelnyxSimulator` is a pretend Telnyx account in process (the API's shapes, and
webhooks signed with a real Ed25519 key), for tests and sandboxes. Nothing in
this package's tests reaches Telnyx. Each request shape cites the Telnyx page it
was checked against; what those pages did not confirm is marked in the source.
