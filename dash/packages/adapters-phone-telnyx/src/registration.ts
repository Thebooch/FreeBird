import type { BrandProfile, CampaignDraft, CampaignUse, RegistrationStatus, RejectionHelp, SubmissionRef } from "@freebirdai/dash-spec";
import type { RegistrationAdapter } from "@freebirdai/phone";

/**
 * Telnyx's 10DLC registration, as Dash Phone's `RegistrationAdapter`. Checked
 * against Telnyx's API reference on 2026-11-13:
 *
 * - **Brand:** `POST /10dlc/brand` (https://developers.telnyx.com/api-reference/brands/create-brand.md:
 *   `entityType`, `displayName`, `country`, `email`, `vertical` required;
 *   `companyName` for a business, `ein`; the answer's `brandId`).
 *   `GET /10dlc/brand/{brandId}` (https://developers.telnyx.com/api-reference/brands/get-brand.md):
 *   `identityStatus` VERIFIED | UNVERIFIED | SELF_DECLARED | VETTED_VERIFIED,
 *   `status` OK | REGISTRATION_PENDING | REGISTRATION_FAILED, `failureReasons`.
 * - **Use cases:** `GET /10dlc/enum/usecase` for the list (the campaign
 *   schema names it; its answer's shape is not shown, so a list or a map is
 *   taken), each checked for the brand with
 *   `GET /10dlc/campaignBuilder/brand/{brandId}/usecase/{usecase}`
 *   (https://developers.telnyx.com/api-reference/campaign/qualify-by-usecase.md).
 * - **Campaign:** `POST /10dlc/campaignBuilder` (https://developers.telnyx.com/api-reference/campaign/submit-campaign.md:
 *   `brandId`, `usecase`, `description` required; `sample1`…`sample5`,
 *   `messageFlow`, `embeddedLink`, `embeddedPhone`, `privacyPolicyLink`,
 *   `termsAndConditionsLink`, the opt-in, opt-out and help keywords and
 *   messages). `GET /10dlc/campaign/{campaignId}` (get-campaign.md):
 *   `campaignStatus` TCR_* | TELNYX_* | MNO_*, `failureReasons`.
 * - **Numbers:** `POST /10dlc/phone_number_campaigns` with `phoneNumber` and
 *   `campaignId` (https://developers.telnyx.com/api-reference/phone-number-campaigns/create-new-phone-number-campaign.md;
 *   the 10DLC guide's `/10dlc/phoneNumberCampaign` is not in the API
 *   reference). The number must be on a messaging profile first: `route()`.
 *
 * Not here: a sole proprietor. Telnyx's sole-proprietor brand is verified by
 * a one-time PIN texted to the owner's mobile and sent back through the API
 * (https://developers.telnyx.com/docs/messaging/10dlc/sole-proprietor), a step
 * the wizard does not have, so it is refused in plain words.
 */

type Call = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;

export interface TelnyxRegistrationDeps {
  readonly call: Call;
  /** Telnyx's words for each code seen, kept across opens of the provider. */
  readonly descriptions?: Map<string, string>;
}

const ENTITY_TYPES: Readonly<Record<BrandProfile["businessType"], string>> = {
  llc: "PRIVATE_PROFIT",
  corporation: "PRIVATE_PROFIT",
  partnership: "PRIVATE_PROFIT",
  nonprofit: "NON_PROFIT",
  sole_proprietor: "SOLE_PROPRIETOR",
};

/**
 * The registry's verticals, from the wizard's industry. Telnyx's pages name
 * these among others (the full enum is The Campaign Registry's); anything
 * else is sent upper-cased, and a refusal comes back in Telnyx's words.
 */
const VERTICALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/health|medical|dental|clinic|therapy/i, "HEALTHCARE"],
  [/real ?estate|property|landlord|rental/i, "REAL_ESTATE"],
  [/retail|shop|store|ecommerce/i, "RETAIL"],
  [/tech|software|saas|it /i, "TECHNOLOGY"],
  [/school|education|tutor|training/i, "EDUCATION"],
  [/entertain|event|music|media/i, "ENTERTAINMENT"],
  [/non.?profit|charity/i, "NONPROFIT"],
  [/government|municipal|public sector/i, "GOVERNMENT"],
  [/plumb|hvac|clean|repair|maintenance|contractor|landscap|consult|legal|account|salon|professional/i, "PROFESSIONAL"],
];

export const telnyxVertical = (industry: string): string => VERTICALS.find(([pattern]) => pattern.test(industry))?.[1] ?? industry.toUpperCase().replace(/[^A-Z]+/g, "_").replace(/^_|_$/g, "");

/** Uses The Campaign Registry vets further. */
const EXTRA_VETTING = new Set(["POLITICAL", "CHARITY", "SWEEPSTAKE", "AGENTS_FRANCHISES", "PROXY", "EMERGENCY", "SOCIAL", "CARRIER_EXEMPT", "K12_EDUCATION", "PLATFORM_FREE_TRIAL", "UCAAS_HIGH", "UCAAS_LOW", "DIRECT_LENDING"]);

const titleOf = (code: string): string =>
  code
    .toLowerCase()
    .split("_")
    .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ")
    .replace(/^2fa$/i, "Two-factor codes");

/** The wizard's field each kind of rejection is fixed in, found by what Telnyx's reason says. */
const FIX_BY_WORDS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\b(ein|tax id|tax_id)\b/i, "ein", "The EIN does not match the legal name the IRS has for it. Check both against the IRS letter."],
  [/\b(legal name|company ?name|business name)\b/i, "legalName", "The legal name does not match the registry's records. Enter it exactly as on the IRS letter."],
  [/\b(website|url|domain)\b/i, "website", "The website could not be checked, or does not show the same business. Make sure it loads over https and names the business."],
  [/\b(opt[- ]?in|consent|call to action|message ?flow)\b/i, "optIn", "The reviewer could not see how people agree to texts. Describe where they tick the box, and link the opt-in page."],
  [/\b(sample|message content)\b/i, "samples", "The sample messages were not accepted. Name the business in one, end one with opt-out wording, and keep them to what the campaign is for."],
  [/\b(opt[- ]?out|stop)\b/i, "samples", "Opt-out wording is missing. End a sample with \"Reply STOP to opt out\"."],
  [/\b(privacy|policy|terms)\b/i, "privacyUrl", "The privacy policy or terms were not acceptable. They must say mobile numbers are not shared or sold."],
  [/\b(use ?case|campaign type)\b/i, "use", "The campaign use does not fit the messages. Pick the use that matches what you will text."],
  [/\b(address|street|postal|zip)\b/i, "street", "The business address could not be verified. Use the address on the business's registration."],
  [/\b(vertical|industry)\b/i, "industry", "The industry was not one the registry accepts. Pick the closest one."],
];

const sentence = (text: string): string => (text.trim().endsWith(".") ? text.trim() : `${text.trim()}.`);

const dataOf = (parsed: Record<string, unknown>): Record<string, unknown> => {
  const data = parsed["data"];
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : parsed;
};

const reasonsOf = (raw: unknown): string[] => {
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (Array.isArray(raw)) return raw.map((one) => (typeof one === "string" ? one : JSON.stringify(one))).filter(Boolean);
  return [];
};

const brandState = (brand: Record<string, unknown>): RegistrationStatus["state"] => {
  const status = String(brand["status"] ?? "").toUpperCase();
  const identity = String(brand["identityStatus"] ?? "").toUpperCase();
  if (status === "REGISTRATION_FAILED" || identity === "UNVERIFIED") return "rejected";
  if (identity === "VERIFIED" || identity === "VETTED_VERIFIED" || identity === "SELF_DECLARED") return "approved";
  return "pending";
};

const campaignState = (campaign: Record<string, unknown>): RegistrationStatus["state"] => {
  const status = String(campaign["campaignStatus"] ?? "").toUpperCase();
  if (["TCR_FAILED", "TELNYX_FAILED", "MNO_REJECTED", "MNO_PROVISIONING_FAILED", "TCR_SUSPENDED", "TCR_EXPIRED"].includes(status)) return "rejected";
  if (String(campaign["submissionStatus"] ?? "").toUpperCase() === "FAILED") return "rejected";
  if (status === "MNO_ACCEPTED" || status === "MNO_PROVISIONED") return "approved";
  return "pending";
};

export const telnyxRegistration = (deps: TelnyxRegistrationDeps): RegistrationAdapter & { readonly descriptions: Map<string, string> } => {
  const { call } = deps;
  const descriptions = deps.descriptions ?? new Map<string, string>();
  const codesOf = (code: string, reasons: readonly string[]) => {
    const codes = reasons.map((message, i) => ({ code: reasons.length > 1 ? `${code}-${i + 1}` : code, message }));
    for (const one of codes) descriptions.set(one.code, one.message);
    return codes;
  };

  return {
    descriptions,
    submitBrand: async (p: BrandProfile): Promise<SubmissionRef> => {
      if (p.businessType === "sole_proprietor") throw new Error("Telnyx registers a sole proprietor with a one-time PIN texted to the owner's mobile, which Dash's wizard does not take yet. Register as a business with an EIN, or use Twilio for a sole proprietor.");
      const [first, ...rest] = p.contact.name.trim().split(/\s+/);
      const made = dataOf(
        await call("POST", "/10dlc/brand", {
          entityType: ENTITY_TYPES[p.businessType],
          displayName: p.legalName.slice(0, 100),
          companyName: p.legalName,
          ein: (p.ein ?? "").replace(/\D/g, ""),
          firstName: first ?? "",
          lastName: rest.join(" "),
          phone: p.contact.phone,
          email: p.contact.email,
          street: p.address.street,
          city: p.address.city,
          state: p.address.region,
          postalCode: p.address.postalCode,
          country: p.address.country,
          website: p.website,
          vertical: telnyxVertical(p.industry),
        }),
      );
      const id = made["brandId"];
      if (typeof id !== "string" || !id) throw new Error("Telnyx did not say which brand it made.");
      return { kind: "brand", id, provider: "telnyx" };
    },

    useCases: async (brand: SubmissionRef): Promise<CampaignUse[]> => {
      const listed = await call("GET", "/10dlc/enum/usecase");
      const raw = Array.isArray(listed) ? listed : Array.isArray(listed["data"]) ? listed["data"] : listed["data"] && typeof listed["data"] === "object" ? Object.keys(listed["data"] as object) : Object.keys(listed);
      const codes = (raw as unknown[]).map((one) => (typeof one === "string" ? one : String((one as Record<string, unknown>)?.["usecase"] ?? (one as Record<string, unknown>)?.["code"] ?? ""))).filter((one) => /^[A-Z0-9_]+$/.test(one));
      const out: CampaignUse[] = [];
      for (const code of codes) {
        try {
          const qualified = dataOf(await call("GET", `/10dlc/campaignBuilder/brand/${encodeURIComponent(brand.id)}/usecase/${encodeURIComponent(code)}`));
          const monthly = typeof qualified["monthlyFee"] === "number" ? ` Telnyx quotes $${qualified["monthlyFee"]} a month.` : "";
          out.push({ id: code, title: titleOf(code), description: monthly.trim(), extraVetting: EXTRA_VETTING.has(code) });
        } catch {
          /* Not one this brand qualifies for. */
        }
      }
      return out;
    },

    submitCampaign: async (brand: SubmissionRef, c: CampaignDraft): Promise<SubmissionRef> => {
      const flow = `${c.optIn.description}${c.optIn.pageUrl ? ` Opt-in page: ${c.optIn.pageUrl}.` : ""}`;
      const samples = Object.fromEntries(c.samples.slice(0, 5).map((one, i) => [`sample${i + 1}`, one]));
      const made = dataOf(
        await call("POST", "/10dlc/campaignBuilder", {
          brandId: brand.id,
          usecase: c.use,
          description: c.description,
          messageFlow: flow.slice(0, 2048),
          ...samples,
          embeddedLink: c.containsLinks,
          embeddedPhone: c.containsPhoneNumbers,
          subscriberOptin: true,
          subscriberOptout: true,
          subscriberHelp: true,
          optoutKeywords: "STOP,UNSUBSCRIBE,CANCEL,END,QUIT",
          helpKeywords: "HELP,INFO",
          optoutMessage: "You are unsubscribed and will get no more texts. Reply START to text again.",
          helpMessage: "Reply STOP to opt out. Msg & data rates may apply.",
          ...(c.optIn.methods.includes("keyword") ? { optinKeywords: "START" } : {}),
          ...(c.privacyUrl ? { privacyPolicyLink: c.privacyUrl } : {}),
          ...(c.termsUrl ? { termsAndConditionsLink: c.termsUrl } : {}),
          termsAndConditions: true,
          autoRenewal: true,
        }),
      );
      const id = made["campaignId"];
      if (typeof id !== "string" || !id) throw new Error("Telnyx did not say which campaign it made.");
      return { kind: "campaign", id, provider: "telnyx" };
    },

    attachNumbers: async (campaign: SubmissionRef, numbers: readonly string[]): Promise<void> => {
      for (const number of numbers) await call("POST", "/10dlc/phone_number_campaigns", { phoneNumber: number, campaignId: campaign.id });
    },

    status: async (ref: SubmissionRef): Promise<RegistrationStatus> => {
      const found = dataOf(await call("GET", ref.kind === "brand" ? `/10dlc/brand/${encodeURIComponent(ref.id)}` : `/10dlc/campaign/${encodeURIComponent(ref.id)}`));
      const state = ref.kind === "brand" ? brandState(found) : campaignState(found);
      const code = ref.kind === "brand" ? String(found["identityStatus"] ?? found["status"] ?? "brand") : String(found["campaignStatus"] ?? "campaign");
      const codes = state === "rejected" ? codesOf(code, reasonsOf(found["failureReasons"])) : [];
      if (state === "rejected" && codes.length === 0) codes.push({ code, message: "" });
      const at = found["updateDate"] ?? found["updatedAt"] ?? found["createDate"] ?? found["createdAt"];
      return { ref, state, codes, ...(typeof at === "string" && !Number.isNaN(Date.parse(at)) ? { at: new Date(at).toISOString() } : {}) };
    },

    explain: (code: string): RejectionHelp => {
      const words = descriptions.get(code) ?? "";
      const match = FIX_BY_WORDS.find(([pattern]) => pattern.test(words));
      if (match) return { code, sentence: `${match[2]}${words ? ` Telnyx said: ${sentence(words)}` : ""}`, field: match[1] };
      return { code, sentence: words ? `Telnyx said: ${sentence(words)} Check the fields it names and submit again.` : `The registry rejected this (${code}). Check every field against the business's records and submit again.` };
    },
  };
};
