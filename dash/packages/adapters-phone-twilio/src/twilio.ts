import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { e164Schema, type AccountInfo, type AvailableNumber, type DeliveryUpdate, type InboundText, type OwnedNumber, type PhoneDeliveryStatus } from "@freebirdai/dash-spec";
import { twilioRegistration } from "./registration.js";
import { PhoneKeysError, PhoneParseError, RepeatSendError, type OpenPhoneProvider, type PhoneKeys, type PhoneProvider, type RawRequest } from "@freebirdai/phone";

/**
 * Twilio, for Dash Phone: verify an account, search, buy, list, route and
 * release numbers, and send and receive texts. Hand-written over Twilio's
 * REST API (2010-04-01), with nothing but `fetch`.
 *
 * - **Keys** are the Account SID and Auth Token, given for each use; none are
 *   kept. A refused key (401, or 20003) is a `PhoneKeysError`.
 * - **At most once.** Twilio's Messages API has no idempotency key, so a send
 *   key seen before by this provider is refused (`RepeatSendError`) with the
 *   first message's sid. Dash's own ledger (`PhoneUsageStore`) is the durable
 *   guard; this one covers a repeat within one server's life.
 * - **Webhooks** are checked against `X-Twilio-Signature` on the raw request
 *   before anything is read from it: HMAC-SHA1 of the full address plus each
 *   form field's name and value in name order, base64, keyed with the Auth
 *   Token. A JSON body is signed over the address alone and carries its own
 *   SHA-256 in `bodySHA256`.
 * - Registration (A2P 10DLC) is in `registration.ts`. Voice (SIP trunks) is a later phase.
 */

export const TWILIO_PROVIDER_ID = "twilio";
const API = "https://api.twilio.com";

export interface TwilioOptions {
  /** How requests are made. Default: the global `fetch`. Tests give recorded answers. */
  readonly fetch?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ readonly status: number; text(): Promise<string> }>;
  /** Where Twilio posts a sent text's status, for the line that owns this number. Absent: no status callbacks. */
  readonly statusCallback?: (from: string) => string | undefined;
  readonly now?: () => number;
  /** The API's origin. Default https://api.twilio.com. */
  readonly api?: string;
  /** Trust Hub and Messaging, for registration. Defaults: Twilio's own. */
  readonly trustHub?: string;
  readonly messaging?: string;
}

/** A Twilio answer that was not a success, in its own words. */
export class TwilioError extends Error {
  override readonly name = "TwilioError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Twilio's message statuses, in the four words Dash uses. */
export const twilioStatus = (status: string): PhoneDeliveryStatus => {
  switch (status) {
    case "sent":
      return "sent";
    case "delivered":
    case "read":
    case "completed":
      return "delivered";
    case "failed":
    case "undelivered":
    case "canceled":
    case "busy":
    case "no-answer":
      return "failed";
    default:
      return "queued";
  }
};

/** The signature Twilio puts on a form-encoded webhook. */
export const twilioSignature = (authToken: string, url: string, params: Iterable<readonly [string, string]>): string => {
  const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = url + sorted.map(([key, value]) => key + value).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
};

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const isForm = (req: RawRequest): boolean => (req.headers["content-type"] ?? "").toLowerCase().includes("application/x-www-form-urlencoded");

const formOf = (req: RawRequest): URLSearchParams => {
  if (!isForm(req)) throw new PhoneParseError("Twilio sends this webhook as a form.");
  return new URLSearchParams(req.body);
};

const capabilitiesOf = (raw: unknown): { text: boolean; voice: boolean } => {
  const held = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { text: held["sms"] === true || held["SMS"] === true, voice: held["voice"] === true };
};

export const createTwilioProvider = (options: TwilioOptions = {}): OpenPhoneProvider => {
  const doFetch = options.fetch ?? (async (url, init) => fetch(url, init));
  const api = (options.api ?? API).replace(/\/+$/, "");
  const now = options.now ?? (() => Date.now());
  /* Send keys this provider has handed to Twilio, and the sid each became: Twilio has no idempotency key for messages. */
  const sentKeys = new Map<string, string>();
  /* Twilio's words for each registration error code seen, for `explain`. */
  const descriptions = new Map<string, string>();

  return (keys: PhoneKeys): PhoneProvider => {
    const sid = () => {
      const value = keys["accountSid"]?.trim();
      if (!value || !/^AC[0-9a-fA-F]{32}$/.test(value)) throw new PhoneKeysError("The Account SID starts with AC and has 32 more letters and digits.");
      return value;
    };
    /** One request. `path` is under the REST API, or a whole address on another of Twilio's hosts. A form may repeat a field. */
    const call = async (method: string, path: string, form?: Record<string, string> | ReadonlyArray<readonly [string, string]>, given: PhoneKeys = keys): Promise<Record<string, unknown>> => {
      const account = given["accountSid"]?.trim() ?? "";
      const token = given["authToken"]?.trim() ?? "";
      if (!token) throw new PhoneKeysError("Give the Auth Token.");
      const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`${account}:${token}`).toString("base64")}`, accept: "application/json" };
      const body = form ? new URLSearchParams(Array.isArray(form) ? (form as Array<[string, string]>) : (form as Record<string, string>)).toString() : undefined;
      if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
      const answer = await doFetch(path.startsWith("https://") ? path : `${api}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
      const text = await answer.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* A delete answers with nothing. */
      }
      if (answer.status === 401 || parsed["code"] === 20003) throw new PhoneKeysError("Twilio refused these keys. Check the Account SID and Auth Token in the Twilio Console.");
      if (answer.status >= 400) throw new TwilioError(typeof parsed["message"] === "string" ? parsed["message"] : `Twilio answered ${answer.status}.`, answer.status, typeof parsed["code"] === "number" ? parsed["code"] : undefined);
      return parsed;
    };
    const base = () => `/2010-04-01/Accounts/${sid()}`;
    const owned = (raw: Record<string, unknown>): OwnedNumber => ({ number: e164Schema.parse(raw["phone_number"]), providerId: String(raw["sid"]), capabilities: capabilitiesOf(raw["capabilities"]) });
    const numberSid = async (number: string): Promise<string> => {
      const found = await call("GET", `${base()}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: number })}`);
      const list = Array.isArray(found["incoming_phone_numbers"]) ? (found["incoming_phone_numbers"] as Record<string, unknown>[]) : [];
      const one = list.find((row) => row["phone_number"] === number);
      if (!one) throw new TwilioError(`${number} is not in this Twilio account.`, 404);
      return String(one["sid"]);
    };

    return {
      id: TWILIO_PROVIDER_ID,
      title: "Twilio",
      credentials: [
        { key: "accountSid", label: "Account SID", secret: false, help: "In the Twilio Console, on the home page under Account Info. It starts with AC." },
        { key: "authToken", label: "Auth Token", secret: true, help: "Beside the Account SID; press Show to see it. Dash keeps it in its vault and never shows it again." },
      ],
      capabilities: { text: true, voice: "sip", registration: "10dlc" },
      verify: async (given): Promise<AccountInfo> => {
        const account = given["accountSid"]?.trim() ?? "";
        if (!/^AC[0-9a-fA-F]{32}$/.test(account)) throw new PhoneKeysError("The Account SID starts with AC and has 32 more letters and digits.");
        const answer = await call("GET", `/2010-04-01/Accounts/${account}.json`, undefined, given);
        if (answer["status"] !== undefined && answer["status"] !== "active") throw new PhoneKeysError(`This Twilio account is ${String(answer["status"])}, not active.`);
        return { name: String(answer["friendly_name"] ?? ""), trial: String(answer["type"] ?? "").toLowerCase() === "trial" };
      },
      numbers: {
        search: async (q): Promise<AvailableNumber[]> => {
          const query = new URLSearchParams({ SmsEnabled: "true", PageSize: "20", ...(q.areaCode && /^\d{3}$/.test(q.areaCode) ? { AreaCode: q.areaCode } : {}) });
          const found = await call("GET", `${base()}/AvailablePhoneNumbers/US/Local.json?${query}`);
          const list = Array.isArray(found["available_phone_numbers"]) ? (found["available_phone_numbers"] as Record<string, unknown>[]) : [];
          return list.map((row) => ({
            number: e164Schema.parse(row["phone_number"]),
            ...(typeof row["locality"] === "string" && row["locality"] ? { locality: row["locality"] } : {}),
            ...(typeof row["region"] === "string" && row["region"] ? { region: row["region"] } : {}),
            capabilities: capabilitiesOf(row["capabilities"]),
          }));
        },
        buy: async (number) => owned(await call("POST", `${base()}/IncomingPhoneNumbers.json`, { PhoneNumber: e164Schema.parse(number) })),
        list: async () => {
          const found = await call("GET", `${base()}/IncomingPhoneNumbers.json?PageSize=1000`);
          return (Array.isArray(found["incoming_phone_numbers"]) ? (found["incoming_phone_numbers"] as Record<string, unknown>[]) : []).map(owned);
        },
        route: async (number, to) => {
          if (to.voiceSip) throw new TwilioError("Calls are routed through a SIP trunk, which comes with Dash Phone's calls.", 501);
          if (!to.textWebhook) return;
          await call("POST", `${base()}/IncomingPhoneNumbers/${await numberSid(number)}.json`, { SmsUrl: to.textWebhook.toString(), SmsMethod: "POST" });
        },
        release: async (number) => {
          await call("DELETE", `${base()}/IncomingPhoneNumbers/${await numberSid(number)}.json`);
        },
      },
      registration: twilioRegistration({ call, accountBase: base, numberSid, descriptions, ...(options.trustHub ? { trustHub: options.trustHub } : {}), ...(options.messaging ? { messaging: options.messaging } : {}) }),
      text: {
        send: async (m) => {
          const earlier = sentKeys.get(m.key);
          if (earlier) throw new RepeatSendError(m.key, earlier);
          const callback = options.statusCallback?.(m.from);
          const answer = await call("POST", `${base()}/Messages.json`, { From: m.from, To: m.to, Body: m.body, ...(callback ? { StatusCallback: callback } : {}) });
          const providerId = String(answer["sid"] ?? "");
          if (!providerId) throw new TwilioError("Twilio did not say which message it made.", 502);
          sentKeys.set(m.key, providerId);
          if (sentKeys.size > 10_000) sentKeys.delete(sentKeys.keys().next().value!);
          return { providerId, status: twilioStatus(String(answer["status"] ?? "queued")) };
        },
        verify: (req, given) => {
          const token = given["authToken"]?.trim();
          const signature = req.headers["x-twilio-signature"];
          if (!token || !signature || req.method.toUpperCase() !== "POST") return false;
          if (isForm(req)) return same(signature, twilioSignature(token, req.url, new URLSearchParams(req.body)));
          /* A JSON body: the address is signed, and it carries the body's own SHA-256. */
          const claimed = new URL(req.url).searchParams.get("bodySHA256");
          if (!claimed || !same(claimed, createHash("sha256").update(req.body, "utf8").digest("hex"))) return false;
          return same(signature, twilioSignature(token, req.url, []));
        },
        parseInbound: (req): InboundText => {
          const form = formOf(req);
          const media: string[] = [];
          const count = Math.min(Number(form.get("NumMedia") ?? 0) || 0, 10);
          for (let i = 0; i < count; i++) {
            const url = form.get(`MediaUrl${i}`);
            if (url) media.push(url);
          }
          const from = e164Schema.safeParse(form.get("From"));
          const to = e164Schema.safeParse(form.get("To"));
          const providerId = form.get("MessageSid") ?? form.get("SmsSid");
          if (!from.success || !to.success || !providerId) throw new PhoneParseError("This is not a text Twilio delivered: From, To or MessageSid is missing.");
          return { from: from.data, to: to.data, body: form.get("Body") ?? "", media, at: new Date(now()).toISOString(), providerId };
        },
        parseStatus: (req): DeliveryUpdate => {
          const form = formOf(req);
          const message = form.get("MessageSid") ?? form.get("SmsSid");
          const callSid = form.get("CallSid");
          const providerId = message ?? callSid;
          const status = form.get("MessageStatus") ?? form.get("SmsStatus") ?? form.get("CallStatus");
          if (!providerId || !status) throw new PhoneParseError("This is not a status Twilio sent: the sid or status is missing.");
          const errorCode = form.get("ErrorCode");
          const duration = Number(form.get("CallDuration") ?? Number.NaN);
          return {
            providerId,
            status: twilioStatus(status),
            ...(errorCode ? { errorCode } : {}),
            ...(callSid && !message && Number.isFinite(duration) ? { minutes: Math.ceil(duration / 60) } : {}),
          };
        },
      },
    };
  };
};
