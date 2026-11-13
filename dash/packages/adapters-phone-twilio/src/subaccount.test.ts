import { describe, expect, it } from "vitest";
import { createTwilioProvider, twilioSignature, type TwilioOptions } from "./index.js";

/*
 * Keys scoped to a subaccount, against recorded answers in Twilio's shapes:
 * the subaccount's own SID and token, or the subaccount's SID with the
 * parent's SID and token. Nothing here reaches Twilio.
 */

const PARENT = "AC" + "1".repeat(32);
const SUB = "AC" + "2".repeat(32);
const PARENT_TOKEN = "parent-token";
const SUB_TOKEN = "subaccount-token";
const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

const recorded = () => {
  const calls: Array<{ method: string; url: string; auth: string }> = [];
  const fetch: NonNullable<TwilioOptions["fetch"]> = async (url, init) => {
    calls.push({ method: init.method, url, auth: init.headers["authorization"] ?? "" });
    const path = new URL(url).pathname;
    if (path === `/2010-04-01/Accounts/${SUB}.json`) return { status: 200, text: async () => JSON.stringify({ sid: SUB, owner_account_sid: PARENT, friendly_name: "Acme (sub)", status: "active", type: "Full", auth_token: SUB_TOKEN }) };
    if (path === `/2010-04-01/Accounts/${SUB}/Messages.json`) return { status: 201, text: async () => JSON.stringify({ sid: "SM" + "3".repeat(32), status: "queued" }) };
    if (path === "/v1/Trunks") return { status: 201, text: async () => JSON.stringify({ sid: "TK" + "4".repeat(32) }) };
    return { status: 201, text: async () => JSON.stringify({ sid: "XX" + "5".repeat(32) }) };
  };
  return { calls, fetch };
};

describe("Twilio: keys scoped to a subaccount", () => {
  it("with the subaccount's own SID and token: its paths, its own credentials", async () => {
    const twilio = recorded();
    const keys = { accountSid: SUB, authToken: SUB_TOKEN };
    const provider = createTwilioProvider({ fetch: twilio.fetch })(keys);
    expect(await provider.verify(keys)).toEqual({ name: "Acme (sub)", trial: false });
    await provider.text!.send({ from: "+14155550100", to: "+14155550199", body: "Hi", key: "k" });
    expect(twilio.calls.map((one) => [new URL(one.url).pathname, one.auth])).toEqual([
      [`/2010-04-01/Accounts/${SUB}.json`, basic(SUB, SUB_TOKEN)],
      [`/2010-04-01/Accounts/${SUB}/Messages.json`, basic(SUB, SUB_TOKEN)],
    ]);
  });

  it("with the parent's keys: the subaccount's REST paths as the parent; Twilio's other hosts with the subaccount's own token, read once", async () => {
    const twilio = recorded();
    const keys = { accountSid: SUB, parentSid: PARENT, authToken: PARENT_TOKEN };
    const provider = createTwilioProvider({ fetch: twilio.fetch })(keys);
    await provider.text!.send({ from: "+14155550100", to: "+14155550199", body: "Hi", key: "k" });
    expect(twilio.calls[0]).toMatchObject({ url: `https://api.twilio.com/2010-04-01/Accounts/${SUB}/Messages.json`, auth: basic(PARENT, PARENT_TOKEN) });
    await provider.voice!.connectTrunk({ sipUri: "sip:x.sip.livekit.cloud", numbers: [] });
    const trunking = twilio.calls.filter((one) => new URL(one.url).host === "trunking.twilio.com");
    expect(trunking.length).toBeGreaterThan(0);
    for (const one of trunking) expect(one.auth).toBe(basic(SUB, SUB_TOKEN));
    /* The subaccount's token was read once, as the parent, from its account resource. */
    expect(twilio.calls.filter((one) => new URL(one.url).pathname === `/2010-04-01/Accounts/${SUB}.json`)).toEqual([expect.objectContaining({ auth: basic(PARENT, PARENT_TOKEN) })]);
  });

  it("uses a supplied subaccount token without asking for it, and checks webhooks against either token", async () => {
    const twilio = recorded();
    const keys = { accountSid: SUB, parentSid: PARENT, authToken: PARENT_TOKEN, subaccountToken: SUB_TOKEN };
    const provider = createTwilioProvider({ fetch: twilio.fetch })(keys);
    await provider.voice!.connectTrunk({ sipUri: "sip:x.sip.livekit.cloud", numbers: [] });
    expect(twilio.calls.some((one) => new URL(one.url).pathname === `/2010-04-01/Accounts/${SUB}.json`)).toBe(false);
    const url = "https://dash.example/api/public/local/phone/line-1/text";
    const body = new URLSearchParams({ MessageSid: "SM1", From: "+14155550199", To: "+14155550100", Body: "Hi" }).toString();
    const signed = (token: string) => ({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, url, new URLSearchParams(body)) }, body });
    expect(provider.text!.verify(signed(SUB_TOKEN), keys)).toBe(true);
    expect(provider.text!.verify(signed(PARENT_TOKEN), keys)).toBe(true);
    expect(provider.text!.verify(signed("someone-else"), keys)).toBe(false);
  });

  it("refuses a parent SID that is not one", async () => {
    const provider = createTwilioProvider({ fetch: recorded().fetch })({ accountSid: SUB, parentSid: "nope", authToken: PARENT_TOKEN });
    await expect(provider.numbers.list()).rejects.toThrow(/parent Account SID/);
  });
});
