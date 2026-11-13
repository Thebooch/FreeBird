import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONTRACT_BRAND, CONTRACT_CAMPAIGN } from "@freebirdai/phone/testing";
import { PhoneKeysError, PhoneParseError, RepeatSendError } from "@freebirdai/phone";
import { TelnyxError, TelnyxSimulator, createTelnyxProvider, sipHostOf, telnyxIdempotencyKey, telnyxPublicKey, telnyxStatus, telnyxVertical, type TelnyxFetch } from "./index.js";

/*
 * Against recorded answers in Telnyx's API v2 shapes, and the simulator:
 * nothing here reaches Telnyx.
 */

const NUMBER = "+14155550100";
const URL_TEXT = "https://dash.example/api/public/local/phone/line-1/text";

type Sent = { method: string; url: string; headers: Record<string, string>; body?: unknown };

/** Records every request and answers from a list, in order. */
const recorded = (answers: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) => {
  const sent: Sent[] = [];
  const fetch: TelnyxFetch = async (url, init) => {
    sent.push({ method: init.method, url, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) as unknown } : {}) });
    const answer = answers.shift() ?? { status: 404, body: { errors: [{ code: "10005", title: "Resource not found" }] } };
    return { status: answer.status ?? 200, headers: { get: (name: string) => answer.headers?.[name.toLowerCase()] ?? null }, text: async () => JSON.stringify(answer.body) };
  };
  return { sent, fetch };
};

describe("Telnyx: keys and the account", () => {
  it("sends the API key as a bearer token, and names the account from its profile", async () => {
    const telnyx = new TelnyxSimulator({ businessName: "Acme Plumbing" });
    expect(await telnyx.open({}).verify(telnyx.keys)).toEqual({ name: "Acme Plumbing", country: "US", trial: false });
    expect(telnyx.requests).toEqual(["GET /balance", "GET /user_profile"]);
  });

  it("refuses a refused key (401, 10009) and a public key that is not one", async () => {
    const telnyx = new TelnyxSimulator();
    await expect(telnyx.open({}).verify({ apiKey: "KEYwrong", publicKey: telnyx.publicKey })).rejects.toBeInstanceOf(PhoneKeysError);
    await expect(telnyx.open({}).verify({ apiKey: telnyx.apiKey, publicKey: "not a key" })).rejects.toThrow(/Public Key/);
  });

  it("takes the public key as the raw 32 bytes or as SPKI DER", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const der = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
    expect(telnyxPublicKey(der)).not.toBeNull();
    expect(telnyxPublicKey(Buffer.from(der, "base64").subarray(-32).toString("base64"))).not.toBeNull();
    expect(telnyxPublicKey("AAAA")).toBeNull();
  });

  it("keeps a profile it cannot read from failing a good key", async () => {
    const answers = recorded([{ body: { data: { balance: "1.00", currency: "USD" } } }, { status: 503, body: { errors: [{ code: "10037", title: "Unavailable" }] } }]);
    const { publicKey } = generateKeyPairSync("ed25519");
    const key = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
    expect(await createTelnyxProvider({ fetch: answers.fetch })({}).verify({ apiKey: "KEY1", publicKey: key })).toEqual({ name: "", trial: false });
    expect(answers.sent[0]!.headers["authorization"]).toBe("Bearer KEY1");
  });
});

describe("Telnyx: numbers", () => {
  it("searches local US numbers that text, by area code, with Telnyx's monthly price", async () => {
    const telnyx = new TelnyxSimulator();
    const answers = recorded([{ body: { data: [{ phone_number: "+14155550123", region_information: [{ region_type: "rate_center", region_name: "SAN FRANCISCO" }, { region_type: "state", region_name: "CA" }], cost_information: { monthly_cost: "1.00", upfront_cost: "1.00", currency: "USD" }, features: [{ name: "sms" }, { name: "voice" }] }] } }]);
    const found = await createTelnyxProvider({ fetch: answers.fetch })(telnyx.keys).numbers.search({ areaCode: "415" });
    expect(found).toEqual([{ number: "+14155550123", locality: "SAN FRANCISCO", region: "CA", monthlyPrice: { amount: "1.00", currency: "USD" }, capabilities: { text: true, voice: true } }]);
    const query = new URL(answers.sent[0]!.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({ "filter[country_code]": "US", "filter[phone_number_type]": "local", "filter[features][]": "sms", "filter[limit]": "20", "filter[national_destination_code]": "415" });
  });

  it("routes a number's texts through a messaging profile of its own, unredacted, made once", async () => {
    const telnyx = new TelnyxSimulator({ numbers: [NUMBER] });
    const numbers = telnyx.open(telnyx.keys).numbers;
    await numbers.route(NUMBER, { textWebhook: new URL(URL_TEXT) });
    await numbers.route(NUMBER, { textWebhook: new URL(`${URL_TEXT}?again=1`) });
    expect(telnyx.profiles.size).toBe(1);
    const [profile] = [...telnyx.profiles.values()];
    expect(profile).toMatchObject({ name: `Dash ${NUMBER}`, whitelisted_destinations: ["US", "CA"], webhook_url: `${URL_TEXT}?again=1`, webhook_api_version: "2", redaction_enabled: false });
    expect([...telnyx.numbers.values()][0]!["messaging_profile_id"]).toBe(profile!["id"]);
    await expect(numbers.route(NUMBER, { voiceSip: { uri: "sip:x" } })).rejects.toBeInstanceOf(TelnyxError);
    await expect(numbers.release("+14155550999")).rejects.toThrow(/not in this Telnyx account/);
  });
});

describe("Telnyx: texts", () => {
  it("sends with Telnyx's Idempotency-Key and a status webhook, and calls a replay a repeat", async () => {
    const telnyx = new TelnyxSimulator({ numbers: [NUMBER] });
    const answers = recorded([
      { body: { data: { id: "msg-1", to: [{ phone_number: "+15550100299", status: "queued" }] } } },
      { body: { data: { id: "msg-1", to: [{ phone_number: "+15550100299", status: "queued" }] } }, headers: { "idempotent-replayed": "true" } },
      { status: 409, body: { errors: [{ code: "10036", title: "Request in progress" }] } },
    ]);
    const open = createTelnyxProvider({ fetch: answers.fetch, statusCallback: () => "https://dash.example/api/public/local/phone/line-1/status" });
    expect(await open(telnyx.keys).text!.send({ from: NUMBER, to: "+15550100299", body: "Hi", key: "outreach:task-1" })).toEqual({ providerId: "msg-1", status: "queued" });
    expect(answers.sent[0]).toMatchObject({ method: "POST", url: "https://api.telnyx.com/v2/messages", body: { from: NUMBER, to: "+15550100299", text: "Hi", webhook_url: "https://dash.example/api/public/local/phone/line-1/status", use_profile_webhooks: false } });
    expect(answers.sent[0]!.headers["idempotency-key"]).toBe(telnyxIdempotencyKey("outreach:task-1"));
    await expect(open(telnyx.keys).text!.send({ from: NUMBER, to: "+15550100299", body: "Hi", key: "outreach:task-1" })).rejects.toMatchObject({ name: "RepeatSendError", providerId: "msg-1" });
    await expect(open(telnyx.keys).text!.send({ from: NUMBER, to: "+15550100299", body: "Hi", key: "outreach:task-1" })).rejects.toBeInstanceOf(RepeatSendError);
  });

  it("puts any send key in the alphabet Telnyx takes, the same way each time", () => {
    expect(telnyxIdempotencyKey("plain-key_1")).toBe("plain-key_1");
    expect(telnyxIdempotencyKey("outreach:task 1")).toMatch(/^dash-[0-9a-f]{64}$/);
    expect(telnyxIdempotencyKey("outreach:task 1")).toBe(telnyxIdempotencyKey("outreach:task 1"));
    expect(telnyxIdempotencyKey("x".repeat(300))).toHaveLength(69);
  });

  it("maps every recipient status Telnyx gives", () => {
    expect(["queued", "sending", "sent", "delivered", "read", "sending_failed", "delivery_failed", "expired", "delivery_unconfirmed"].map(telnyxStatus)).toEqual(["queued", "queued", "sent", "delivered", "delivered", "failed", "failed", "failed", "sent"]);
  });

  it("reports Telnyx's refusal in its words", async () => {
    const answers = recorded([{ status: 403, body: { errors: [{ code: "40305", title: "Invalid 'from' address", detail: "Not on a messaging profile." }] } }]);
    await expect(createTelnyxProvider({ fetch: answers.fetch })({ apiKey: "KEY1" }).text!.send({ from: NUMBER, to: "+15550100299", body: "Hi", key: "k" })).rejects.toMatchObject({ code: "40305", status: 403, message: "Invalid 'from' address: Not on a messaging profile." });
  });
});

describe("Telnyx: webhooks, verified before they are read", () => {
  it("checks the Ed25519 signature over timestamp|body, and refuses a stale or future timestamp", () => {
    const at = Date.parse("2026-11-13T12:00:00Z");
    const telnyx = new TelnyxSimulator({ now: () => at });
    const raw = telnyx.inboundText({ from: "+15550100299", to: NUMBER, body: "Yes" }, URL_TEXT);
    const text = (now: number) => createTelnyxProvider({ now: () => now })({}).text!;
    expect(text(at).verify(raw, telnyx.keys)).toBe(true);
    expect(text(at + 299_000).verify(raw, telnyx.keys)).toBe(true);
    expect(text(at + 301_000).verify(raw, telnyx.keys)).toBe(false);
    expect(text(at - 301_000).verify(raw, telnyx.keys)).toBe(false);
    /* The timestamp is signed too: moving it breaks the signature. */
    expect(text(at).verify({ ...raw, headers: { ...raw.headers, "telnyx-timestamp": String(Number(raw.headers["telnyx-timestamp"]) + 1) } }, telnyx.keys)).toBe(false);
    expect(text(at).verify({ ...raw, method: "GET" }, telnyx.keys)).toBe(false);
  });

  it("matches a signature made the way Telnyx's samples make it", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const body = '{"data":{"event_type":"message.received","payload":{"id":"m1","from":{"phone_number":"+15550100299"},"to":[{"phone_number":"+14155550100"}],"text":"Hi"}}}';
    const timestamp = "1763035200";
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`), createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" }))).toString("base64");
    const req = { method: "POST", url: URL_TEXT, headers: { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }, body };
    const keys = { publicKey: (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64") };
    expect(createTelnyxProvider({ now: () => 1763035200_000 })({}).text!.verify(req, keys)).toBe(true);
  });

  it("parses an inbound text, with media, and refuses other events", () => {
    const telnyx = new TelnyxSimulator();
    const text = telnyx.open({}).text!;
    const raw = telnyx.inboundText({ from: "+15550100299", to: NUMBER, body: "A photo", media: ["https://media.telnyx.example/1.jpg"] }, URL_TEXT);
    expect(text.parseInbound(raw)).toMatchObject({ from: "+15550100299", to: NUMBER, body: "A photo", media: ["https://media.telnyx.example/1.jpg"] });
    const status = telnyx.statusRequest({ providerId: "msg-1", status: "delivered" }, URL_TEXT);
    expect(() => text.parseInbound(status)).toThrow(PhoneParseError);
    expect(() => text.parseStatus(raw)).toThrow(PhoneParseError);
    expect(() => text.parseInbound({ ...raw, body: "not json" })).toThrow(PhoneParseError);
  });
});

describe("Telnyx: 10DLC registration", () => {
  it("submits the brand in Telnyx's fields, the EIN as digits", async () => {
    const telnyx = new TelnyxSimulator();
    const ref = await telnyx.open(telnyx.keys).registration!.submitBrand(CONTRACT_BRAND);
    expect(telnyx.brands.get(ref.id)).toMatchObject({ entityType: "PRIVATE_PROFIT", displayName: "Acme Plumbing LLC", companyName: "Acme Plumbing LLC", ein: "123456789", firstName: "Ann", lastName: "Owner", state: "IL", country: "US", vertical: "PROFESSIONAL", website: "https://acme.example" });
    expect(ref).toEqual({ kind: "brand", id: ref.id, provider: "telnyx" });
  });

  it("refuses a sole proprietor in plain words: Telnyx's PIN step is not in the wizard", async () => {
    const telnyx = new TelnyxSimulator();
    await expect(telnyx.open(telnyx.keys).registration!.submitBrand({ ...CONTRACT_BRAND, businessType: "sole_proprietor", ein: undefined } as never)).rejects.toThrow(/one-time PIN/);
    expect(telnyx.brands.size).toBe(0);
  });

  it("offers only the uses the brand qualifies for, and submits the campaign with samples, links and keywords", async () => {
    const telnyx = new TelnyxSimulator();
    const registration = telnyx.open(telnyx.keys).registration!;
    const brand = await registration.submitBrand(CONTRACT_BRAND);
    telnyx.settle(brand.id, "approved");
    const uses = await registration.useCases(brand);
    expect(uses.map((one) => one.id)).not.toContain("POLITICAL");
    expect(uses.find((one) => one.id === "ACCOUNT_NOTIFICATION")).toMatchObject({ title: "Account notification", extraVetting: false });
    const campaign = await registration.submitCampaign(brand, CONTRACT_CAMPAIGN);
    expect(telnyx.campaigns.get(campaign.id)).toMatchObject({
      brandId: brand.id,
      usecase: "ACCOUNT_NOTIFICATION",
      sample1: CONTRACT_CAMPAIGN.samples[0],
      sample2: CONTRACT_CAMPAIGN.samples[1],
      embeddedLink: false,
      embeddedPhone: false,
      privacyPolicyLink: "https://acme.example/privacy",
      optoutKeywords: expect.stringContaining("STOP"),
      messageFlow: expect.stringContaining("https://acme.example/texts"),
    });
  });

  it("reads rejections with Telnyx's reasons, and explains them by the field to fix", async () => {
    const telnyx = new TelnyxSimulator();
    const registration = telnyx.open(telnyx.keys).registration!;
    telnyx.rejections.push("The EIN does not match the company name.");
    const brand = await registration.submitBrand(CONTRACT_BRAND);
    const status = await registration.status(brand);
    expect(status).toMatchObject({ state: "rejected", codes: [{ code: "UNVERIFIED", message: "The EIN does not match the company name." }] });
    expect(registration.explain("UNVERIFIED")).toMatchObject({ field: "ein", sentence: expect.stringContaining("Telnyx said: The EIN does not match") });
    expect(registration.explain("NEVER_SEEN").sentence).toMatch(/rejected this \(NEVER_SEEN\)/);
  });

  it("maps industries to the registry's verticals", () => {
    expect(["Dental clinic", "Property management", "Plumbing", "Online store", "Bakery"].map(telnyxVertical)).toEqual(["HEALTHCARE", "REAL_ESTATE", "PROFESSIONAL", "RETAIL", "BAKERY"]);
  });
});

describe("Telnyx: calls", () => {
  it("makes a voice profile, an FQDN connection to the media layer's host and port, and puts the numbers on it", async () => {
    const telnyx = new TelnyxSimulator({ numbers: [NUMBER] });
    const voice = telnyx.open(telnyx.keys).voice!;
    const trunk = await voice.connectTrunk({ sipUri: "sip:abc123.sip.livekit.cloud:5061;transport=tcp", numbers: [NUMBER] });
    const [connection] = [...telnyx.connections.values()];
    expect(connection).toMatchObject({ transport_protocol: "TCP", inbound: { ani_number_format: "+E.164", dnis_number_format: "+e164" }, outbound: { outbound_voice_profile_id: [...telnyx.voiceProfiles.keys()][0] } });
    expect([...telnyx.fqdns.values()][0]).toMatchObject({ connection_id: connection!["id"], fqdn: "abc123.sip.livekit.cloud", port: 5061, dns_record_type: "a" });
    expect([...telnyx.numbers.values()][0]!["connection_id"]).toBe(connection!["id"]);
    expect(trunk.termination).toEqual({ address: "sip.telnyx.com", username: connection!["user_name"], password: connection!["password"] });
    await voice.disconnectTrunk(trunk.id);
    expect(telnyx.connections.size).toBe(0);
    expect(telnyx.voiceProfiles.size).toBe(0);
    expect([...telnyx.numbers.values()][0]!["connection_id"]).toBeNull();
  });

  it("reads a SIP address's host and port", () => {
    expect(sipHostOf("sip:x.sip.livekit.cloud")).toEqual({ host: "x.sip.livekit.cloud", port: 5060 });
    expect(sipHostOf("sip:user@10.0.0.1:5080;transport=udp")).toEqual({ host: "10.0.0.1", port: 5080 });
    expect(() => sipHostOf("https://nope")).toThrow(/not a SIP address/);
  });
});
