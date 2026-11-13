import { describe, expect, it } from "vitest";
import { MESSAGING, POLICIES, TRUST_HUB, createTwilioProvider, type TwilioOptions } from "./index.js";

/*
 * Against recorded answers in the shapes Twilio's Trust Hub and Messaging
 * APIs give: nothing here reaches Twilio, and nothing is submitted or paid.
 */

const SID = "AC" + "0123456789abcdef".repeat(2);
const keys = { accountSid: SID, authToken: "token" };

type Call = { method: string; url: string; form: URLSearchParams };

const pretendTwilio = (answers: Record<string, unknown> = {}) => {
  const calls: Call[] = [];
  let n = 0;
  const fetch: NonNullable<TwilioOptions["fetch"]> = async (url, init) => {
    const form = new URLSearchParams(init.body ?? "");
    calls.push({ method: init.method, url, form });
    const path = url.split("?")[0]!;
    const key = `${init.method} ${path}`;
    if (key in answers) return { status: 200, text: async () => JSON.stringify(answers[key]) };
    const sid = (prefix: string) => `${prefix}${String(++n).padStart(32, "0")}`;
    let body: unknown = {};
    if (path.endsWith("/Addresses.json")) body = { sid: sid("AD") };
    else if (path === `${TRUST_HUB}/SupportingDocuments`) body = { sid: sid("RD") };
    else if (path === `${TRUST_HUB}/EndUsers`) body = { sid: sid("IT") };
    else if (/\/(CustomerProfiles|TrustProducts)$/.test(path)) body = { sid: sid("BU") };
    else if (path === `${MESSAGING}/a2p/BrandRegistrations`) body = { sid: sid("BN"), status: "PENDING" };
    else if (path === `${MESSAGING}/Services` && init.method === "GET") body = { services: [] };
    else if (path === `${MESSAGING}/Services`) body = { sid: sid("MG") };
    else if (path.endsWith("/Compliance/Usa2p")) body = { sid: sid("QE"), campaign_status: "PENDING" };
    else if (path.endsWith("/IncomingPhoneNumbers.json")) body = { incoming_phone_numbers: [{ sid: "PN1", phone_number: "+14155550100", capabilities: { sms: true, voice: true } }] };
    return { status: 201, text: async () => JSON.stringify(body) };
  };
  return { calls, fetch };
};

const brand = {
  legalName: "Acme Plumbing LLC",
  businessType: "llc" as const,
  ein: "12-3456789",
  address: { street: "1 Main St", city: "Springfield", region: "IL", postalCode: "62701", country: "US" as const },
  website: "https://acmeplumbing.example",
  industry: "Home services",
  contact: { name: "Ann Owner", title: "Owner", email: "ann@acmeplumbing.example", phone: "+15550100999" },
};

describe("Twilio registration: the brand", () => {
  it("uses the policy sids Twilio's onboarding pages give (2026-10-30)", () => {
    expect(POLICIES).toEqual({
      customerProfile: "RNdfbf3fae0e1107f8aded0e7cead80bf5",
      a2pTrustProduct: "RNb0d4771c2c98518d916a3d4cd70a8f8b",
      starterProfile: "RN806dd6cd175f314e1f96a9727ee271f4",
      starterTrustProduct: "RN670d5d2e282a6130ae063b234b6019c8",
    });
  });

  it("builds the customer profile and A2P trust product, then registers the brand", async () => {
    const twilio = pretendTwilio();
    const ref = await createTwilioProvider({ fetch: twilio.fetch })(keys).registration!.submitBrand(brand);
    expect(ref).toMatchObject({ kind: "brand", provider: "twilio", id: expect.stringMatching(/^BN/) });
    const steps = twilio.calls.map((one) => `${one.method} ${one.url.replace(TRUST_HUB, "hub").replace(MESSAGING, "msg").replace(/\/(BU|AD)\d+/g, "/$1…")}`);
    expect(steps[0]).toBe(`POST https://api.twilio.com/2010-04-01/Accounts/${SID}/Addresses.json`);
    expect(steps).toContain("POST hub/CustomerProfiles");
    expect(steps).toContain("POST hub/TrustProducts");
    expect(steps.at(-1)).toBe("POST msg/a2p/BrandRegistrations");
    const profile = twilio.calls.find((one) => one.url === `${TRUST_HUB}/CustomerProfiles`)!;
    expect(profile.form.get("PolicySid")).toBe(POLICIES.customerProfile);
    const business = twilio.calls.find((one) => one.form.get("Type") === "customer_profile_business_information")!;
    expect(JSON.parse(business.form.get("Attributes")!)).toMatchObject({ business_name: "Acme Plumbing LLC", business_registration_number: "123456789", business_type: "Limited Liability Corporation" });
    expect(twilio.calls.find((one) => one.url === `${TRUST_HUB}/TrustProducts`)!.form.get("PolicySid")).toBe(POLICIES.a2pTrustProduct);
    expect(twilio.calls.some((one) => one.form.get("Type") === "us_a2p_messaging_profile_information")).toBe(true);
    expect(twilio.calls.at(-1)!.form.get("BrandType")).toBeNull();
    /* Each bundle is assigned, evaluated, then sent for review. */
    expect(twilio.calls.filter((one) => one.form.get("Status") === "pending-review")).toHaveLength(2);
  });

  it("takes a sole proprietor through the starter profile, with no EIN", async () => {
    const twilio = pretendTwilio();
    const { ein: _ein, ...rest } = brand;
    await createTwilioProvider({ fetch: twilio.fetch })(keys).registration!.submitBrand({ ...rest, businessType: "sole_proprietor" });
    expect(twilio.calls.some((one) => one.form.get("Type") === "customer_profile_business_information")).toBe(false);
    expect(twilio.calls.find((one) => one.url === `${TRUST_HUB}/CustomerProfiles`)!.form.get("PolicySid")).toBe(POLICIES.starterProfile);
    expect(twilio.calls.at(-1)!.form.get("BrandType")).toBe("SOLE_PROPRIETOR");
    expect(twilio.calls.find((one) => one.url === `${TRUST_HUB}/TrustProducts`)!.form.get("PolicySid")).toBe(POLICIES.starterTrustProduct);
    expect(twilio.calls.some((one) => one.form.get("Type") === "sole_proprietor_information")).toBe(true);
    expect(twilio.calls.some((one) => one.form.get("Type") === "starter_customer_profile_information")).toBe(true);
  });
});

describe("Twilio registration: uses, campaign, numbers, status", () => {
  const BN = { kind: "brand" as const, id: "BN1", provider: "twilio" };

  it("reads the uses the registry accepts for the brand, under its own messaging service", async () => {
    const twilio = pretendTwilio({
      [`GET ${MESSAGING}/Services`]: { services: [{ sid: "MG9", friendly_name: "Dash BN1" }] },
      [`GET ${MESSAGING}/Services/MG9/Compliance/Usa2p/Usecases`]: {
        us_app_to_person_usecases: [
          { code: "ACCOUNT_NOTIFICATION", name: "Account Notification", description: "Status updates", post_approval_required: false },
          { code: "POLITICAL", name: "Political", description: "Political messages", post_approval_required: true },
        ],
      },
    });
    const uses = await createTwilioProvider({ fetch: twilio.fetch })(keys).registration!.useCases(BN);
    expect(uses).toEqual([
      { id: "ACCOUNT_NOTIFICATION", title: "Account Notification", description: "Status updates", extraVetting: false },
      { id: "POLITICAL", title: "Political", description: "Political messages", extraVetting: true },
    ]);
    expect(twilio.calls.some((one) => one.method === "POST")).toBe(false);
  });

  it("submits the campaign with every sample, and attaches numbers through the messaging service", async () => {
    const twilio = pretendTwilio();
    const registration = createTwilioProvider({ fetch: twilio.fetch })(keys).registration!;
    const campaign = await registration.submitCampaign(BN, {
      use: "ACCOUNT_NOTIFICATION",
      description: "Appointment reminders",
      samples: ["Acme Plumbing: see you at 9", "Reply STOP to opt out"],
      frequency: "Per visit",
      optIn: { methods: ["booking_page"], description: "An unticked box on the booking page.", pageUrl: "https://dash.example/p/acme/texts" },
      privacyUrl: "https://dash.example/p/acme/texts/privacy",
      containsLinks: false,
      containsPhoneNumbers: false,
    });
    expect(campaign.id).toMatch(/^MG\d+\/QE\d+$/);
    const sent = twilio.calls.find((one) => one.url.endsWith("/Compliance/Usa2p"))!;
    expect(sent.form.getAll("MessageSamples")).toEqual(["Acme Plumbing: see you at 9", "Reply STOP to opt out"]);
    expect(sent.form.get("MessageFlow")).toContain("Opt-in page: https://dash.example/p/acme/texts.");
    await registration.attachNumbers(campaign, ["+14155550100"]);
    expect(twilio.calls.at(-1)).toMatchObject({ method: "POST", url: `${MESSAGING}/Services/${campaign.id.split("/")[0]}/PhoneNumbers` });
    expect(twilio.calls.at(-1)!.form.get("PhoneNumberSid")).toBe("PN1");
  });

  it("reads status, and explains a rejection by Twilio's own words with the field to fix", async () => {
    const twilio = pretendTwilio({
      [`GET ${MESSAGING}/a2p/BrandRegistrations/BN1`]: { sid: "BN1", status: "FAILED", errors: [{ code: 30794, description: "The EIN does not match the business name on record" }] },
      [`GET ${MESSAGING}/Services/MG1/Compliance/Usa2p/QE1`]: { sid: "QE1", campaign_status: "VERIFIED", errors: [] },
    });
    const registration = createTwilioProvider({ fetch: twilio.fetch })(keys).registration!;
    expect(await registration.status(BN)).toMatchObject({ state: "rejected", codes: [{ code: "30794" }] });
    expect(registration.explain("30794")).toMatchObject({ field: "ein", sentence: expect.stringContaining("Twilio said: The EIN does not match") });
    expect(await registration.status({ kind: "campaign", id: "MG1/QE1", provider: "twilio" })).toMatchObject({ state: "approved", codes: [] });
    expect(registration.explain("99999")).toMatchObject({ sentence: expect.stringContaining("99999") });
    expect(registration.explain("99999").field).toBeUndefined();
  });
});
