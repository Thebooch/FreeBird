import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  deliveryUpdateSchema,
  e164Schema,
  inboundTextSchema,
  type AccountInfo,
  type BrandProfile,
  type CampaignDraft,
  type CampaignUse,
  type DeliveryUpdate,
  type OwnedNumber,
  type RegistrationStatus,
  type RejectionHelp,
  type SipTarget,
  type SubmissionRef,
  type TrunkInfo,
} from "@freebirdai/dash-spec";
import { PhoneKeysError, PhoneParseError, RepeatSendError, type CallPlacer, type OpenPhoneProvider, type PhoneKeys, type PhoneProvider, type RawRequest } from "./contract.js";

/**
 * The fake carrier: one pretend provider account that implements every
 * interface of the contract, for sandboxes and tests. Nothing leaves the
 * process.
 *
 * It records every send and call, turns what a scenario says into signed
 * webhooks (inbound texts, STOP replies, delivery updates), fails delivery to
 * the numbers it is told to, and rejects registrations on demand. Its
 * webhooks are signed like a real provider's (HMAC-SHA256 over the address
 * and the raw body, in `x-fake-signature`), so the route's
 * verify-before-parse rule is exercised for real.
 *
 * Everything it keeps is in maps and arrays it owns, so a sandbox snapshot
 * of it restores it.
 */

export const FAKE_PROVIDER_ID = "fake";
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";
/** The keys a fake account takes, unless it is given others. */
export const FAKE_SECRET = "fake-carrier-secret";

export interface FakeText {
  readonly providerId: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly key: string;
  readonly at: string;
}

export interface FakeCall {
  readonly providerId: string;
  readonly from: string;
  readonly to: string;
  readonly purpose: string;
  readonly key: string;
  readonly maxMinutes: number;
  readonly at: string;
}

export interface FakeCarrierOptions {
  /** The account's webhook signing secret and API key. Default `FAKE_SECRET`. */
  readonly secret?: string;
  readonly accountName?: string;
  readonly trial?: boolean;
  readonly now?: () => number;
}

const USE_CASES: readonly CampaignUse[] = [
  { id: "ACCOUNT_NOTIFICATION", title: "Account notifications", description: "Reminders, confirmations and status updates about someone's account or appointment.", extraVetting: false },
  { id: "CUSTOMER_CARE", title: "Customer care", description: "Answering and following up on customers' questions.", extraVetting: false },
  { id: "MARKETING", title: "Marketing", description: "Offers, promotions and win-back messages.", extraVetting: false },
  { id: "MIXED", title: "Mixed", description: "Several of the above from one campaign.", extraVetting: false },
  { id: "LOW_VOLUME", title: "Low volume mixed", description: "Several uses at a small volume.", extraVetting: false },
  { id: "POLITICAL", title: "Political", description: "Political campaigns and causes.", extraVetting: true },
];

/** The fake's rejection codes, in the shape `explain` gives. */
export const FAKE_REJECTIONS: Readonly<Record<string, Omit<RejectionHelp, "code">>> = {
  "30794": { sentence: "The legal name does not match the one registered with this EIN. Enter it exactly as on the IRS letter.", field: "legalName" },
  "30795": { sentence: "The sample messages do not say who is texting. Put the business name in at least one sample.", field: "samples" },
  "30796": { sentence: "No sample says how to stop messages. End one with opt-out wording such as \"Reply STOP to opt out\".", field: "samples" },
  "30797": { sentence: "The opt-in description does not say how people agree to texts.", field: "optIn" },
};

const hash = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16);

const signatureOf = (secret: string, url: string, body: string): string => createHmac("sha256", secret).update(`${url}\n${body}`).digest("hex");

const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const jsonOf = (req: RawRequest): unknown => {
  try {
    return JSON.parse(req.body) as unknown;
  } catch {
    throw new PhoneParseError("The webhook body is not JSON.");
  }
};

export class FakeCarrier {
  readonly secret: string;
  /** Every text handed to it, in order. */
  readonly sent: FakeText[] = [];
  /** Every call placed through it. */
  readonly calls: FakeCall[] = [];
  readonly owned: OwnedNumber[] = [];
  readonly routes = new Map<string, { textWebhook?: string; voiceSip?: SipTarget }>();
  readonly trunks = new Map<string, TrunkInfo>();
  /** Numbers whose texts it fails to deliver, with the error code it reports. */
  readonly failures = new Map<string, string>();
  /** Status webhooks it owes, oldest first; `takeUpdates` hands them over. */
  readonly pending: DeliveryUpdate[] = [];
  readonly submissions = new Map<string, { ref: SubmissionRef; status: RegistrationStatus; brand?: BrandProfile; campaign?: CampaignDraft }>();
  readonly attached = new Map<string, string[]>();
  /** Codes the next submissions are rejected with, one each. */
  readonly rejections: string[] = [];

  private readonly accountName: string;
  private readonly trial: boolean;
  private readonly now: () => number;

  constructor(options: FakeCarrierOptions = {}) {
    this.secret = options.secret ?? FAKE_SECRET;
    this.accountName = options.accountName ?? "Fake carrier account";
    this.trial = options.trial ?? false;
    this.now = options.now ?? (() => Date.now());
  }

  /** The provider, opened with a line's keys, as a server registers it. */
  readonly open: OpenPhoneProvider = (keys) => this.provider(keys);

  /* ── what a scenario makes happen ──────────────────────────────────── */

  /** A webhook as the carrier would send it: a signed JSON POST to `url`. */
  request(url: string, payload: unknown): RawRequest {
    const body = JSON.stringify(payload);
    return { method: "POST", url, headers: { "content-type": "application/json", [FAKE_SIGNATURE_HEADER]: signatureOf(this.secret, url, body) }, body };
  }

  /** Someone texts a number on this account. */
  inboundText(text: { readonly from: string; readonly to: string; readonly body: string; readonly media?: readonly string[] }, url: string): RawRequest {
    const at = new Date(this.now()).toISOString();
    return this.request(url, { event: "text", from: text.from, to: text.to, body: text.body, media: text.media ?? [], at, providerId: `IMfake${hash(`${text.from}:${text.to}:${at}:${text.body}`)}` });
  }

  /** Someone replies STOP. Dash, not the carrier, decides what that means. */
  stopReply(from: string, to: string, url: string): RawRequest {
    return this.inboundText({ from, to, body: "STOP" }, url);
  }

  /** Texts to this number fail, with the carrier's error code. */
  failDelivery(to: string, errorCode = "30003"): void {
    this.failures.set(to, errorCode);
  }

  /** The next registration submission is rejected with this code. */
  rejectNextRegistration(code: string): void {
    this.rejections.push(code);
  }

  /** Decides a pending submission, as the registry would. */
  settleRegistration(id: string, state: "approved" | "rejected", code?: string): RegistrationStatus {
    const held = this.submissions.get(id);
    if (!held) throw new Error(`The fake carrier has no submission "${id}".`);
    held.status = { ref: held.ref, state, codes: code ? [{ code }] : [], at: new Date(this.now()).toISOString() };
    return held.status;
  }

  /** A call ends after so many minutes: its status update. */
  endCall(providerId: string, minutes: number): DeliveryUpdate {
    const update = deliveryUpdateSchema.parse({ providerId, status: "delivered", minutes });
    this.pending.push(update);
    return update;
  }

  /** The status webhooks it owes, handed over once. */
  takeUpdates(): DeliveryUpdate[] {
    return this.pending.splice(0, this.pending.length);
  }

  /** A status update as a signed webhook. */
  statusRequest(update: DeliveryUpdate, url: string): RawRequest {
    return this.request(url, { event: "status", ...update });
  }

  /** Places calls: the fake media layer, which records each one. */
  readonly placer: CallPlacer = {
    place: async (call) => {
      const earlier = this.calls.find((one) => one.key === call.key);
      if (earlier) throw new RepeatSendError(call.key, earlier.providerId);
      const providerId = `CAfake${hash(call.key)}`;
      this.calls.push({ providerId, from: call.from, to: call.to, purpose: call.purpose, key: call.key, maxMinutes: call.maxMinutes, at: new Date(this.now()).toISOString() });
      return { providerId, status: "queued" };
    },
  };

  /* ── the provider ──────────────────────────────────────────────────── */

  private provider(keys: PhoneKeys): PhoneProvider {
    const needKeys = () => {
      if (keys["secret"] !== this.secret) throw new PhoneKeysError("The fake carrier refused these keys.");
    };
    const at = () => new Date(this.now()).toISOString();
    const submit = (kind: SubmissionRef["kind"], extra: { brand?: BrandProfile; campaign?: CampaignDraft }): SubmissionRef => {
      const ref: SubmissionRef = { kind, id: `${kind === "brand" ? "BN" : "CM"}fake${this.submissions.size + 1}`, provider: FAKE_PROVIDER_ID };
      const code = this.rejections.shift();
      const status: RegistrationStatus = { ref, state: code ? "rejected" : "pending", codes: code ? [{ code }] : [], at: at() };
      this.submissions.set(ref.id, { ref, status, ...extra });
      return ref;
    };
    const held = (ref: SubmissionRef) => {
      const one = this.submissions.get(ref.id);
      if (!one) throw new Error(`The fake carrier has no submission "${ref.id}".`);
      return one;
    };
    return {
      id: FAKE_PROVIDER_ID,
      title: "Fake carrier",
      credentials: [{ key: "secret", label: "Secret", secret: true, help: "Any sandbox uses the fake carrier's own secret." }],
      capabilities: { text: true, voice: "sip", registration: "10dlc" },
      verify: async (given): Promise<AccountInfo> => {
        if (given["secret"] !== this.secret) throw new PhoneKeysError("The fake carrier refused these keys.");
        return { name: this.accountName, country: "US", trial: this.trial };
      },
      numbers: {
        search: async (q) => {
          needKeys();
          const area = /^\d{3}$/.test(q.areaCode ?? "") ? q.areaCode! : "555";
          return [0, 1, 2].map((i) => ({ number: `+1${area}55501${String(i).padStart(2, "0")}`, locality: "Fakeville", region: "CA", monthlyPrice: { amount: "1.15", currency: "USD" }, capabilities: { text: true, voice: true } }));
        },
        buy: async (number) => {
          needKeys();
          const parsed = e164Schema.parse(number);
          const owned: OwnedNumber = { number: parsed, providerId: `PNfake${hash(parsed)}`, capabilities: { text: true, voice: true } };
          if (!this.owned.some((one) => one.number === parsed)) this.owned.push(owned);
          return owned;
        },
        list: async () => {
          needKeys();
          return [...this.owned];
        },
        route: async (number, to) => {
          needKeys();
          this.routes.set(number, { ...(to.textWebhook ? { textWebhook: to.textWebhook.toString() } : {}), ...(to.voiceSip ? { voiceSip: to.voiceSip } : {}) });
        },
        release: async (number) => {
          needKeys();
          const index = this.owned.findIndex((one) => one.number === number);
          if (index >= 0) this.owned.splice(index, 1);
          this.routes.delete(number);
        },
      },
      text: {
        send: async (m) => {
          needKeys();
          const earlier = this.sent.find((one) => one.key === m.key);
          if (earlier) throw new RepeatSendError(m.key, earlier.providerId);
          const providerId = `SMfake${hash(m.key)}`;
          this.sent.push({ providerId, from: m.from, to: m.to, body: m.body, key: m.key, at: at() });
          const failure = this.failures.get(m.to);
          this.pending.push(failure ? { providerId, status: "failed", errorCode: failure } : { providerId, status: "delivered" });
          return { providerId, status: "queued" };
        },
        verify: (req, given) => {
          const secret = given["secret"];
          const signature = req.headers[FAKE_SIGNATURE_HEADER];
          if (!secret || !signature) return false;
          return sameText(signature, signatureOf(secret, req.url, req.body));
        },
        parseInbound: (req) => {
          const body = jsonOf(req) as Record<string, unknown> | null;
          if (!body || body["event"] !== "text") throw new PhoneParseError("This webhook is not an inbound text.");
          const parsed = inboundTextSchema.safeParse(body);
          if (!parsed.success) throw new PhoneParseError(`The inbound text is malformed: ${parsed.error.issues[0]?.message ?? "unknown"}.`);
          return parsed.data;
        },
        parseStatus: (req) => {
          const body = jsonOf(req) as Record<string, unknown> | null;
          if (!body || body["event"] !== "status") throw new PhoneParseError("This webhook is not a status update.");
          const { event: _event, ...rest } = body;
          const parsed = deliveryUpdateSchema.safeParse(rest);
          if (!parsed.success) throw new PhoneParseError(`The status update is malformed: ${parsed.error.issues[0]?.message ?? "unknown"}.`);
          return parsed.data;
        },
      },
      voice: {
        connectTrunk: async (t) => {
          needKeys();
          const trunk: TrunkInfo = { id: `TKfake${this.trunks.size + 1}`, sipUri: t.sipUri, numbers: [...t.numbers] };
          this.trunks.set(trunk.id, trunk);
          return trunk;
        },
        disconnectTrunk: async (id) => {
          needKeys();
          this.trunks.delete(id);
        },
      },
      registration: {
        submitBrand: async (p) => {
          needKeys();
          return submit("brand", { brand: p });
        },
        useCases: async (brand) => {
          needKeys();
          held(brand);
          return [...USE_CASES];
        },
        submitCampaign: async (brand, c) => {
          needKeys();
          if (held(brand).status.state !== "approved") throw new Error("The brand is not approved yet, so a campaign cannot be submitted.");
          return submit("campaign", { campaign: c });
        },
        attachNumbers: async (campaign, numbers) => {
          needKeys();
          if (held(campaign).status.state !== "approved") throw new Error("The campaign is not approved yet, so numbers cannot be attached.");
          this.attached.set(campaign.id, [...numbers]);
        },
        status: async (ref) => {
          needKeys();
          return held(ref).status;
        },
        explain: (code) => ({ code, ...(FAKE_REJECTIONS[code] ?? { sentence: `The registry rejected this with code ${code}. Check every field against the business's records and submit again.` }) }),
      },
    };
  }
}
