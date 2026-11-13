import type { BrandProfile, CampaignDraft, CampaignUse, RegistrationStatus, RejectionHelp, SubmissionRef } from "@freebirdai/dash-spec";
import type { RegistrationAdapter } from "@freebirdai/phone";

/**
 * Twilio's A2P 10DLC registration, as Dash Phone's `RegistrationAdapter`:
 *
 * - **Brand:** a Trust Hub customer profile (the business, its authorized
 *   contact and address), an A2P trust product, then a brand registration
 *   that joins the two. A sole proprietor goes through Twilio's Sole
 *   Proprietor brand: the starter profile and trust product, no EIN.
 * - **Use cases:** the uses the registry accepts for this brand, read from a
 *   messaging service made for it (Twilio asks for one in the address).
 * - **Campaign:** submitted under that messaging service.
 * - **Numbers:** added to the messaging service, which attaches them to the
 *   campaign.
 * - **Status:** the brand's and the campaign's, with Twilio's error codes and
 *   descriptions; `explain` turns a code into a sentence and the wizard field
 *   to fix, from Twilio's description when the code itself is not known.
 *
 * Every request is a submission to the registry; none is retried. Policy
 * sids are Twilio's published Trust Hub policies; check them against
 * Twilio's current documentation before the first real submission (Gate C).
 */

export const TRUST_HUB = "https://trusthub.twilio.com/v1";
export const MESSAGING = "https://messaging.twilio.com/v1";

/**
 * Twilio's Trust Hub policies, as its A2P 10DLC API onboarding pages give
 * them (both dated 2026-10-30, checked 2026-11-13):
 *
 * - Standard brand, https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api:
 *   the Secondary Customer Profile (step 1.1) and the A2P TrustProduct
 *   ("The `policy_sid` must be `RNb0d4771c2c98518d916a3d4cd70a8f8b`", step 2.1).
 * - Sole proprietor, https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api-sole-prop-new:
 *   the Starter Customer Profile Policy (step 1.1) and the Sole Proprietor
 *   A2P Trust Policy (step 2.1).
 */
export const POLICIES = {
  customerProfile: "RNdfbf3fae0e1107f8aded0e7cead80bf5",
  a2pTrustProduct: "RNb0d4771c2c98518d916a3d4cd70a8f8b",
  starterProfile: "RN806dd6cd175f314e1f96a9727ee271f4",
  starterTrustProduct: "RN670d5d2e282a6130ae063b234b6019c8",
} as const;

type Call = (method: string, path: string, form?: Record<string, string> | ReadonlyArray<readonly [string, string]>) => Promise<Record<string, unknown>>;

export interface TwilioRegistrationDeps {
  readonly call: Call;
  /** The REST API's account path, `/2010-04-01/Accounts/AC…`. */
  readonly accountBase: () => string;
  readonly numberSid: (number: string) => Promise<string>;
  readonly trustHub?: string;
  readonly messaging?: string;
  /** Twilio's words for each code seen, kept across opens of the provider. */
  readonly descriptions?: Map<string, string>;
}

const BUSINESS_TYPE_WORDS: Readonly<Record<BrandProfile["businessType"], string>> = {
  llc: "Limited Liability Corporation",
  corporation: "Corporation",
  partnership: "Partnership",
  nonprofit: "Non-profit Corporation",
  sole_proprietor: "Sole Proprietorship",
};

/** The wizard's field each kind of rejection is fixed in, found by what Twilio's description says. */
const FIX_BY_WORDS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\b(ein|tax id|business registration number)\b/i, "ein", "The EIN does not match the legal name the IRS has for it. Check both against the IRS letter."],
  [/\b(legal name|business name|company name)\b/i, "legalName", "The legal name does not match the registry's records. Enter it exactly as on the IRS letter."],
  [/\b(website|url|domain)\b/i, "website", "The website could not be checked, or does not show the same business. Make sure it loads over https and names the business."],
  [/\b(opt[- ]?in|consent|call to action|message flow)\b/i, "optIn", "The reviewer could not see how people agree to texts. Describe where they tick the box, and link the opt-in page."],
  [/\b(sample|message content)\b/i, "samples", "The sample messages were not accepted. Name the business in one, end one with opt-out wording, and keep them to what the campaign is for."],
  [/\b(opt[- ]?out|stop)\b/i, "samples", "Opt-out wording is missing. End a sample with \"Reply STOP to opt out\"."],
  [/\b(privacy|policy|terms)\b/i, "privacyUrl", "The privacy policy or terms were not acceptable. They must say mobile numbers are not shared or sold."],
  [/\b(use ?case|campaign type)\b/i, "use", "The campaign use does not fit the messages. Pick the use that matches what you will text."],
  [/\b(address|street|postal|zip)\b/i, "street", "The business address could not be verified. Use the address on the business's registration."],
  [/\b(prohibited|disallowed|shaft|cannabis|gambling)\b/i, "website", "The content falls in a category carriers do not allow."],
];

const statusOf = (raw: string): RegistrationStatus["state"] => {
  const word = raw.toUpperCase();
  if (word === "APPROVED" || word === "VERIFIED") return "approved";
  if (word === "FAILED" || word === "REJECTED" || word === "SUSPENDED" || word === "DELETED") return "rejected";
  return "pending";
};

const sidOf = (answer: Record<string, unknown>, what: string): string => {
  const sid = answer["sid"];
  if (typeof sid !== "string" || !sid) throw new Error(`Twilio did not say which ${what} it made.`);
  return sid;
};

const sentence = (text: string): string => (text.trim().endsWith(".") ? text.trim() : `${text.trim()}.`);

export const twilioRegistration = (deps: TwilioRegistrationDeps): RegistrationAdapter & { readonly descriptions: Map<string, string> } => {
  const hub = deps.trustHub ?? TRUST_HUB;
  const messaging = deps.messaging ?? MESSAGING;
  const { call } = deps;
  /** Twilio's own words for each code seen, so `explain` can find the field when the code is new. */
  const descriptions = deps.descriptions ?? new Map<string, string>();

  const bundle = async (kind: "CustomerProfiles" | "TrustProducts", name: string, email: string, policy: string, objects: readonly string[]): Promise<string> => {
    const sid = sidOf(await call("POST", `${hub}/${kind}`, { FriendlyName: name.slice(0, 64), Email: email, PolicySid: policy }), kind);
    for (const object of objects) await call("POST", `${hub}/${kind}/${sid}/EntityAssignments`, { ObjectSid: object });
    await call("POST", `${hub}/${kind}/${sid}/Evaluations`, { PolicySid: policy });
    await call("POST", `${hub}/${kind}/${sid}`, { Status: "pending-review" });
    return sid;
  };
  const endUser = async (type: string, name: string, attributes: Record<string, unknown>): Promise<string> =>
    sidOf(await call("POST", `${hub}/EndUsers`, { FriendlyName: name.slice(0, 64), Type: type, Attributes: JSON.stringify(attributes) }), "end user");

  /** The messaging service a brand's campaign lives under, found by name or made. */
  const service = async (brand: string): Promise<string> => {
    const name = `Dash ${brand}`;
    const found = await call("GET", `${messaging}/Services?PageSize=200`);
    const list = Array.isArray(found["services"]) ? (found["services"] as Record<string, unknown>[]) : [];
    const held = list.find((one) => one["friendly_name"] === name);
    if (held) return String(held["sid"]);
    return sidOf(await call("POST", `${messaging}/Services`, { FriendlyName: name }), "messaging service");
  };

  const campaignParts = (ref: SubmissionRef): { service: string; campaign: string } => {
    const [svc, campaign] = ref.id.split("/");
    if (!svc || !campaign) throw new Error(`"${ref.id}" is not a campaign Dash submitted.`);
    return { service: svc, campaign };
  };

  return {
    descriptions,
    submitBrand: async (p: BrandProfile): Promise<SubmissionRef> => {
      const sole = p.businessType === "sole_proprietor";
      const [first, ...rest] = p.contact.name.trim().split(/\s+/);
      const address = sidOf(
        await call("POST", `${deps.accountBase()}/Addresses.json`, { CustomerName: p.legalName, Street: p.address.street, City: p.address.city, Region: p.address.region, PostalCode: p.address.postalCode, IsoCountry: p.address.country }),
        "address",
      );
      const document = sidOf(await call("POST", `${hub}/SupportingDocuments`, { FriendlyName: `${p.legalName} address`.slice(0, 64), Type: "customer_profile_address", Attributes: JSON.stringify({ address_sids: address }) }), "supporting document");
      const representative = await endUser("authorized_representative_1", p.contact.name, {
        first_name: first ?? "",
        last_name: rest.join(" "),
        email: p.contact.email,
        phone_number: p.contact.phone,
        business_title: p.contact.title,
        job_position: "Other",
      });
      const business = sole
        ? await endUser("starter_customer_profile_information", p.legalName, { first_name: first ?? "", last_name: rest.join(" "), email: p.contact.email, phone_number: p.contact.phone })
        : await endUser("customer_profile_business_information", p.legalName, {
            business_name: p.legalName,
            business_identity: "direct_customer",
            business_type: BUSINESS_TYPE_WORDS[p.businessType],
            business_industry: p.industry.toUpperCase().replace(/[^A-Z]+/g, "_"),
            business_registration_identifier: "EIN",
            business_registration_number: (p.ein ?? "").replace(/\D/g, ""),
            business_regions_of_operation: p.address.country === "CA" ? "USA_AND_CANADA" : "USA_AND_CANADA",
            website_url: p.website,
            social_media_profile_urls: "",
          });
      const profile = await bundle("CustomerProfiles", p.legalName, p.contact.email, sole ? POLICIES.starterProfile : POLICIES.customerProfile, sole ? [business, document] : [business, representative, document]);
      /*
       * The trust bundle's own end user: `sole_proprietor_information` for a sole
       * proprietor (sole-prop page, step 2.3), `us_a2p_messaging_profile_information`
       * otherwise (standard page, step 2.2). The types are checked against the
       * pages; the attribute names inside each are not yet, so check them at Gate C.
       */
      const messagingProfile = sole
        ? await endUser("sole_proprietor_information", p.legalName, { brand_name: p.legalName, vertical: p.industry.toUpperCase().replace(/[^A-Z]+/g, "_") })
        : await endUser("us_a2p_messaging_profile_information", p.legalName, { company_type: p.businessType === "nonprofit" ? "non-profit" : "private" });
      const product = await bundle("TrustProducts", `${p.legalName} A2P`, p.contact.email, sole ? POLICIES.starterTrustProduct : POLICIES.a2pTrustProduct, [messagingProfile, profile]);
      const brand = await call("POST", `${messaging}/a2p/BrandRegistrations`, { CustomerProfileBundleSid: profile, A2PProfileBundleSid: product, ...(sole ? { BrandType: "SOLE_PROPRIETOR" } : {}) });
      return { kind: "brand", id: sidOf(brand, "brand registration"), provider: "twilio" };
    },

    useCases: async (brand: SubmissionRef): Promise<CampaignUse[]> => {
      const svc = await service(brand.id);
      const found = await call("GET", `${messaging}/Services/${svc}/Compliance/Usa2p/Usecases?${new URLSearchParams({ BrandRegistrationSid: brand.id })}`);
      const list = Array.isArray(found["us_app_to_person_usecases"]) ? (found["us_app_to_person_usecases"] as Record<string, unknown>[]) : [];
      return list.map((one) => ({
        id: String(one["code"]),
        title: String(one["name"] ?? one["code"]),
        description: String(one["description"] ?? ""),
        extraVetting: one["post_approval_required"] === true || one["vetting_required"] === true,
      }));
    },

    submitCampaign: async (brand: SubmissionRef, c: CampaignDraft): Promise<SubmissionRef> => {
      const svc = await service(brand.id);
      const flow = `${c.optIn.description}${c.optIn.pageUrl ? ` Opt-in page: ${c.optIn.pageUrl}.` : ""}${c.privacyUrl ? ` Privacy policy: ${c.privacyUrl}.` : ""}${c.termsUrl ? ` Terms: ${c.termsUrl}.` : ""}`;
      const form: Array<[string, string]> = [
        ["BrandRegistrationSid", brand.id],
        ["Description", c.description],
        ["MessageFlow", flow.slice(0, 2048)],
        ["UsAppToPersonUsecase", c.use],
        ["HasEmbeddedLinks", String(c.containsLinks)],
        ["HasEmbeddedPhone", String(c.containsPhoneNumbers)],
        ...c.samples.map((one): [string, string] => ["MessageSamples", one]),
      ];
      const made = await call("POST", `${messaging}/Services/${svc}/Compliance/Usa2p`, form);
      return { kind: "campaign", id: `${svc}/${sidOf(made, "campaign")}`, provider: "twilio" };
    },

    attachNumbers: async (campaign: SubmissionRef, numbers: readonly string[]): Promise<void> => {
      const { service: svc } = campaignParts(campaign);
      for (const number of numbers) await call("POST", `${messaging}/Services/${svc}/PhoneNumbers`, { PhoneNumberSid: await deps.numberSid(number) });
    },

    status: async (ref: SubmissionRef): Promise<RegistrationStatus> => {
      if (ref.kind === "brand") {
        const brand = await call("GET", `${messaging}/a2p/BrandRegistrations/${ref.id}`);
        const errors = Array.isArray(brand["errors"]) ? (brand["errors"] as Record<string, unknown>[]) : [];
        const codes = errors.map((one) => ({ code: String(one["code"] ?? one["error_code"] ?? "unknown"), message: String(one["description"] ?? one["message"] ?? "") }));
        if (codes.length === 0 && typeof brand["failure_reason"] === "string" && brand["failure_reason"]) codes.push({ code: "brand", message: brand["failure_reason"] });
        for (const one of codes) if (one.message) descriptions.set(one.code, one.message);
        return { ref, state: statusOf(String(brand["status"] ?? "")), codes, ...(typeof brand["date_updated"] === "string" ? { at: new Date(brand["date_updated"]).toISOString() } : {}) };
      }
      const { service: svc, campaign } = campaignParts(ref);
      const found = await call("GET", `${messaging}/Services/${svc}/Compliance/Usa2p/${campaign}`);
      const errors = Array.isArray(found["errors"]) ? (found["errors"] as Record<string, unknown>[]) : [];
      const codes = errors.map((one) => ({ code: String(one["error_code"] ?? one["code"] ?? "unknown"), message: String(one["description"] ?? "") }));
      for (const one of codes) if (one.message) descriptions.set(one.code, one.message);
      return { ref, state: statusOf(String(found["campaign_status"] ?? "")), codes, ...(typeof found["date_updated"] === "string" ? { at: new Date(found["date_updated"]).toISOString() } : {}) };
    },

    explain: (code: string): RejectionHelp => {
      const words = descriptions.get(code) ?? "";
      const match = FIX_BY_WORDS.find(([pattern]) => pattern.test(words));
      if (match) return { code, sentence: `${match[2]}${words ? ` Twilio said: ${sentence(words)}` : ""}`, field: match[1] };
      return { code, sentence: words ? `Twilio said: ${sentence(words)} Check the fields it names and submit again.` : `The registry rejected this with code ${code}. Check every field against the business's records and submit again.` };
    },
  };
};
