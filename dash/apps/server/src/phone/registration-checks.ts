import type { Check, PolicyScan, RegistrationDraft, RegistrationProblem, RegistrationStep, Task } from "@freebirdai/dash-spec";
import { checkRule } from "../evals/checks.js";
import { namesBusiness, prohibitedIn } from "./policy-scan.js";

/**
 * The pre-submit checks (Dash Phone, Phase 2): each one a rule check in the
 * same engine as Dash Evals (`@freebirdai/expr` over a subject, `checkRule`),
 * run on the draft before anything is sent to the registry. A rejection costs
 * a fee and restarts the wait, so a failure names the field and the wizard
 * jumps to it.
 *
 * The draft is first read into plain facts (`registrationFacts`):
 * deterministic, no model. The rules are expressions over those facts, so
 * each can be read, tested and run alone.
 */

type RuleCheck = Extract<Check, { kind: "rule" }>;

export interface RegistrationRule {
  readonly check: RuleCheck;
  readonly step: RegistrationStep;
  readonly field: string;
}

/** Public link shorteners: carriers filter texts that carry one. */
export const LINK_SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "tiny.cc", "rb.gy", "t.ly", "bl.ink"] as const;

/** Uses that carry no offers: a sample selling something does not fit them. */
const NOT_MARKETING = new Set(["ACCOUNT_NOTIFICATION", "CUSTOMER_CARE", "DELIVERY_NOTIFICATION", "FRAUD_ALERT", "HIGHER_EDUCATION", "POLLING_VOTING", "PUBLIC_SERVICE_ANNOUNCEMENT", "SECURITY_ALERT", "2FA"]);

const PROMO = /\b(\d+\s?% off|sale|discount|deal|promo(?:tion)?|coupon|offer|limited time|buy now|free gift)\b/i;
const OPT_OUT = /\b(stop|opt[ -]?out|unsubscribe)\b/i;
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|us|biz|info)\b(?:\/\S*)?/i;
const PHONE_IN_TEXT = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

export interface RegistrationScans {
  readonly website?: PolicyScan;
  readonly privacy?: PolicyScan;
  readonly optIn?: PolicyScan;
}

/** Everything the rules read, worked out from the draft and what the scans found. */
export const registrationFacts = (draft: RegistrationDraft, scans: RegistrationScans = {}) => {
  const b = draft.business;
  const c = draft.campaign;
  const samples = c.samples.map((one) => one.trim()).filter(Boolean);
  const sole = b.businessType === "sole_proprietor";
  const hosted = draft.optIn.hosted;
  const required: Array<[string, boolean]> = [
    ["legalName", Boolean(b.legalName.trim())],
    ["businessType", Boolean(b.businessType)],
    ["ein", sole || Boolean(b.ein)],
    ["street", Boolean(b.street.trim())],
    ["city", Boolean(b.city.trim())],
    ["region", Boolean(b.region.trim())],
    ["postalCode", Boolean(b.postalCode.trim())],
    ["website", Boolean(b.website.trim())],
    ["industry", Boolean(b.industry.trim())],
    ["contactName", Boolean(draft.contact.name.trim())],
    ["contactTitle", Boolean(draft.contact.title.trim())],
    ["contactEmail", Boolean(draft.contact.email.trim())],
    ["contactPhone", Boolean(draft.contact.phone.trim())],
    ["use", Boolean(c.use)],
    ["description", Boolean(c.description.trim())],
    ["samples", samples.length >= 2],
    ["frequency", Boolean(c.frequency.trim())],
    ["optInMethods", draft.optIn.methods.length > 0],
    ["optInDescription", Boolean(draft.optIn.description.trim())],
    ["containsLinks", c.containsLinks !== undefined],
    ["containsPhoneNumbers", c.containsPhoneNumbers !== undefined],
  ];
  const missing = required.filter(([, filled]) => !filled).map(([field]) => field);
  return {
    missing,
    missingCount: missing.length,
    brandInSample: samples.some((one) => namesBusiness(one, b.legalName)),
    optOutInSample: samples.some((one) => OPT_OUT.test(one)),
    promoInSamples: samples.some((one) => PROMO.test(one)),
    marketingUse: c.use !== undefined && !NOT_MARKETING.has(c.use),
    shortenerInSamples: samples.some((one) => LINK_SHORTENERS.some((host) => one.toLowerCase().includes(host))),
    linksInSamples: samples.some((one) => URL_IN_TEXT.test(one) || LINK_SHORTENERS.some((host) => one.toLowerCase().includes(host))),
    phonesInSamples: samples.some((one) => PHONE_IN_TEXT.test(one)),
    containsLinks: c.containsLinks === true,
    containsPhoneNumbers: c.containsPhoneNumbers === true,
    websiteHttps: b.website.trim().startsWith("https://") && (scans.website?.https ?? true),
    websiteReachable: scans.website?.reachable === true,
    websiteShowsName: scans.website?.showsName === true,
    websiteProhibited: scans.website?.prohibited.length ?? 0,
    samplesProhibited: prohibitedIn(samples.join(" ")).length,
    /* Dash's own pages carry the clause and keep the boxes apart by construction. */
    privacyOk: hosted || (scans.privacy?.reachable === true && scans.privacy.noSharing),
    optInOk: hosted || (scans.optIn?.reachable === true && !scans.optIn.checkedByDefault && !scans.optIn.consentWithTerms),
    confirmed: draft.confirmed.legalName && (sole || draft.confirmed.ein),
  };
};

export type RegistrationFacts = ReturnType<typeof registrationFacts>;

const rule = (id: string, says: string, expr: string, step: RegistrationStep, field: string): RegistrationRule => ({
  check: { kind: "rule", id, dimension: "correctness", says, expect: "all", expr },
  step,
  field,
});

/** The plan's checks, in its order. */
export const REGISTRATION_RULES: readonly RegistrationRule[] = [
  rule("brand-in-sample", "The business's name appears in at least one sample message.", "facts.brandInSample", "campaign", "samples"),
  rule("opt-out-in-sample", 'At least one sample says how to stop: "Reply STOP to opt out".', "facts.optOutInSample", "campaign", "samples"),
  rule("samples-fit-use", "The samples fit the campaign use: offers and discounts only under Marketing or a mixed use.", "facts.marketingUse || !facts.promoInSamples", "campaign", "use"),
  rule("no-shorteners", "No sample uses a public link shortener (bit.ly and the like): carriers filter them.", "!facts.shortenerInSamples", "campaign", "samples"),
  rule("links-answer-matches", '"Contains links" matches the samples.', "facts.containsLinks == facts.linksInSamples", "campaign", "containsLinks"),
  rule("phones-answer-matches", '"Contains phone numbers" matches the samples.', "facts.containsPhoneNumbers == facts.phonesInSamples", "campaign", "containsPhoneNumbers"),
  rule("website-https-and-name", "The website loads over https and shows the same business name.", "facts.websiteHttps && facts.websiteReachable && facts.websiteShowsName", "business", "website"),
  rule("privacy-no-sharing", "The privacy policy is reachable and says mobile numbers are not shared or sold.", "facts.privacyOk", "opt_in", "privacyUrl"),
  rule("opt-in-box", "The opt-in box is unticked until ticked, and separate from agreeing to the terms.", "facts.optInOk", "opt_in", "pageUrl"),
  rule("no-prohibited-content", "Neither the website nor the samples show anything from the prohibited content categories.", "facts.websiteProhibited == 0 && facts.samplesProhibited == 0", "business", "website"),
  rule("required-filled", "Every required field is filled.", "facts.missingCount == 0", "business", "legalName"),
  rule("legal-name-ein-confirmed", "The legal name and EIN were confirmed on the review screen.", "facts.confirmed", "check", "confirmed"),
];

/** Where each missing required field lives. */
const FIELD_STEP: Readonly<Record<string, RegistrationStep>> = {
  contactName: "contact",
  contactTitle: "contact",
  contactEmail: "contact",
  contactPhone: "contact",
  use: "campaign",
  description: "campaign",
  samples: "campaign",
  frequency: "campaign",
  containsLinks: "campaign",
  containsPhoneNumbers: "campaign",
  optInMethods: "opt_in",
  optInDescription: "opt_in",
};

/** Runs every rule on the draft. Empty: it may be submitted. */
export const checkDraft = (draft: RegistrationDraft, scans: RegistrationScans = {}, now = 0): RegistrationProblem[] => {
  const facts = registrationFacts(draft, scans);
  const subject = { facts } as unknown as Task;
  const out: RegistrationProblem[] = [];
  for (const one of REGISTRATION_RULES) {
    if (checkRule(one.check, [subject], now).result === "pass") continue;
    if (one.check.id === "required-filled") {
      const first = facts.missing[0]!;
      out.push({ rule: one.check.id, says: `${one.check.says!} Missing: ${facts.missing.join(", ")}.`, step: FIELD_STEP[first] ?? "business", field: first });
      continue;
    }
    out.push({ rule: one.check.id, says: one.check.says!, step: one.step, field: one.field });
  }
  return out;
};
