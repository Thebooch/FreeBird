# @freebirdai/adapters-phone-twilio

Twilio for Dash Phone (`@freebirdai/phone`): the default provider.

- **Account:** `verify({ accountSid, authToken })` names the account and says
  whether it is a trial (a trial texts only verified numbers until upgraded).
- **Numbers:** search local US numbers by area code, buy, list what the account
  has, route a number's texts to a line's webhook, release.
- **Texts:** send (with a status callback), and the webhooks: `verify` checks
  `X-Twilio-Signature` on the raw request before anything is read, then
  `parseInbound` and `parseStatus`.

Calls (SIP trunks) and A2P 10DLC registration come in later phases.

```ts
import { createTwilioProvider } from "@freebirdai/adapters-phone-twilio";

const twilio = createTwilioProvider({
  statusCallback: (from) => `https://dash.example/api/public/local/phone/${lineFor(from)}/status`,
});
const account = await twilio({}).verify({ accountSid: "AC…", authToken: "…" });
```

Twilio's Messages API has no idempotency key, so a send key the provider has
already handed over is refused (`RepeatSendError`). Dash's own ledger is the
durable guard; this one covers a repeat within one server's life.

Tested against recorded answers in Twilio's shapes only: the tests never reach
Twilio.
