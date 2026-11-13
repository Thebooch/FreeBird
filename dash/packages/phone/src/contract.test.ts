import { describe, it } from "vitest";
import { FAKE_SIGNATURE_HEADER, FakeCarrier } from "./index.js";
import { providerContractCases } from "./testing.js";

/* The shared provider-contract cases, on the fake carrier. Twilio and Telnyx run the same cases in their own packages. */

const NUMBER = "+15550100100";

describe("provider contract", () => {
  for (const one of providerContractCases({
    name: "fake",
    account: () => {
      const carrier = new FakeCarrier({ numbers: [NUMBER] });
      return {
        open: carrier.open,
        keys: { secret: carrier.secret },
        badKeys: { secret: "not-the-secret" },
        number: NUMBER,
        areaCode: "415",
        sends: () => carrier.sent.length,
        inbound: (text, url) => carrier.inboundText(text, url),
        status: (providerId, outcome, url) => carrier.statusRequest({ providerId, ...outcome }, url),
        settle: (ref, state) => void carrier.settleRegistration(ref.id, state, state === "rejected" ? "30794" : undefined),
      };
    },
  }))
    it(one.name, one.run);

  it("signs its webhooks in its own header", () => {
    const carrier = new FakeCarrier();
    if (!carrier.inboundText({ from: "+15550100299", to: NUMBER, body: "Hi" }, "https://x.example/t").headers[FAKE_SIGNATURE_HEADER]) throw new Error("unsigned");
  });
});
