import { describe, expect, it } from "vitest";
import { TRUNKING, createTwilioProvider, type TwilioOptions } from "./index.js";

/* Against recorded answers in Elastic SIP Trunking's shapes: nothing reaches Twilio. */

const SID = "AC" + "0123456789abcdef".repeat(2);
const keys = { accountSid: SID, authToken: "token" };

const pretend = () => {
  const calls: Array<{ method: string; url: string; form: URLSearchParams }> = [];
  const fetch: NonNullable<TwilioOptions["fetch"]> = async (url, init) => {
    calls.push({ method: init.method, url, form: new URLSearchParams(init.body ?? "") });
    const path = url.split("?")[0]!;
    const body =
      path === `${TRUNKING}/Trunks`
        ? { sid: "TK1" }
        : path.endsWith("/CredentialLists.json")
          ? { sid: "CL1" }
          : path.endsWith("/IncomingPhoneNumbers.json")
            ? { incoming_phone_numbers: [{ sid: "PN1", phone_number: "+14155550100", capabilities: { voice: true, sms: true } }] }
            : init.method === "DELETE"
              ? null
              : { sid: "XX1" };
    return { status: init.method === "DELETE" ? 204 : 201, text: async () => (body === null ? "" : JSON.stringify(body)) };
  };
  return { calls, fetch };
};

describe("Twilio calls: the SIP trunk", () => {
  it("points a trunk at the media layer, puts the line's number on it, and gives a termination credential once", async () => {
    const twilio = pretend();
    const voice = createTwilioProvider({ fetch: twilio.fetch })(keys).voice!;
    const trunk = await voice.connectTrunk({ sipUri: "sip:dash.sip.livekit.cloud", numbers: ["+14155550100"] });
    expect(trunk).toMatchObject({
      id: "TK1",
      sipUri: "sip:dash.sip.livekit.cloud",
      numbers: ["+14155550100"],
      termination: { address: expect.stringMatching(/^dash-[0-9a-f]{8}\.pstn\.twilio\.com$/), username: expect.stringMatching(/^dash/), password: expect.any(String) },
    });
    const steps = twilio.calls.map((one) => `${one.method} ${one.url.replace(TRUNKING, "trunking").replace(`https://api.twilio.com/2010-04-01/Accounts/${SID}`, "/acct")}`);
    expect(steps).toEqual([
      "POST trunking/Trunks",
      "POST trunking/Trunks/TK1/OriginationUrls",
      "GET /acct/IncomingPhoneNumbers.json?PhoneNumber=%2B14155550100",
      "POST trunking/Trunks/TK1/PhoneNumbers",
      "POST /acct/SIP/CredentialLists.json",
      "POST /acct/SIP/CredentialLists/CL1/Credentials.json",
      "POST trunking/Trunks/TK1/CredentialLists",
    ]);
    expect(twilio.calls[1]!.form.get("SipUrl")).toBe("sip:dash.sip.livekit.cloud");
    expect(twilio.calls[3]!.form.get("PhoneNumberSid")).toBe("PN1");
    expect(twilio.calls[5]!.form.get("Password")).toBe(trunk.termination!.password);
  });

  it("deletes the trunk to disconnect", async () => {
    const twilio = pretend();
    await createTwilioProvider({ fetch: twilio.fetch })(keys).voice!.disconnectTrunk("TK1");
    expect(twilio.calls).toEqual([expect.objectContaining({ method: "DELETE", url: `${TRUNKING}/Trunks/TK1` })]);
  });
});
