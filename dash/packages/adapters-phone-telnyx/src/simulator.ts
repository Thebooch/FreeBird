import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import type { DeliveryUpdate } from "@freebirdai/dash-spec";
import { RepeatSendError, type CallPlacer, type OpenPhoneProvider, type PhoneKeys, type RawRequest } from "@freebirdai/phone";
import { TELNYX_API, TELNYX_SIGNATURE_HEADER, TELNYX_TIMESTAMP_HEADER, createTelnyxProvider, type TelnyxFetch } from "./telnyx.js";

/**
 * A pretend Telnyx account, in process: the parts of API v2 the adapter
 * calls, answered in the shapes Telnyx's API reference gives, and webhooks
 * signed with a real Ed25519 key as Telnyx signs them. For contract tests and
 * sandboxes: nothing reaches Telnyx and nothing is spent.
 *
 * Everything it keeps is in maps and arrays it owns, so a sandbox snapshot of
 * it restores it (an idempotency key included: a restored account sends
 * again).
 */

export interface SimulatedText {
  readonly providerId: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly key: string;
  readonly at: string;
}

export interface SimulatedCall {
  readonly providerId: string;
  readonly from: string;
  readonly to: string;
  readonly purpose: string;
  readonly key: string;
  readonly maxMinutes: number;
  readonly at: string;
}

export interface TelnyxSimulatorOptions {
  readonly apiKey?: string;
  readonly businessName?: string;
  readonly now?: () => number;
  /** Numbers already in the account. */
  readonly numbers?: readonly string[];
}

type Row = Record<string, unknown>;

const hash = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16);

/** The path words of the API; any other segment is an id. */
const WORDS = new Set(["balance", "user_profile", "available_phone_numbers", "number_orders", "phone_numbers", "messaging", "messaging_profiles", "messages", "10dlc", "brand", "enum", "usecase", "campaignBuilder", "campaign", "phone_number_campaigns", "outbound_voice_profiles", "fqdn_connections", "fqdns"]);

const USE_CASES = ["ACCOUNT_NOTIFICATION", "CUSTOMER_CARE", "DELIVERY_NOTIFICATION", "MARKETING", "MIXED", "LOW_VOLUME", "POLITICAL"];

export class TelnyxSimulator {
  readonly apiKey: string;
  /** The account's webhook public key, base64 of the raw 32 bytes, as Mission Control shows it. */
  readonly publicKey: string;
  /** Its private key, PEM: only the simulator signs with it. */
  readonly privateKeyPem: string;
  readonly businessName: string;

  /** Every text the API sent, in order. */
  readonly sent: SimulatedText[] = [];
  /** Every call placed through `placer` (the media layer, not Telnyx). */
  readonly calls: SimulatedCall[] = [];
  /** Every request the adapter made: method and path. */
  readonly requests: string[] = [];
  readonly numbers = new Map<string, Row>();
  readonly profiles = new Map<string, Row>();
  readonly idempotency = new Map<string, Row>();
  readonly brands = new Map<string, Row>();
  readonly campaigns = new Map<string, Row>();
  readonly assignments = new Map<string, Row>();
  readonly connections = new Map<string, Row>();
  readonly voiceProfiles = new Map<string, Row>();
  readonly fqdns = new Map<string, Row>();
  /** Numbers whose texts it fails to deliver, with the error code it reports. */
  readonly failures = new Map<string, string>();
  /** Status webhooks it owes, oldest first. */
  readonly pending: DeliveryUpdate[] = [];
  /** Reasons the next brand or campaign submissions fail with, one each. */
  readonly rejections: string[] = [];

  private readonly now: () => number;

  constructor(options: TelnyxSimulatorOptions = {}) {
    this.apiKey = options.apiKey ?? "KEYsimulated_telnyx";
    this.businessName = options.businessName ?? "Simulated Telnyx account";
    this.now = options.now ?? (() => Date.now());
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.publicKey = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");
    this.privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    for (const number of options.numbers ?? []) this.addNumber(number);
  }

  /** The keys a line on this account holds. */
  get keys(): PhoneKeys {
    return { apiKey: this.apiKey, publicKey: this.publicKey };
  }

  /** The Telnyx adapter, talking to this account. */
  readonly open: OpenPhoneProvider = (keys) => createTelnyxProvider({ fetch: this.fetch, now: this.now })(keys);

  /** The API, as `fetch` answers it. */
  readonly fetch: TelnyxFetch = async (url, init) => {
    const replayed = { value: false };
    const reply = (status: number, body: unknown) => ({ status, headers: { get: (name: string) => (name.toLowerCase() === "idempotent-replayed" && replayed.value ? "true" : null) }, text: async () => (body === null ? "" : JSON.stringify(body)) });
    const where = new URL(url);
    const path = where.pathname.replace(new URL(TELNYX_API).pathname, "");
    this.requests.push(`${init.method} ${path}`);
    if (init.headers["authorization"] !== `Bearer ${this.apiKey}`) return reply(401, { errors: [{ code: "10009", title: "Authentication failed", detail: "Could not understand the provided credentials." }] });
    const body = (init.body ? JSON.parse(init.body) : {}) as Row;
    const answer = this.answer(init.method, path, where.searchParams, body, init.headers, replayed);
    return reply(answer.status, answer.body);
  };

  /* ── what a scenario makes happen ──────────────────────────────────── */

  addNumber(number: string): Row {
    const row = { id: `${1000000 + this.numbers.size}`, record_type: "phone_number", phone_number: number, status: "active", messaging_profile_id: null, connection_id: null };
    this.numbers.set(row.id, row);
    return row;
  }

  /** A webhook as Telnyx sends it: JSON, signed over `<timestamp>|<body>`. */
  request(url: string, body: string, at = this.now()): RawRequest {
    const timestamp = String(Math.floor(at / 1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`, "utf8"), createPrivateKey(this.privateKeyPem)).toString("base64");
    return { method: "POST", url, headers: { "content-type": "application/json", [TELNYX_SIGNATURE_HEADER]: signature, [TELNYX_TIMESTAMP_HEADER]: timestamp }, body };
  }

  private event(type: string, payload: Row): string {
    const at = new Date(this.now()).toISOString();
    return JSON.stringify({ data: { record_type: "event", event_type: type, id: `evt-${hash(`${type}:${JSON.stringify(payload)}:${at}`)}`, occurred_at: at, payload }, meta: { attempt: 1 } });
  }

  /** Someone texts a number on this account. */
  inboundText(text: { readonly from: string; readonly to: string; readonly body: string; readonly media?: readonly string[] }, url: string): RawRequest {
    const at = new Date(this.now()).toISOString();
    const payload = {
      id: `in-${hash(`${text.from}:${text.to}:${at}:${text.body}`)}`,
      record_type: "message",
      direction: "inbound",
      type: (text.media?.length ?? 0) > 0 ? "MMS" : "SMS",
      from: { phone_number: text.from, carrier: "Simulated", line_type: "Wireless" },
      to: [{ phone_number: text.to, status: "webhook_delivered" }],
      text: text.body,
      media: (text.media ?? []).map((url) => ({ url, content_type: "image/jpeg" })),
      received_at: at,
      errors: [],
    };
    return this.request(url, this.event("message.received", payload));
  }

  stopReply(from: string, to: string, url: string): RawRequest {
    return this.inboundText({ from, to, body: "STOP" }, url);
  }

  failDelivery(to: string, errorCode = "40300"): void {
    this.failures.set(to, errorCode);
  }

  /** The status webhooks it owes, handed over once. */
  takeUpdates(): DeliveryUpdate[] {
    return this.pending.splice(0, this.pending.length);
  }

  /** A status update as Telnyx's signed `message.finalized` webhook. */
  statusRequest(update: DeliveryUpdate, url: string): RawRequest {
    const sent = this.sent.find((one) => one.providerId === update.providerId);
    const status = update.status === "failed" ? "delivery_failed" : update.status;
    const payload = {
      id: update.providerId,
      record_type: "message",
      direction: "outbound",
      from: { phone_number: sent?.from ?? "" },
      to: [{ phone_number: sent?.to ?? "", status }],
      errors: update.errorCode ? [{ code: update.errorCode, title: "Destination number unreachable" }] : [],
    };
    return this.request(url, this.event(update.status === "sent" ? "message.sent" : "message.finalized", payload));
  }

  /** Decides a pending brand or campaign, as the registry would. */
  settle(id: string, state: "approved" | "rejected", reason = "The EIN does not match the company name."): void {
    const brand = this.brands.get(id);
    if (brand) {
      Object.assign(brand, state === "approved" ? { identityStatus: "VERIFIED", status: "OK" } : { identityStatus: "UNVERIFIED", status: "REGISTRATION_FAILED", failureReasons: reason });
      return;
    }
    const campaign = this.campaigns.get(id);
    if (!campaign) throw new Error(`The simulated Telnyx account has no submission "${id}".`);
    Object.assign(campaign, state === "approved" ? { campaignStatus: "MNO_PROVISIONED" } : { campaignStatus: "TELNYX_FAILED", failureReasons: reason });
  }

  /** Places calls: the media layer's part, recorded. */
  readonly placer: CallPlacer = {
    place: async (call) => {
      const earlier = this.calls.find((one) => one.key === call.key);
      if (earlier) throw new RepeatSendError(call.key, earlier.providerId);
      const providerId = `call-${hash(call.key)}`;
      this.calls.push({ providerId, from: call.from, to: call.to, purpose: call.purpose, key: call.key, maxMinutes: call.maxMinutes, at: new Date(this.now()).toISOString() });
      return { providerId, status: "queued" };
    },
  };

  /* ── the API ───────────────────────────────────────────────────────── */

  private answer(method: string, path: string, query: URLSearchParams, body: Row, headers: Record<string, string>, replayed: { value: boolean }): { status: number; body: unknown } {
    const at = new Date(this.now()).toISOString();
    const notFound = { status: 404, body: { errors: [{ code: "10005", title: "Resource not found", detail: `${method} ${path}` }] } };
    const invalid = (detail: string) => ({ status: 422, body: { errors: [{ code: "10002", title: "Invalid parameter", detail }] } });
    const route = `${method} ${path
      .split("/")
      .map((part) => (part === "" || WORDS.has(part) ? part : ":id"))
      .join("/")}`;
    const idIn = (index: number) => decodeURIComponent(path.split("/")[index] ?? "");

    switch (route) {
      case "GET /balance":
        return { status: 200, body: { data: { record_type: "balance", balance: "25.00", credit_limit: "0.00", available_credit: "25.00", pending: "0.00", currency: "USD" } } };
      case "GET /user_profile":
        return { status: 200, body: { data: { id: 1, business_name: this.businessName, country: "US" } } };
      case "GET /available_phone_numbers": {
        const area = query.get("filter[national_destination_code]") ?? "555";
        return {
          status: 200,
          body: {
            data: [0, 1, 2].map((i) => ({
              record_type: "available_phone_number",
              phone_number: `+1${area}55501${String(i).padStart(2, "0")}`,
              region_information: [
                { region_type: "rate_center", region_name: "SIMVILLE" },
                { region_type: "state", region_name: "CA" },
              ],
              cost_information: { upfront_cost: "1.00", monthly_cost: "1.00", currency: "USD" },
              features: [{ name: "sms" }, { name: "mms" }, { name: "voice" }],
            })),
            meta: { total_results: 3 },
          },
        };
      }
      case "POST /number_orders": {
        const wanted = Array.isArray(body["phone_numbers"]) ? (body["phone_numbers"] as Row[]) : [];
        const rows = wanted.map((one) => [...this.numbers.values()].find((row) => row["phone_number"] === one["phone_number"]) ?? this.addNumber(String(one["phone_number"])));
        return { status: 200, body: { data: { id: `order-${hash(JSON.stringify(wanted))}`, record_type: "number_order", status: "success", phone_numbers: rows.map((row) => ({ id: row["id"], phone_number: row["phone_number"], status: "success" })) } } };
      }
      case "GET /phone_numbers": {
        const filter = query.get("filter[phone_number]");
        const rows = [...this.numbers.values()].filter((row) => !filter || String(row["phone_number"]).includes(filter));
        return { status: 200, body: { data: rows, meta: { total_pages: 1, total_results: rows.length, page_number: 1, page_size: 250 } } };
      }
      case "PATCH /phone_numbers/:id": {
        const row = this.numbers.get(idIn(2));
        if (!row) return notFound;
        if (body["connection_id"] !== undefined) row["connection_id"] = body["connection_id"];
        return { status: 200, body: { data: row } };
      }
      case "PATCH /phone_numbers/:id/messaging": {
        const row = this.numbers.get(idIn(2));
        if (!row) return notFound;
        if (body["messaging_profile_id"] !== undefined) row["messaging_profile_id"] = body["messaging_profile_id"];
        return { status: 200, body: { data: row } };
      }
      case "DELETE /phone_numbers/:id": {
        const row = this.numbers.get(idIn(2));
        if (!row) return notFound;
        this.numbers.delete(idIn(2));
        return { status: 200, body: { data: { ...row, status: "deleted" } } };
      }
      case "GET /messaging_profiles": {
        const name = query.get("filter[name]");
        return { status: 200, body: { data: [...this.profiles.values()].filter((one) => !name || one["name"] === name) } };
      }
      case "POST /messaging_profiles": {
        if (!body["name"] || !Array.isArray(body["whitelisted_destinations"])) return invalid("name and whitelisted_destinations are required.");
        const row = { ...body, id: `4001${String(this.profiles.size).padStart(4, "0")}`, record_type: "messaging_profile" };
        this.profiles.set(String(row.id), row);
        return { status: 200, body: { data: row } };
      }
      case "PATCH /messaging_profiles/:id": {
        const row = this.profiles.get(idIn(2));
        if (!row) return notFound;
        Object.assign(row, body);
        return { status: 200, body: { data: row } };
      }
      case "POST /messages": {
        const key = headers["idempotency-key"];
        if (key !== undefined && !/^[A-Za-z0-9_-]{1,255}$/.test(key)) return { status: 400, body: { errors: [{ code: "10015", title: "Invalid Idempotency-Key" }] } };
        const earlier = key ? this.idempotency.get(key) : undefined;
        if (earlier) {
          replayed.value = true;
          return { status: 200, body: earlier };
        }
        const from = String(body["from"] ?? "");
        const to = String(body["to"] ?? "");
        const owned = [...this.numbers.values()].find((row) => row["phone_number"] === from);
        if (!owned) return { status: 403, body: { errors: [{ code: "40305", title: "Invalid 'from' address", detail: `${from} is not a number on this account.` }] } };
        const id = `msg-${hash(`${key ?? ""}:${this.sent.length}:${to}`)}`;
        this.sent.push({ providerId: id, from, to, body: String(body["text"] ?? ""), key: key ?? "", at });
        const failure = this.failures.get(to);
        this.pending.push(failure ? { providerId: id, status: "failed", errorCode: failure } : { providerId: id, status: "delivered" });
        const answer = { data: { id, record_type: "message", direction: "outbound", type: "SMS", from: { phone_number: from }, to: [{ phone_number: to, status: "queued" }], text: body["text"], parts: 1, errors: [] } };
        if (key) this.idempotency.set(key, answer);
        return { status: 200, body: answer };
      }
      case "POST /10dlc/brand": {
        for (const field of ["entityType", "displayName", "country", "email", "vertical"]) if (!body[field]) return invalid(`${field} is required.`);
        const brandId = `B${hash(JSON.stringify(body)).toUpperCase().slice(0, 6)}`;
        const reason = this.rejections.shift();
        const row = { ...body, brandId, status: reason ? "REGISTRATION_FAILED" : "REGISTRATION_PENDING", ...(reason ? { identityStatus: "UNVERIFIED", failureReasons: reason } : {}), createdAt: at };
        this.brands.set(brandId, row);
        return { status: 200, body: row };
      }
      case "GET /10dlc/brand/:id": {
        const row = this.brands.get(idIn(3));
        return row ? { status: 200, body: { ...row, assignedCampaignsCount: 0 } } : notFound;
      }
      case "GET /10dlc/enum/usecase":
        return { status: 200, body: USE_CASES };
      case "GET /10dlc/campaignBuilder/brand/:id/usecase/:id": {
        const brand = this.brands.get(idIn(4));
        const usecase = idIn(6);
        if (!brand) return notFound;
        if (usecase === "POLITICAL" && brand["entityType"] !== "NON_PROFIT") return { status: 400, body: { errors: [{ code: "10002", title: "Brand does not qualify for this use case" }] } };
        return { status: 200, body: { usecase, monthlyFee: 10, annualFee: 120, quarterlyFee: 30, minSubUsecases: 0, maxSubUsecases: 0, mnoMetadata: {} } };
      }
      case "POST /10dlc/campaignBuilder": {
        for (const field of ["brandId", "usecase", "description"]) if (!body[field]) return invalid(`${field} is required.`);
        const brand = this.brands.get(String(body["brandId"]));
        if (!brand) return notFound;
        if (brand["identityStatus"] !== "VERIFIED" && brand["identityStatus"] !== "VETTED_VERIFIED") return invalid("The brand is not verified yet.");
        const campaignId = `C${hash(JSON.stringify(body)).toUpperCase().slice(0, 6)}`;
        const reason = this.rejections.shift();
        const row = { ...body, campaignId, campaignStatus: reason ? "TELNYX_FAILED" : "TCR_PENDING", submissionStatus: reason ? "FAILED" : "CREATED", status: "ACTIVE", ...(reason ? { failureReasons: reason } : {}), createDate: at };
        this.campaigns.set(campaignId, row);
        return { status: 200, body: row };
      }
      case "GET /10dlc/campaign/:id": {
        const row = this.campaigns.get(idIn(3));
        return row ? { status: 200, body: row } : notFound;
      }
      case "POST /10dlc/phone_number_campaigns": {
        const campaign = this.campaigns.get(String(body["campaignId"]));
        if (!campaign) return notFound;
        if (campaign["campaignStatus"] !== "MNO_PROVISIONED" && campaign["campaignStatus"] !== "MNO_ACCEPTED") return invalid("The campaign is not active yet.");
        const number = [...this.numbers.values()].find((row) => row["phone_number"] === body["phoneNumber"]);
        if (!number?.["messaging_profile_id"]) return invalid("The number must be on a messaging profile first.");
        const row = { phoneNumber: body["phoneNumber"], campaignId: body["campaignId"], assignmentStatus: "ASSIGNED", createdAt: at, updatedAt: at };
        this.assignments.set(String(body["phoneNumber"]), row);
        return { status: 200, body: row };
      }
      case "POST /outbound_voice_profiles": {
        if (String(body["name"] ?? "").length < 3) return invalid("name is required.");
        const row = { ...body, id: `17${String(this.voiceProfiles.size).padStart(6, "0")}`, record_type: "outbound_voice_profile" };
        this.voiceProfiles.set(String(row.id), row);
        return { status: 201, body: { data: row } };
      }
      case "DELETE /outbound_voice_profiles/:id": {
        const row = this.voiceProfiles.get(idIn(2));
        if (!row) return notFound;
        this.voiceProfiles.delete(idIn(2));
        return { status: 200, body: { data: row } };
      }
      case "POST /fqdn_connections": {
        if (!body["connection_name"]) return invalid("connection_name is required.");
        const row = { ...body, id: `18${String(this.connections.size).padStart(6, "0")}`, record_type: "fqdn_connection", password: body["password"] };
        this.connections.set(String(row.id), row);
        return { status: 201, body: { data: row } };
      }
      case "DELETE /fqdn_connections/:id": {
        const row = this.connections.get(idIn(2));
        if (!row) return notFound;
        this.connections.delete(idIn(2));
        for (const number of this.numbers.values()) if (number["connection_id"] === idIn(2)) number["connection_id"] = null;
        return { status: 200, body: { data: row } };
      }
      case "POST /fqdns": {
        if (!this.connections.has(String(body["connection_id"]))) return notFound;
        if (!body["fqdn"] || !body["dns_record_type"]) return invalid("fqdn and dns_record_type are required.");
        const row = { ...body, id: `19${String(this.fqdns.size).padStart(6, "0")}`, record_type: "fqdn" };
        this.fqdns.set(String(row.id), row);
        return { status: 201, body: { data: row } };
      }
      default:
        return notFound;
    }
  }
}
