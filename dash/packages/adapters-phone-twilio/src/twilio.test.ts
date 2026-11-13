import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PhoneKeysError, PhoneParseError, RepeatSendError, type RawRequest } from "@freebirdai/phone";
import { TwilioError, createTwilioProvider, twilioSignature, twilioStatus, type TwilioOptions } from "./index.js";

/*
 * Against recorded answers in the shape Twilio's REST API gives (2010-04-01):
 * nothing here reaches Twilio.
 */

const SID = "AC" + "0123456789abcdef".repeat(2);
const TOKEN = "auth-token-for-tests";
const keys = { accountSid: SID, authToken: TOKEN };

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

/** A pretend Twilio: answers by method and path, and records every request. */
const recorded = (answers: Record<string, { status?: number; body: unknown } | ((call: Call) => { status?: number; body: unknown })>) => {
  const calls: Call[] = [];
  const fetch: NonNullable<TwilioOptions["fetch"]> = async (url, init) => {
    const call = { method: init.method, url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) };
    calls.push(call);
    const path = new URL(url).pathname;
    const found = answers[`${init.method} ${path}`];
    const answer = typeof found === "function" ? found(call) : found;
    if (!answer) return { status: 404, text: async () => JSON.stringify({ code: 20404, message: "The requested resource was not found", status: 404 }) };
    return { status: answer.status ?? 200, text: async () => (answer.body === null ? "" : JSON.stringify(answer.body)) };
  };
  return { calls, fetch };
};

const ACCOUNT = { sid: SID, friendly_name: "Acme Plumbing", status: "active", type: "Full", date_created: "Thu, 01 Oct 2026 12:00:00 +0000" };
const NUMBER = { sid: "PN0123456789abcdef0123456789abcdef", phone_number: "+14155550100", friendly_name: "(415) 555-0100", capabilities: { voice: true, sms: true, mms: true, fax: false } };
const base = `/2010-04-01/Accounts/${SID}`;

describe("Twilio: the account", () => {
  it("names the account and says whether it is a trial, with basic auth", async () => {
    const twilio = recorded({ [`GET ${base}.json`]: { body: ACCOUNT } });
    const provider = createTwilioProvider({ fetch: twilio.fetch })({});
    expect(await provider.verify(keys)).toEqual({ name: "Acme Plumbing", trial: false });
    expect(twilio.calls[0]!.headers["authorization"]).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    const trial = recorded({ [`GET ${base}.json`]: { body: { ...ACCOUNT, type: "Trial" } } });
    expect((await createTwilioProvider({ fetch: trial.fetch })({}).verify(keys)).trial).toBe(true);
  });

  it("refuses keys Twilio refuses, a malformed SID, and a suspended account", async () => {
    const refused = recorded({ [`GET ${base}.json`]: { status: 401, body: { code: 20003, message: "Authenticate", status: 401 } } });
    await expect(createTwilioProvider({ fetch: refused.fetch })({}).verify(keys)).rejects.toBeInstanceOf(PhoneKeysError);
    await expect(createTwilioProvider({ fetch: refused.fetch })({}).verify({ accountSid: "nope", authToken: TOKEN })).rejects.toThrow(/starts with AC/);
    expect(refused.calls).toHaveLength(1);
    const suspended = recorded({ [`GET ${base}.json`]: { body: { ...ACCOUNT, status: "suspended" } } });
    await expect(createTwilioProvider({ fetch: suspended.fetch })({}).verify(keys)).rejects.toThrow(/suspended/);
  });
});

describe("Twilio: numbers", () => {
  it("searches by area code for numbers that can text", async () => {
    const twilio = recorded({
      [`GET ${base}/AvailablePhoneNumbers/US/Local.json`]: {
        body: { available_phone_numbers: [{ friendly_name: "(415) 555-0123", phone_number: "+14155550123", locality: "San Francisco", region: "CA", iso_country: "US", capabilities: { voice: true, SMS: true, MMS: true } }], uri: "" },
      },
    });
    const found = await createTwilioProvider({ fetch: twilio.fetch })(keys).numbers.search({ areaCode: "415" });
    expect(found).toEqual([{ number: "+14155550123", locality: "San Francisco", region: "CA", capabilities: { text: true, voice: true } }]);
    const query = new URL(twilio.calls[0]!.url).searchParams;
    expect(query.get("AreaCode")).toBe("415");
    expect(query.get("SmsEnabled")).toBe("true");
  });

  it("buys, lists, routes texts to the line's webhook, and releases", async () => {
    const twilio = recorded({
      [`POST ${base}/IncomingPhoneNumbers.json`]: { status: 201, body: NUMBER },
      [`GET ${base}/IncomingPhoneNumbers.json`]: { body: { incoming_phone_numbers: [NUMBER] } },
      [`POST ${base}/IncomingPhoneNumbers/${NUMBER.sid}.json`]: { body: NUMBER },
      [`DELETE ${base}/IncomingPhoneNumbers/${NUMBER.sid}.json`]: { status: 204, body: null },
    });
    const numbers = createTwilioProvider({ fetch: twilio.fetch })(keys).numbers;
    expect(await numbers.buy("+14155550100")).toEqual({ number: "+14155550100", providerId: NUMBER.sid, capabilities: { text: true, voice: true } });
    expect(new URLSearchParams(twilio.calls[0]!.body).get("PhoneNumber")).toBe("+14155550100");
    expect((await numbers.list()).map((one) => one.number)).toEqual(["+14155550100"]);
    await numbers.route("+14155550100", { textWebhook: new URL("https://dash.example/api/public/local/phone/line-1/text") });
    const routed = new URLSearchParams(twilio.calls.at(-1)!.body);
    expect(routed.get("SmsUrl")).toBe("https://dash.example/api/public/local/phone/line-1/text");
    expect(routed.get("SmsMethod")).toBe("POST");
    await numbers.release("+14155550100");
    expect(twilio.calls.at(-1)!.method).toBe("DELETE");
    await expect(numbers.route("+14155550100", { voiceSip: { uri: "sip:x" } })).rejects.toBeInstanceOf(TwilioError);
  });

  it("says when a number is not in the account", async () => {
    const twilio = recorded({ [`GET ${base}/IncomingPhoneNumbers.json`]: { body: { incoming_phone_numbers: [] } } });
    await expect(createTwilioProvider({ fetch: twilio.fetch })(keys).numbers.release("+14155550100")).rejects.toThrow(/not in this Twilio account/);
  });
});

describe("Twilio: texts", () => {
  it("sends with a status callback, and refuses a repeated key without asking Twilio again", async () => {
    let made = 0;
    const twilio = recorded({ [`POST ${base}/Messages.json`]: () => ({ status: 201, body: { sid: `SM${String(++made).padStart(32, "0")}`, status: "queued", from: "+14155550100", to: "+14155550199" } }) });
    const open = createTwilioProvider({ fetch: twilio.fetch, statusCallback: (from) => `https://dash.example/api/public/local/phone/line-${from.slice(1)}/status` });
    const sent = await open(keys).text!.send({ from: "+14155550100", to: "+14155550199", body: "Hi", key: "k1" });
    expect(sent).toEqual({ providerId: `SM${"1".padStart(32, "0")}`, status: "queued" });
    const form = new URLSearchParams(twilio.calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({ From: "+14155550100", To: "+14155550199", Body: "Hi", StatusCallback: "https://dash.example/api/public/local/phone/line-14155550100/status" });
    /* Opened again with the same keys: the same provider still knows the key. */
    await expect(open(keys).text!.send({ from: "+14155550100", to: "+14155550199", body: "Hi", key: "k1" })).rejects.toBeInstanceOf(RepeatSendError);
    expect(twilio.calls).toHaveLength(1);
  });

  it("reports Twilio's own refusal in its words", async () => {
    const twilio = recorded({ [`POST ${base}/Messages.json`]: { status: 400, body: { code: 21211, message: "The 'To' number +1555 is not a valid phone number.", status: 400 } } });
    await expect(createTwilioProvider({ fetch: twilio.fetch })(keys).text!.send({ from: "+14155550100", to: "+1555", body: "Hi", key: "k" })).rejects.toMatchObject({ code: 21211, message: expect.stringContaining("not a valid") });
  });

  it("maps every status Twilio sends", () => {
    expect(["accepted", "scheduled", "queued", "sending"].map(twilioStatus)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(["sent", "delivered", "read", "undelivered", "failed", "canceled"].map(twilioStatus)).toEqual(["sent", "delivered", "delivered", "failed", "failed", "failed"]);
  });
});

describe("Twilio: webhooks, verified before they are read", () => {
  it("matches Twilio's published signature example", () => {
    const params: [string, string][] = [
      ["CallSid", "CA1234567890ABCDE"],
      ["Caller", "+12349013030"],
      ["Digits", "1234"],
      ["From", "+12349013030"],
      ["To", "+18005551212"],
    ];
    expect(twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  const URL_TEXT = "https://dash.example/api/public/local/phone/line-1/text";
  const inbound = (fields: Record<string, string>, token = TOKEN, url = URL_TEXT): RawRequest => {
    const body = new URLSearchParams(fields).toString();
    return { method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, url, new URLSearchParams(body)) }, body };
  };
  const FIELDS = { ToCountry: "US", SmsMessageSid: "SM11", NumMedia: "1", MediaUrl0: "https://api.twilio.com/media/ME1", MessageSid: "SM11", From: "+14155550199", To: "+14155550100", Body: "Is Saturday open?", AccountSid: SID, ApiVersion: "2010-04-01" };

  it("accepts a signed text and reads it", () => {
    const text = createTwilioProvider({ now: () => Date.parse("2026-11-12T15:00:00Z") })({}).text!;
    const raw = inbound(FIELDS);
    expect(text.verify(raw, keys)).toBe(true);
    expect(text.parseInbound(raw)).toEqual({ from: "+14155550199", to: "+14155550100", body: "Is Saturday open?", media: ["https://api.twilio.com/media/ME1"], at: "2026-11-12T15:00:00.000Z", providerId: "SM11" });
  });

  it("refuses a changed body, another address, another token, a missing signature or a GET", () => {
    const text = createTwilioProvider()({}).text!;
    const raw = inbound(FIELDS);
    expect(text.verify({ ...raw, body: raw.body.replace("Saturday", "Sunday") }, keys)).toBe(false);
    expect(text.verify({ ...raw, url: `${URL_TEXT}?x=1` }, keys)).toBe(false);
    expect(text.verify(raw, { ...keys, authToken: "other" })).toBe(false);
    expect(text.verify({ ...raw, headers: { "content-type": "application/x-www-form-urlencoded" } }, keys)).toBe(false);
    expect(text.verify({ ...raw, method: "GET" }, keys)).toBe(false);
    expect(text.verify(raw, {})).toBe(false);
  });

  it("checks a JSON body by its own SHA-256 in the signed address", () => {
    const text = createTwilioProvider()({}).text!;
    const body = JSON.stringify({ hello: "world" });
    const url = `${URL_TEXT}?bodySHA256=${createHash("sha256").update(body).digest("hex")}`;
    const raw: RawRequest = { method: "POST", url, headers: { "content-type": "application/json", "x-twilio-signature": twilioSignature(TOKEN, url, []) }, body };
    expect(text.verify(raw, keys)).toBe(true);
    expect(text.verify({ ...raw, body: `${body} ` }, keys)).toBe(false);
  });

  it("reads delivery and call status, and refuses what is not one", () => {
    const text = createTwilioProvider()({}).text!;
    expect(text.parseStatus(inbound({ MessageSid: "SM11", MessageStatus: "undelivered", ErrorCode: "30006", AccountSid: SID }))).toEqual({ providerId: "SM11", status: "failed", errorCode: "30006" });
    expect(text.parseStatus(inbound({ MessageSid: "SM11", MessageStatus: "delivered" }))).toEqual({ providerId: "SM11", status: "delivered" });
    expect(text.parseStatus(inbound({ CallSid: "CA1", CallStatus: "completed", CallDuration: "61" }))).toEqual({ providerId: "CA1", status: "delivered", minutes: 2 });
    expect(() => text.parseStatus(inbound({ Foo: "bar" }))).toThrow(PhoneParseError);
    expect(() => text.parseInbound(inbound({ Body: "no sender" }))).toThrow(PhoneParseError);
    expect(() => text.parseInbound({ ...inbound(FIELDS), headers: { "content-type": "application/json" } })).toThrow(PhoneParseError);
  });
});
