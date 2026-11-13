import { describe, it } from "vitest";
import { providerContractCases } from "@freebirdai/phone/testing";
import { TelnyxSimulator } from "./index.js";

/* The shared provider-contract cases, unchanged, on Telnyx's adapter over a simulated Telnyx account. */

const NUMBER = "+14155550100";

describe("provider contract", () => {
  for (const one of providerContractCases({
    name: "telnyx",
    account: () => {
      const telnyx = new TelnyxSimulator({ numbers: [NUMBER] });
      const other = new TelnyxSimulator();
      return {
        open: telnyx.open,
        keys: telnyx.keys,
        badKeys: { apiKey: "KEYsomeone-else", publicKey: other.publicKey },
        number: NUMBER,
        areaCode: "415",
        sends: () => telnyx.sent.length,
        inbound: (text, url) => telnyx.inboundText(text, url),
        status: (providerId, outcome, url) => telnyx.statusRequest({ providerId, ...outcome }, url),
        settle: (ref, state) => telnyx.settle(ref.id, state),
        sipUri: "sip:dash-test.sip.livekit.cloud",
      };
    },
  }))
    it(one.name, one.run);
});
