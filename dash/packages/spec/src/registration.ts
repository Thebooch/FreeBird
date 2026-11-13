import { z } from "zod";
import { BUSINESS_TYPES, OPT_IN_METHODS, REGISTRATION_STATES, submissionRefSchema } from "./phone.js";

/**
 * The text registration wizard's draft (Dash Phone, Phase 2): six short
 * screens that turn A2P 10DLC registration into one submission. It asks only
 * for facts Dash cannot know, drafts the rest from the workspace, and refuses
 * to submit what would fail a known check.
 *
 * One draft per line. It autosaves as the person goes. The EIN is kept only
 * sealed with the vault's key (`ein.sealed`), shown masked, and sent only to
 * the provider; a view never carries the sealed value.
 */

export const REGISTRATION_STEPS = ["business", "contact", "campaign", "opt_in", "check", "status"] as const;
export type RegistrationStep = (typeof REGISTRATION_STEPS)[number];

export const REGISTRATION_STEP_WORDS: Readonly<Record<RegistrationStep, string>> = {
  business: "Your business",
  contact: "Who to contact",
  campaign: "What you'll text",
  opt_in: "How people agree",
  check: "Check and submit",
  status: "Status",
};

export const TIMELINE_EVENTS = ["brand_submitted", "brand_approved", "brand_rejected", "campaign_submitted", "campaign_approved", "campaign_rejected", "numbers_attached"] as const;
export type TimelineEvent = (typeof TIMELINE_EVENTS)[number];

export const TIMELINE_WORDS: Readonly<Record<TimelineEvent, string>> = {
  brand_submitted: "Business submitted",
  brand_approved: "Business approved",
  brand_rejected: "Business rejected",
  campaign_submitted: "Campaign submitted",
  campaign_approved: "Campaign approved",
  campaign_rejected: "Campaign rejected",
  numbers_attached: "Numbers attached: texting can start",
};

const text = (max: number) => z.string().max(max).default("");

export const registrationDraftSchema = z.object({
  line: z.string().min(1),
  step: z.enum(REGISTRATION_STEPS).default("business"),
  /** The field the person was last in, for the chat's focus. */
  field: z.string().max(80).optional(),
  business: z
    .object({
      legalName: text(200),
      businessType: z.enum(BUSINESS_TYPES).optional(),
      /** Sealed with the vault's key; never in a view. `last4` is what is shown. */
      ein: z.object({ sealed: z.string().min(1), last4: z.string().regex(/^\d{4}$/) }).optional(),
      street: text(200),
      city: text(100),
      region: text(100),
      postalCode: text(20),
      country: z.enum(["US", "CA"]).default("US"),
      website: text(500),
      industry: text(100),
    })
    .default({}),
  contact: z.object({ name: text(200), title: text(100), email: text(320), phone: text(20) }).default({}),
  campaign: z
    .object({
      use: z.string().max(80).optional(),
      description: text(4096),
      samples: z.array(z.string().max(1024)).max(5).default([]),
      frequency: text(500),
      containsLinks: z.boolean().optional(),
      containsPhoneNumbers: z.boolean().optional(),
      /**
       * What the `registration-draft` model task wrote, and what it was made
       * from. Nothing generated is submitted until `accepted` (the "Use this"
       * box) puts it in the fields above.
       */
      drafted: z
        .object({
          from: z.array(z.string().max(200)).max(20),
          use: z.string().max(80).optional(),
          description: z.string().max(4096),
          samples: z.array(z.string().max(1024)).max(5),
          accepted: z.boolean().default(false),
          at: z.string(),
        })
        .optional(),
    })
    .default({}),
  optIn: z
    .object({
      methods: z.array(z.enum(OPT_IN_METHODS)).max(OPT_IN_METHODS.length).default([]),
      description: text(2048),
      /** Dash hosts the opt-in form, privacy section and terms at the workspace's public address. */
      hosted: z.boolean().default(true),
      pageUrl: z.string().max(500).optional(),
      privacyUrl: z.string().max(500).optional(),
      termsUrl: z.string().max(500).optional(),
    })
    .default({}),
  /** Confirmed on the review screen, as the registry has them on file. */
  confirmed: z.object({ legalName: z.boolean().default(false), ein: z.boolean().default(false) }).default({}),
  submitted: z
    .object({
      brand: submissionRefSchema.optional(),
      campaign: submissionRefSchema.optional(),
      numbersAttached: z.boolean().default(false),
      brandState: z.enum(REGISTRATION_STATES).optional(),
      campaignState: z.enum(REGISTRATION_STATES).optional(),
      codes: z.array(z.object({ code: z.string(), message: z.string().optional() })).max(50).default([]),
    })
    .default({}),
  timeline: z.array(z.object({ at: z.string(), event: z.enum(TIMELINE_EVENTS), codes: z.array(z.string()).max(20).default([]) })).max(100).default([]),
  updatedAt: z.string(),
});
export type RegistrationDraft = z.infer<typeof registrationDraftSchema>;

/** The draft as a person or the chat sees it: the EIN only as its last four. */
export type RegistrationDraftView = Omit<RegistrationDraft, "business"> & {
  readonly business: Omit<RegistrationDraft["business"], "ein"> & { readonly ein?: string };
};

export const maskedEin = (last4: string): string => `••-•••${last4}`;

export const draftView = (draft: RegistrationDraft): RegistrationDraftView => {
  const { ein, ...business } = draft.business;
  return { ...draft, business: { ...business, ...(ein ? { ein: maskedEin(ein.last4) } : {}) } };
};

/** One pre-submit check that failed: what, in a sentence, and the wizard field it jumps to. */
export interface RegistrationProblem {
  readonly rule: string;
  readonly says: string;
  readonly step: RegistrationStep;
  readonly field: string;
}

/** What a policy or opt-in page was found to say, by `scanPolicy`. */
export const policyScanSchema = z.object({
  url: z.string(),
  reachable: z.boolean(),
  https: z.boolean(),
  showsName: z.boolean(),
  noSharing: z.boolean(),
  /** An opt-in box ticked before anyone ticks it. */
  checkedByDefault: z.boolean(),
  /** The text box and a terms box are one box. */
  consentWithTerms: z.boolean(),
  /** Words from the prohibited content categories found on it. */
  prohibited: z.array(z.string()).max(20),
  problem: z.string().optional(),
});
export type PolicyScan = z.infer<typeof policyScanSchema>;
