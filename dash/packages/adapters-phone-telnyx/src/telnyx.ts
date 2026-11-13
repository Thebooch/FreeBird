import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { e164Schema, type AccountInfo, type AvailableNumber, type DeliveryUpdate, type InboundText, type OwnedNumber, type PhoneDeliveryStatus } from "@freebirdai/dash-spec";
import { PhoneKeysError, PhoneParseError, RepeatSendError, type OpenPhoneProvider, type PhoneKeys, type PhoneProvider, type RawRequest } from "@freebirdai/phone";
import { TelnyxError } from "./errors.js";
import { telnyxRegistration } from "./registration.js";
import { telnyxVoice } from "./voice.js";

/**
 * Telnyx, for Dash Phone: verify an account, search, buy, list, route and
 * release numbers, and send and receive texts. Hand-written over Telnyx's
 * API v2 (https://api.telnyx.com/v2, `Authorization: Bearer <API key>`),
 * with nothing but `fetch`. Checked against Telnyx's developer docs on
 * 2026-11-13:
 *
 * - Keys and errors: https://developers.telnyx.com/docs/messaging/messages/send-message
 *   (Bearer key; errors as `errors[]` with `code`, `title`, `detail`; a
 *   refused key is 401 with code `10009`).
 * - Account: https://developers.telnyx.com/api-reference/billing/get-user-balance-details.md
 *   (`GET /balance`) and https://developers.telnyx.com/api-reference/user-profile/retrieve-the-current-user-profile-beta.md
 *   (`GET /user_profile`, beta: `business_name`, `country`). Telnyx has no
 *   trial flag in either, so `trial` is always false (unconfirmed).
 * - Numbers: https://developers.telnyx.com/api/numbers/list-available-phone-numbers
 *   (`filter[country_code]`, `filter[national_destination_code]`,
 *   `filter[features]`, `filter[phone_number_type]`, `filter[limit]`;
 *   `cost_information.monthly_cost`), https://developers.telnyx.com/api-reference/phone-number-orders/create-a-number-order.md
 *   (`POST /number_orders`, `phone_numbers: [{ phone_number }]`),
 *   https://developers.telnyx.com/api/numbers/list-phone-numbers
 *   (`page[size]` up to 250, `filter[phone_number]`) and
 *   https://developers.telnyx.com/api-reference/phone-number-configurations/delete-a-phone-number.md.
 *   The wire form of an array filter (`filter[features][]=sms`) is not shown
 *   on the page; it is the deepObject style the page names (unconfirmed).
 * - Routing texts: a messaging profile per line, its `webhook_url` the line's
 *   address (https://developers.telnyx.com/api-reference/profiles/create-a-messaging-profile.md,
 *   `name` and `whitelisted_destinations` required), and the number put on it
 *   (`PATCH /phone_numbers/{id}/messaging`, https://developers.telnyx.com/api-reference/number-settings/update-the-messaging-profile-andor-messaging-product-of-a-phone-number.md).
 *   The profile is made with `redaction_enabled: false`, so inbound webhooks
 *   carry the text (the page's `redaction_level` says level 2 redacts them).
 * - **At most once.** `POST /messages` takes an `Idempotency-Key` header
 *   (1 to 255 letters, digits, `-`, `_`): a repeat within 24 hours is answered
 *   with the first message and `Idempotent-Replayed: true`, which this adapter
 *   turns into `RepeatSendError`; a repeat still in flight is a 409. Dash's
 *   send key is hashed into that alphabet. (OpenAPI `IdempotencyKey`,
 *   https://developers.telnyx.com/api/messaging/send-message.)
 * - **Webhooks** are checked before anything is read: an Ed25519 signature
 *   (`telnyx-signature-ed25519`, base64) over `<telnyx-timestamp>|<raw body>`,
 *   with the account's public key (Mission Control → Keys & Credentials →
 *   Public Key), and a timestamp no more than 5 minutes off
 *   (https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks,
 *   https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks).
 *   The pages' samples disagree on the key's form (raw 32 bytes, or SPKI
 *   DER), so both are taken.
 * - Inbound texts are `message.received`; statuses are `message.sent` and
 *   `message.finalized`, the recipient's status in `payload.to[].status` and
 *   the reason in `payload.errors[]`.
 *
 * Registration (10DLC) is in `registration.ts`; calls (an FQDN connection to
 * the media layer) in `voice.ts`.
 */

export { TelnyxError };

export const TELNYX_PROVIDER_ID = "telnyx";
export const TELNYX_API = "https://api.telnyx.com/v2";
export const TELNYX_SIGNATURE_HEADER = "telnyx-signature-ed25519";
export const TELNYX_TIMESTAMP_HEADER = "telnyx-timestamp";
/** How far a webhook's timestamp may be from now, in seconds. */
export const TELNYX_TOLERANCE_SECONDS = 300;

export type TelnyxFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ readonly status: number; readonly headers?: { get(name: string): string | null }; text(): Promise<string> }>;

export interface TelnyxOptions {
  /** How requests are made. Default: the global `fetch`. Tests give recorded answers. */
  readonly fetch?: TelnyxFetch;
  /** Where Telnyx posts a sent text's status, for the line that owns this number. Absent: the messaging profile's webhook. */
  readonly statusCallback?: (from: string) => string | undefined;
  readonly now?: () => number;
  /** The API's base. Default https://api.telnyx.com/v2. */
  readonly api?: string;
}


/** Telnyx's per-recipient message statuses, in the four words Dash uses. */
export const telnyxStatus = (status: string): PhoneDeliveryStatus => {
  switch (status) {
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "sending_failed":
    case "delivery_failed":
    case "expired":
      return "failed";
    /* `delivery_unconfirmed`: the carrier gave no receipt. It went out, so it stays sent. */
    case "delivery_unconfirmed":
      return "sent";
    default:
      return "queued";
  }
};

/** Dash's send key in the alphabet Telnyx's `Idempotency-Key` takes. */
export const telnyxIdempotencyKey = (key: string): string => (/^[A-Za-z0-9_-]{1,255}$/.test(key) ? key : `dash-${createHash("sha256").update(key).digest("hex")}`);

/* The DER header of an Ed25519 SubjectPublicKeyInfo, before the 32 key bytes. */
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** The account's webhook public key, as base64 of the raw 32 bytes or of the SPKI DER. */
export const telnyxPublicKey = (base64: string): KeyObject | null => {
  try {
    const bytes = Buffer.from(base64.trim(), "base64");
    const der = bytes.length === 32 ? Buffer.concat([SPKI_ED25519, bytes]) : bytes;
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return null;
  }
};

const errorsOf = (parsed: Record<string, unknown>): Array<Record<string, unknown>> => (Array.isArray(parsed["errors"]) ? (parsed["errors"] as Array<Record<string, unknown>>) : []);

const dataOf = (parsed: Record<string, unknown>): Record<string, unknown> => {
  const data = parsed["data"];
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : parsed;
};

const listOf = (parsed: Record<string, unknown>): Array<Record<string, unknown>> => (Array.isArray(parsed["data"]) ? (parsed["data"] as Array<Record<string, unknown>>) : []);

/** A JSON webhook's envelope: `data.event_type` and `data.payload`. Only called on a request `verify` accepted. */
const eventOf = (req: RawRequest): { type: string; payload: Record<string, unknown>; at?: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body) as unknown;
  } catch {
    throw new PhoneParseError("Telnyx sends webhooks as JSON; this body is not.");
  }
  const data = (parsed as { data?: Record<string, unknown> } | null)?.data;
  const payload = data?.["payload"];
  if (!data || typeof data["event_type"] !== "string" || !payload || typeof payload !== "object") throw new PhoneParseError("This is not a Telnyx webhook: data.event_type or data.payload is missing.");
  return { type: data["event_type"], payload: payload as Record<string, unknown>, ...(typeof data["occurred_at"] === "string" ? { at: data["occurred_at"] } : {}) };
};

const numberIn = (raw: unknown): string | undefined => {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>)["phone_number"] : raw;
  const parsed = e164Schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const createTelnyxProvider = (options: TelnyxOptions = {}): OpenPhoneProvider => {
  const doFetch: TelnyxFetch = options.fetch ?? (async (url, init) => fetch(url, init));
  const api = (options.api ?? TELNYX_API).replace(/\/+$/, "");
  const now = options.now ?? (() => Date.now());

  return (keys: PhoneKeys): PhoneProvider => {
    /** One request under the API. A refused key is a `PhoneKeysError`; any other failure a `TelnyxError` in Telnyx's words. */
    const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}, given: PhoneKeys = keys): Promise<{ parsed: Record<string, unknown>; replayed: boolean }> => {
      const token = given["apiKey"]?.trim();
      if (!token) throw new PhoneKeysError("Give the API key.");
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", ...extra };
      if (body !== undefined) headers["content-type"] = "application/json";
      const answer = await doFetch(`${api}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await answer.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* A delete may answer with nothing. */
      }
      const first = errorsOf(parsed)[0];
      const code = first && first["code"] !== undefined ? String(first["code"]) : undefined;
      if (answer.status === 401 || code === "10009") throw new PhoneKeysError("Telnyx refused this API key. Check it in Mission Control under Keys & Credentials → API Keys.");
      if (answer.status >= 400) {
        const words = [first?.["title"], first?.["detail"]].filter((one): one is string => typeof one === "string" && one.length > 0).join(": ");
        throw new TelnyxError(words || `Telnyx answered ${answer.status}.`, answer.status, code);
      }
      return { parsed, replayed: (answer.headers?.get("idempotent-replayed") ?? "").toLowerCase() === "true" };
    };
    const get = async (path: string) => (await call("GET", path)).parsed;
    /** The id Telnyx gives a number in this account. */
    const numberId = async (number: string): Promise<string> => {
      const found = listOf(await get(`/phone_numbers?${new URLSearchParams({ "filter[phone_number]": number.replace(/^\+/, ""), "page[size]": "20" })}`));
      const one = found.find((row) => row["phone_number"] === number);
      if (!one) throw new TelnyxError(`${number} is not in this Telnyx account.`, 404);
      return String(one["id"]);
    };
    const owned = (row: Record<string, unknown>): OwnedNumber => ({ number: e164Schema.parse(row["phone_number"]), providerId: String(row["id"]), capabilities: { text: true, voice: true } });

    return {
      id: TELNYX_PROVIDER_ID,
      title: "Telnyx",
      credentials: [
        { key: "apiKey", label: "API key", secret: true, help: "In the Telnyx Mission Control Portal, under Keys & Credentials → API Keys. Create one for Dash; Dash keeps it in its vault and never shows it again." },
        { key: "publicKey", label: "Public key", secret: false, help: "On the same page, under Public Key: Telnyx signs its webhooks with the matching private key, and Dash checks every one with this." },
      ],
      capabilities: { text: true, voice: "sip", registration: "10dlc" },
      verify: async (given): Promise<AccountInfo> => {
        if (!telnyxPublicKey(given["publicKey"] ?? "")) throw new PhoneKeysError("The public key is the base64 text under Keys & Credentials → Public Key.");
        await call("GET", "/balance", undefined, {}, given);
        let name = "";
        let country: string | undefined;
        try {
          const profile = dataOf((await call("GET", "/user_profile", undefined, {}, given)).parsed);
          name = String(profile["business_name"] ?? [profile["first_name"], profile["last_name"]].filter(Boolean).join(" "));
          if (typeof profile["country"] === "string" && profile["country"].length === 2) country = profile["country"];
        } catch (error) {
          /* The profile is in beta: the key already worked on the balance, so a missing name is not a refusal. */
          if (error instanceof PhoneKeysError) throw error;
        }
        return { name: name.slice(0, 200), ...(country ? { country } : {}), trial: false };
      },
      numbers: {
        search: async (q): Promise<AvailableNumber[]> => {
          const query = new URLSearchParams({ "filter[country_code]": "US", "filter[phone_number_type]": "local", "filter[features][]": "sms", "filter[limit]": "20" });
          if (q.areaCode && /^\d{3}$/.test(q.areaCode)) query.set("filter[national_destination_code]", q.areaCode);
          return listOf(await get(`/available_phone_numbers?${query}`)).map((row) => {
            const regions = Array.isArray(row["region_information"]) ? (row["region_information"] as Array<Record<string, unknown>>) : [];
            const region = (type: string) => regions.find((one) => one["region_type"] === type)?.["region_name"];
            const features = Array.isArray(row["features"]) ? (row["features"] as Array<Record<string, unknown>>).map((one) => one["name"]) : [];
            const cost = (row["cost_information"] ?? {}) as Record<string, unknown>;
            const state = region("state");
            const locality = region("rate_center") ?? region("location");
            return {
              number: e164Schema.parse(row["phone_number"]),
              ...(typeof locality === "string" && locality ? { locality } : {}),
              ...(typeof state === "string" && state ? { region: state } : {}),
              ...(typeof cost["monthly_cost"] === "string" && typeof cost["currency"] === "string" && cost["currency"].length === 3 ? { monthlyPrice: { amount: cost["monthly_cost"], currency: cost["currency"] } } : {}),
              capabilities: { text: features.includes("sms"), voice: features.includes("voice") },
            };
          });
        },
        buy: async (number) => {
          const parsed = e164Schema.parse(number);
          const order = dataOf((await call("POST", "/number_orders", { phone_numbers: [{ phone_number: parsed }] })).parsed);
          const status = String(order["status"] ?? "");
          if (status === "failure") throw new TelnyxError(`Telnyx could not order ${parsed}.`, 422);
          /* The order's line for the number; once the order is done, `list()` gives the number's own id. */
          const line = (Array.isArray(order["phone_numbers"]) ? (order["phone_numbers"] as Array<Record<string, unknown>>) : []).find((one) => one["phone_number"] === parsed);
          return { number: parsed, providerId: String(line?.["id"] ?? order["id"] ?? parsed), capabilities: { text: true, voice: true } };
        },
        list: async () => {
          const out: OwnedNumber[] = [];
          for (let page = 1; page <= 20; page++) {
            const found = await get(`/phone_numbers?${new URLSearchParams({ "page[size]": "250", "page[number]": String(page) })}`);
            out.push(...listOf(found).map(owned));
            const meta = (found["meta"] ?? {}) as Record<string, unknown>;
            if (!(Number(meta["total_pages"] ?? 1) > page)) break;
          }
          return out;
        },
        route: async (number, to) => {
          if (to.voiceSip) throw new TelnyxError("Calls are routed through a SIP connection: Connect calls on the line.", 501);
          if (!to.textWebhook) return;
          const id = await numberId(number);
          const name = `Dash ${number}`;
          const profiles = listOf(await get(`/messaging_profiles?${new URLSearchParams({ "filter[name]": name, "page[size]": "50" })}`));
          const held = profiles.find((one) => one["name"] === name);
          const settings = { webhook_url: to.textWebhook.toString(), webhook_api_version: "2", redaction_enabled: false };
          const profile = held
            ? String(held["id"])
            : String(dataOf((await call("POST", "/messaging_profiles", { name, whitelisted_destinations: ["US", "CA"], enabled: true, ...settings })).parsed)["id"]);
          if (held) await call("PATCH", `/messaging_profiles/${profile}`, settings);
          await call("PATCH", `/phone_numbers/${id}/messaging`, { messaging_profile_id: profile });
        },
        release: async (number) => {
          await call("DELETE", `/phone_numbers/${await numberId(number)}`);
        },
      },
      voice: telnyxVoice({ call: async (method, path, body) => (await call(method, path, body)).parsed, numberId }),
      registration: telnyxRegistration({ call: async (method, path, body) => (await call(method, path, body)).parsed }),
      text: {
        send: async (m) => {
          const callback = options.statusCallback?.(m.from);
          let answer: Awaited<ReturnType<typeof call>>;
          try {
            answer = await call("POST", "/messages", { from: m.from, to: m.to, text: m.body, ...(callback ? { webhook_url: callback, use_profile_webhooks: false } : {}) }, { "idempotency-key": telnyxIdempotencyKey(m.key) });
          } catch (error) {
            /* The same key still in flight. */
            if (error instanceof TelnyxError && error.status === 409) throw new RepeatSendError(m.key, "in flight");
            throw error;
          }
          const data = dataOf(answer.parsed);
          const providerId = String(data["id"] ?? "");
          if (!providerId) throw new TelnyxError("Telnyx did not say which message it made.", 502);
          if (answer.replayed) throw new RepeatSendError(m.key, providerId);
          const recipient = (Array.isArray(data["to"]) ? (data["to"] as Array<Record<string, unknown>>) : [])[0];
          return { providerId, status: telnyxStatus(String(recipient?.["status"] ?? "queued")) };
        },
        verify: (req, given) => {
          const key = telnyxPublicKey(given["publicKey"] ?? "");
          const signature = req.headers[TELNYX_SIGNATURE_HEADER];
          const timestamp = req.headers[TELNYX_TIMESTAMP_HEADER];
          if (!key || !signature || !timestamp || req.method.toUpperCase() !== "POST" || !/^\d{1,12}$/.test(timestamp)) return false;
          if (Math.abs(now() / 1000 - Number(timestamp)) > TELNYX_TOLERANCE_SECONDS) return false;
          try {
            return verifySignature(null, Buffer.from(`${timestamp}|${req.body}`, "utf8"), key, Buffer.from(signature, "base64"));
          } catch {
            return false;
          }
        },
        parseInbound: (req): InboundText => {
          const event = eventOf(req);
          if (event.type !== "message.received") throw new PhoneParseError(`This is a Telnyx "${event.type}" webhook, not an inbound text.`);
          const p = event.payload;
          const from = numberIn(p["from"]);
          const to = numberIn((Array.isArray(p["to"]) ? p["to"] : [p["to"]])[0]);
          const providerId = typeof p["id"] === "string" ? p["id"] : undefined;
          if (!from || !to || !providerId) throw new PhoneParseError("This is not a text Telnyx delivered: from, to or id is missing.");
          const media = (Array.isArray(p["media"]) ? (p["media"] as Array<Record<string, unknown>>) : [])
            .map((one) => one["url"])
            .filter((url): url is string => typeof url === "string")
            .slice(0, 10);
          const at = typeof p["received_at"] === "string" ? p["received_at"] : event.at;
          return { from, to, body: typeof p["text"] === "string" ? p["text"] : "", media, at: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date(now()).toISOString(), providerId };
        },
        parseStatus: (req): DeliveryUpdate => {
          const event = eventOf(req);
          if (event.type !== "message.sent" && event.type !== "message.finalized") throw new PhoneParseError(`This is a Telnyx "${event.type}" webhook, not a status update.`);
          const p = event.payload;
          const recipient = (Array.isArray(p["to"]) ? (p["to"] as Array<Record<string, unknown>>) : [])[0];
          const providerId = typeof p["id"] === "string" ? p["id"] : undefined;
          const status = recipient?.["status"];
          if (!providerId || typeof status !== "string") throw new PhoneParseError("This is not a status Telnyx sent: the id or the recipient's status is missing.");
          const error = errorsOf(p)[0];
          const errorCode = error?.["code"] !== undefined ? String(error["code"]) : undefined;
          return { providerId, status: telnyxStatus(status), ...(errorCode ? { errorCode } : {}) };
        },
      },
    };
  };
};
