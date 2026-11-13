import { describe, it } from "vitest";
import { providerContractCases } from "@freebirdai/phone/testing";
import { createTwilioProvider, twilioSignature, type TwilioOptions } from "./index.js";

/*
 * The shared provider-contract cases, unchanged, on Twilio's adapter over a
 * pretend Twilio account that answers in the REST, Trunking, Trust Hub and
 * Messaging APIs' shapes. Nothing here reaches Twilio.
 */

const SID = "AC" + "0123456789abcdef".repeat(2);
const TOKEN = "auth-token-for-tests";
const NUMBER = "+14155550100";

type Row = Record<string, unknown>;

const twilioAccount = () => {
  const numbers = new Map<string, Row>([["PN0", { sid: "PN0", phone_number: NUMBER, capabilities: { sms: true, voice: true } }]]);
  const messages: Row[] = [];
  /* Registry decisions, by sid: what `status` reads. */
  const decided = new Map<string, "approved" | "rejected">();
  let made = 0;
  const sid = (prefix: string) => `${prefix}${String(++made).padStart(32 - prefix.length + 2, "0")}`;
  const base = `/2010-04-01/Accounts/${SID}`;

  const answer = (method: string, url: URL, form: URLSearchParams): { status: number; body: unknown } => {
    const path = url.pathname;
    const route = `${method} ${url.host === "api.twilio.com" ? "" : url.host}${path}`;
    if (route === `GET ${base}.json`) return { status: 200, body: { sid: SID, friendly_name: "Acme Plumbing", status: "active", type: "Full" } };
    if (route === `GET ${base}/AvailablePhoneNumbers/US/Local.json`) {
      const area = url.searchParams.get("AreaCode") ?? "555";
      return { status: 200, body: { available_phone_numbers: [0, 1].map((i) => ({ phone_number: `+1${area}55502${i}0`, locality: "Springfield", region: "IL", capabilities: { SMS: true, voice: true } })) } };
    }
    if (route === `GET ${base}/IncomingPhoneNumbers.json`) {
      const only = url.searchParams.get("PhoneNumber");
      return { status: 200, body: { incoming_phone_numbers: [...numbers.values()].filter((row) => !only || row["phone_number"] === only) } };
    }
    if (route === `POST ${base}/IncomingPhoneNumbers.json`) {
      const row = { sid: sid("PN"), phone_number: form.get("PhoneNumber"), capabilities: { sms: true, voice: true } };
      numbers.set(String(row.sid), row);
      return { status: 201, body: row };
    }
    const number = /^\/2010-04-01\/Accounts\/AC\w+\/IncomingPhoneNumbers\/(PN\w+)\.json$/.exec(path)?.[1];
    if (number && method === "POST") return numbers.has(number) ? { status: 200, body: Object.assign(numbers.get(number)!, Object.fromEntries(form)) } : { status: 404, body: { code: 20404 } };
    if (number && method === "DELETE") return numbers.delete(number) ? { status: 204, body: null } : { status: 404, body: { code: 20404 } };
    if (route === `POST ${base}/Messages.json`) {
      const row = { sid: sid("SM"), status: "queued", from: form.get("From"), to: form.get("To") };
      messages.push(row);
      return { status: 201, body: row };
    }
    /* Registration reads. */
    const brand = /^\/v1\/a2p\/BrandRegistrations\/(BN\w+)$/.exec(path)?.[1];
    if (method === "GET" && brand) {
      const state = decided.get(brand);
      return { status: 200, body: { sid: brand, status: state === "approved" ? "APPROVED" : state === "rejected" ? "FAILED" : "PENDING", errors: state === "rejected" ? [{ code: 30794, description: "The legal name does not match the EIN." }] : [] } };
    }
    if (route === "GET messaging.twilio.com/v1/Services") return { status: 200, body: { services: [] } };
    if (method === "GET" && /\/Compliance\/Usa2p\/Usecases$/.test(path)) return { status: 200, body: { us_app_to_person_usecases: [{ code: "ACCOUNT_NOTIFICATION", name: "Account Notification", description: "Status updates", post_approval_required: false }] } };
    const campaign = /\/Compliance\/Usa2p\/(QE\w+)$/.exec(path)?.[1];
    if (method === "GET" && campaign) return { status: 200, body: { sid: campaign, campaign_status: decided.get(campaign) === "approved" ? "VERIFIED" : "IN_PROGRESS", errors: [] } };
    if (method === "DELETE") return { status: 204, body: null };
    /* Everything else made: trunks, credential lists, addresses, profiles, brands, services, campaigns. */
    if (method === "POST") {
      const prefix = /BrandRegistrations$/.test(path) ? "BN" : /Compliance\/Usa2p$/.test(path) ? "QE" : /Services$/.test(path) ? "MG" : /Trunks$/.test(path) ? "TK" : "XX";
      return { status: 201, body: { sid: sid(prefix), status: "draft" } };
    }
    return { status: 404, body: { code: 20404, message: `No ${route}` } };
  };

  const fetch: NonNullable<TwilioOptions["fetch"]> = async (raw, init) => {
    const expected = `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`;
    if (init.headers["authorization"] !== expected) return { status: 401, text: async () => JSON.stringify({ code: 20003, message: "Authenticate", status: 401 }) };
    const result = answer(init.method, new URL(raw), new URLSearchParams(init.body ?? ""));
    return { status: result.status, text: async () => (result.body === null ? "" : JSON.stringify(result.body)) };
  };

  const signed = (url: string, fields: Record<string, string>) => {
    const body = new URLSearchParams(fields).toString();
    return { method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(TOKEN, url, new URLSearchParams(body)) }, body };
  };

  return { fetch, messages, decided, signed };
};

describe("provider contract", () => {
  for (const one of providerContractCases({
    name: "twilio",
    account: () => {
      const twilio = twilioAccount();
      return {
        open: createTwilioProvider({ fetch: twilio.fetch }),
        keys: { accountSid: SID, authToken: TOKEN },
        badKeys: { accountSid: SID, authToken: "someone-elses-token" },
        number: NUMBER,
        areaCode: "415",
        sends: () => twilio.messages.length,
        inbound: (text, url) => twilio.signed(url, { MessageSid: "SM00000000000000000000000000000099", From: text.from, To: text.to, Body: text.body, NumMedia: "0" }),
        status: (providerId, outcome, url) => twilio.signed(url, { MessageSid: providerId, MessageStatus: outcome.status, ...(outcome.status === "failed" ? { ErrorCode: outcome.errorCode } : {}) }),
        settle: (ref, state) => void twilio.decided.set(ref.id.split("/").at(-1)!, state),
        sipUri: "sip:dash-test.sip.livekit.cloud",
      };
    },
  }))
    it(one.name, one.run);
});
