import { describe, expect, it } from "vitest";
import { FAKE_SECRET, FAKE_SIGNATURE_HEADER, FakeCarrier, PhoneKeysError, PhoneParseError, RepeatSendError } from "./index.js";

const URL_TEXT = "https://dash.example/api/public/local/phone/line/text";
const keys = { secret: FAKE_SECRET };
const brand = {
  legalName: "Acme Plumbing LLC",
  businessType: "llc" as const,
  ein: "12-3456789",
  address: { street: "1 Main St", city: "Springfield", region: "IL", postalCode: "62701", country: "US" as const },
  website: "https://acme.example",
  industry: "Home services",
  contact: { name: "Ann Owner", title: "Owner", email: "ann@acme.example", phone: "+15550100999" },
};
const campaign = {
  use: "ACCOUNT_NOTIFICATION",
  description: "Reminders",
  samples: ["Acme: see you at 3", "Reply STOP to opt out"],
  frequency: "Before each visit",
  optIn: { methods: ["booking_page" as const], description: "A box on the booking page" },
  containsLinks: false,
  containsPhoneNumbers: false,
};

describe("FakeCarrier", () => {
  it("records sends and refuses a repeated key", async () => {
    const carrier = new FakeCarrier({ now: () => 0 });
    const text = carrier.open(keys).text!;
    const first = await text.send({ from: "+15550100100", to: "+15550100200", body: "Hi", key: "k1" });
    expect(first.status).toBe("queued");
    expect(carrier.sent).toHaveLength(1);
    await expect(text.send({ from: "+15550100100", to: "+15550100200", body: "Hi again", key: "k1" })).rejects.toBeInstanceOf(RepeatSendError);
    expect(carrier.sent).toHaveLength(1);
  });

  it("refuses the wrong keys", async () => {
    const carrier = new FakeCarrier();
    await expect(carrier.open({ secret: "nope" }).text!.send({ from: "+15550100100", to: "+15550100200", body: "Hi", key: "k" })).rejects.toBeInstanceOf(PhoneKeysError);
    await expect(carrier.open({}).verify({ secret: "nope" })).rejects.toBeInstanceOf(PhoneKeysError);
    expect(await carrier.open({}).verify(keys)).toMatchObject({ trial: false, country: "US" });
  });

  it("owes a delivery update for each send, failed for numbers it was told to fail", async () => {
    const carrier = new FakeCarrier();
    carrier.failDelivery("+15550100300", "30006");
    const text = carrier.open(keys).text!;
    const ok = await text.send({ from: "+15550100100", to: "+15550100200", body: "a", key: "a" });
    const bad = await text.send({ from: "+15550100100", to: "+15550100300", body: "b", key: "b" });
    expect(carrier.takeUpdates()).toEqual([
      { providerId: ok.providerId, status: "delivered" },
      { providerId: bad.providerId, status: "failed", errorCode: "30006" },
    ]);
    expect(carrier.takeUpdates()).toEqual([]);
  });

  it("signs its webhooks, and verify accepts only an untouched one", () => {
    const carrier = new FakeCarrier({ now: () => Date.parse("2026-11-12T00:00:00Z") });
    const text = carrier.open({}).text!;
    const raw = carrier.inboundText({ from: "+15550100200", to: "+15550100100", body: "Hello" }, URL_TEXT);
    expect(text.verify(raw, keys)).toBe(true);
    expect(text.verify({ ...raw, body: raw.body.replace("Hello", "Hellp") }, keys)).toBe(false);
    expect(text.verify({ ...raw, url: `${URL_TEXT}?x=1` }, keys)).toBe(false);
    expect(text.verify(raw, { secret: "other" })).toBe(false);
    expect(text.verify({ ...raw, headers: { ...raw.headers, [FAKE_SIGNATURE_HEADER]: undefined } }, keys)).toBe(false);
    expect(text.parseInbound(raw)).toMatchObject({ from: "+15550100200", to: "+15550100100", body: "Hello", media: [] });
  });

  it("makes STOP replies and status webhooks, and refuses to parse the wrong event", () => {
    const carrier = new FakeCarrier();
    const text = carrier.open({}).text!;
    const stop = carrier.stopReply("+15550100200", "+15550100100", URL_TEXT);
    expect(text.parseInbound(stop).body).toBe("STOP");
    expect(() => text.parseStatus(stop)).toThrow(PhoneParseError);
    const status = carrier.statusRequest({ providerId: "SM1", status: "failed", errorCode: "30003" }, URL_TEXT);
    expect(text.verify(status, keys)).toBe(true);
    expect(text.parseStatus(status)).toEqual({ providerId: "SM1", status: "failed", errorCode: "30003" });
    expect(() => text.parseInbound({ ...status, body: "not json" })).toThrow(PhoneParseError);
  });

  it("places calls once per key and reports their minutes when they end", async () => {
    const carrier = new FakeCarrier();
    const call = await carrier.placer.place({ from: "+15550100100", to: "+15550100200", purpose: "Confirm", key: "c1", maxMinutes: 10 });
    await expect(carrier.placer.place({ from: "+15550100100", to: "+15550100200", purpose: "Confirm", key: "c1", maxMinutes: 10 })).rejects.toBeInstanceOf(RepeatSendError);
    expect(carrier.endCall(call.providerId, 3)).toEqual({ providerId: call.providerId, status: "delivered", minutes: 3 });
  });

  it("buys, lists, routes and releases numbers; connects trunks", async () => {
    const carrier = new FakeCarrier();
    const provider = carrier.open(keys);
    const [found] = await provider.numbers.search({ areaCode: "415" });
    expect(found!.number).toMatch(/^\+1415/);
    await provider.numbers.buy(found!.number);
    expect((await provider.numbers.list()).map((one) => one.number)).toEqual([found!.number]);
    await provider.numbers.route(found!.number, { textWebhook: new URL(URL_TEXT) });
    expect(carrier.routes.get(found!.number)).toEqual({ textWebhook: URL_TEXT });
    const trunk = await provider.voice!.connectTrunk({ sipUri: "sip:dash@media.example", numbers: [found!.number] });
    expect(carrier.trunks.get(trunk.id)?.numbers).toEqual([found!.number]);
    await provider.numbers.release(found!.number);
    expect(await provider.numbers.list()).toEqual([]);
  });

  it("registers a brand and campaign, and rejects on demand with an explanation", async () => {
    const carrier = new FakeCarrier();
    const registration = carrier.open(keys).registration!;
    carrier.rejectNextRegistration("30794");
    const rejected = await registration.submitBrand(brand);
    expect(await registration.status(rejected)).toMatchObject({ state: "rejected", codes: [{ code: "30794" }] });
    expect(registration.explain("30794")).toMatchObject({ field: "legalName" });
    expect(registration.explain("99999").sentence).toContain("99999");

    const ref = await registration.submitBrand(brand);
    expect((await registration.status(ref)).state).toBe("pending");
    await expect(registration.submitCampaign(ref, campaign)).rejects.toThrow(/not approved/);
    carrier.settleRegistration(ref.id, "approved");
    expect((await registration.useCases(ref)).some((one) => one.extraVetting)).toBe(true);
    const submitted = await registration.submitCampaign(ref, campaign);
    carrier.settleRegistration(submitted.id, "approved");
    await registration.attachNumbers(submitted, ["+15550100100"]);
    expect(carrier.attached.get(submitted.id)).toEqual(["+15550100100"]);
  });
});
