import { describe, expect, it } from "vitest";
import { PhoneKeysError } from "@freebirdai/phone";
import { providerContractCases } from "@freebirdai/phone/testing";
import { createSipProvider, sipAddressOf, sipNumbersOf } from "./index.js";

const NUMBER = "+14155550100";
const keys = { numbers: `${NUMBER}, +1 (415) 555-0101`, address: "sip.carrier.example", username: "dash", password: "secret" };
const noTexts = (): never => {
  throw new Error("A SIP trunk has no texts.");
};

describe("provider contract", () => {
  for (const one of providerContractCases({
    name: "sip",
    account: () => ({ open: createSipProvider(), keys, badKeys: { numbers: "", address: "", username: "", password: "" }, number: NUMBER, areaCode: "415", sends: () => 0, inbound: noTexts, status: noTexts }),
  }))
    it(one.name, one.run);
});

describe("generic SIP", () => {
  it("is voice only: no texts, no registration", () => {
    const provider = createSipProvider()({});
    expect(provider.capabilities).toEqual({ text: false, voice: "sip", registration: "none" });
    expect(provider.text).toBeUndefined();
    expect(provider.registration).toBeUndefined();
  });

  it("lists the pasted numbers, and hands the pasted credential to the media layer", async () => {
    const provider = createSipProvider()(keys);
    expect((await provider.numbers.list()).map((one) => one.number)).toEqual([NUMBER, "+14155550101"]);
    const trunk = await provider.voice!.connectTrunk({ sipUri: "sip:x.sip.livekit.cloud", numbers: [NUMBER] });
    expect(trunk.termination).toEqual({ address: "sip.carrier.example", username: "dash", password: "secret" });
    await expect(provider.voice!.connectTrunk({ sipUri: "sip:x", numbers: ["+14155550199"] })).rejects.toThrow(/not on this trunk/);
    await expect(provider.numbers.buy(NUMBER)).rejects.toThrow(/come from your carrier/);
    await expect(provider.numbers.route(NUMBER, { textWebhook: new URL("https://x.example/t") })).rejects.toThrow(/calls only/);
  });

  it("checks what was pasted", () => {
    expect(() => sipNumbersOf("555-0100")).toThrow(PhoneKeysError);
    expect(sipAddressOf("sip:SIP.Carrier.example:5060")).toBe("sip.carrier.example:5060");
    expect(() => sipAddressOf("https://carrier.example")).toThrow(PhoneKeysError);
  });
});
