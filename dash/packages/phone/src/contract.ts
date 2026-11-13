import type {
  AccountInfo,
  AvailableNumber,
  BrandProfile,
  CampaignDraft,
  CampaignUse,
  CredentialField,
  DeliveryUpdate,
  InboundText,
  OwnedNumber,
  PhoneDeliveryStatus,
  RegistrationStatus,
  RejectionHelp,
  SipTarget,
  SubmissionRef,
  TrunkInfo,
} from "@freebirdai/dash-spec";

/**
 * The phone provider contract. One interface per capability, so a provider
 * can offer some and not others (a SIP-only carrier has voice but no text
 * API). Adapters are hand-written: no model runs inside them.
 *
 * Two rules every adapter keeps:
 *
 * - **At most once.** `send` takes the same `key` `OutreachSender` uses; an
 *   adapter passes it to the provider's idempotency mechanism where one
 *   exists and refuses a repeat (`RepeatSendError`) where none does.
 * - **Spend is capped outside the adapter.** Each line's daily ceilings are
 *   counted by Dash before `send` or a dial, never here.
 *
 * And for webhooks: **`verify` runs on the raw request before a byte of it is
 * parsed.** `parseInbound` and `parseStatus` are only ever handed a request
 * `verify` accepted.
 */

/** The keys a person pasted, by `CredentialField.key`. Read from the vault for each call; never kept by an adapter. */
export type PhoneKeys = Readonly<Record<string, string>>;

/** A webhook exactly as it arrived: nothing parsed, so its signature can be checked over the bytes the provider signed. */
export interface RawRequest {
  readonly method: string;
  /** The full public address the provider called, query included: providers sign it. */
  readonly url: string;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The body as received, undecoded. */
  readonly body: string;
}

export interface PhoneProvider {
  /** "twilio", "telnyx", "fake". */
  readonly id: string;
  readonly title: string;
  /** What a person pastes, with where-to-find-it help. */
  readonly credentials: readonly CredentialField[];
  /** Name, country, trial or not. Stores nothing. Throws `PhoneKeysError` for keys the provider refuses. */
  verify(keys: PhoneKeys): Promise<AccountInfo>;
  readonly capabilities: { readonly text: boolean; readonly voice: "sip" | "none"; readonly registration: "10dlc" | "none" };
  readonly numbers: NumberAdapter;
  readonly text?: TextAdapter;
  readonly voice?: VoiceAdapter;
  readonly registration?: RegistrationAdapter;
}

/**
 * How a server knows a provider: opened with one line's keys, read from the
 * vault for each use, so an adapter never holds keys beyond the call.
 * Opened with `{}` it still answers `id`, `title`, `credentials`,
 * `capabilities`, `verify` and `text.verify`, which take their keys as
 * arguments; nothing else may be called on it.
 */
export type OpenPhoneProvider = (keys: PhoneKeys) => PhoneProvider;

export interface NumberAdapter {
  search(q: { readonly areaCode?: string }): Promise<AvailableNumber[]>;
  buy(number: string): Promise<OwnedNumber>;
  /** Numbers already in the account. */
  list(): Promise<OwnedNumber[]>;
  route(number: string, to: { readonly textWebhook?: URL; readonly voiceSip?: SipTarget }): Promise<void>;
  release(number: string): Promise<void>;
}

export interface TextAdapter {
  send(m: { readonly from: string; readonly to: string; readonly body: string; readonly key: string }): Promise<{ readonly providerId: string; readonly status: PhoneDeliveryStatus }>;
  /** The signature, over the raw request, before anything is parsed. */
  verify(req: RawRequest, keys: PhoneKeys): boolean;
  parseInbound(req: RawRequest): InboundText;
  parseStatus(req: RawRequest): DeliveryUpdate;
}

export interface VoiceAdapter {
  /** Points the carrier at the media layer. */
  connectTrunk(t: { readonly sipUri: string; readonly numbers: readonly string[] }): Promise<TrunkInfo>;
  disconnectTrunk(id: string): Promise<void>;
}

export interface RegistrationAdapter {
  submitBrand(p: BrandProfile): Promise<SubmissionRef>;
  /** What the registry accepts for this brand. */
  useCases(brand: SubmissionRef): Promise<CampaignUse[]>;
  submitCampaign(brand: SubmissionRef, c: CampaignDraft): Promise<SubmissionRef>;
  attachNumbers(campaign: SubmissionRef, numbers: readonly string[]): Promise<void>;
  /** pending | approved | rejected, with the provider's codes. */
  status(ref: SubmissionRef): Promise<RegistrationStatus>;
  /** A plain sentence, and the wizard field to fix. */
  explain(code: string): RejectionHelp;
}

/**
 * Places an outbound call. Not part of a carrier's adapter: calls ride the
 * SIP media layer and the voice worker (Phase 3), so this is Dash's own
 * seam. `maxMinutes` is what the line's daily ceiling still allows; the call
 * is ended there.
 */
export interface CallPlacer {
  place(c: { readonly from: string; readonly to: string; readonly purpose: string; readonly key: string; readonly maxMinutes: number }): Promise<{ readonly providerId: string; readonly status: PhoneDeliveryStatus }>;
}

/** The keys were refused, or are missing a field. */
export class PhoneKeysError extends Error {
  override readonly name = "PhoneKeysError";
}

/** A send with a key already sent. Carries the first send's id. */
export class RepeatSendError extends Error {
  override readonly name = "RepeatSendError";
  constructor(
    readonly key: string,
    readonly providerId: string,
  ) {
    super(`A message with key "${key}" was already sent (${providerId}); it is not sent twice.`);
  }
}

/**
 * A provider's own refusal, in its words: the provider's name, the HTTP
 * status it answered and its error code. Every adapter's error extends it,
 * so Dash says "<provider> said: …" without knowing any one provider.
 */
export class PhoneProviderError extends Error {
  override readonly name: string = "PhoneProviderError";
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
    readonly code?: string | number,
  ) {
    super(message);
  }
}

/** A webhook body that does not hold what its event says. Thrown only after `verify` accepted it. */
export class PhoneParseError extends Error {
  override readonly name = "PhoneParseError";
}

/** The providers a server knows, by id. */
export type PhoneProviders = Readonly<Record<string, OpenPhoneProvider>>;
