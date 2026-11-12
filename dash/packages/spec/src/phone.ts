import { z } from "zod";
import { E164, PHONE_TEXT_STATUSES, PHONE_VOICE_STATUSES, mailboxOwnerSchema, type PhoneLineSpec } from "@freebirdai/connect-spec";

/**
 * Dash Phone's normalized shapes: what every phone adapter
 * (`@freebirdai/phone`) turns its provider's answers into, so the wizard, the
 * chat, the evals and the webhook route all read the same thing whatever
 * the carrier. A line itself is `connection.phone` (`connect-spec`).
 */

export { E164, PHONE_TEXT_STATUSES, PHONE_VOICE_STATUSES };
export type { PhoneLineSpec };

export const e164Schema = z.string().regex(E164, "A phone number in international form, like +15551234567.");

/** How far a message got: the same words `task.delivery` uses. */
export const PHONE_DELIVERY_STATUSES = ["queued", "sent", "delivered", "failed"] as const;
export type PhoneDeliveryStatus = (typeof PHONE_DELIVERY_STATUSES)[number];

/* ── texts ─────────────────────────────────────────────────────────────── */

/** A text that arrived, once its webhook has been verified and parsed. */
export const inboundTextSchema = z.object({
  from: e164Schema,
  to: e164Schema,
  body: z.string().max(10_000),
  /** Media addresses the provider holds (MMS). */
  media: z.array(z.string().url()).max(10).default([]),
  at: z.string().datetime(),
  /** The provider's own id for the message. */
  providerId: z.string().min(1).max(200),
});
export type InboundText = z.infer<typeof inboundTextSchema>;

/** A provider's word on a message or call it was given. */
export const deliveryUpdateSchema = z.object({
  providerId: z.string().min(1).max(200),
  status: z.enum(PHONE_DELIVERY_STATUSES),
  /** The provider's own error code, for `explain` and the task. */
  errorCode: z.string().max(40).optional(),
  /** For a call that ended: how long it lasted, in minutes rounded up. Counted against the line's ceiling. */
  minutes: z.number().int().min(0).max(10_000).optional(),
});
export type DeliveryUpdate = z.infer<typeof deliveryUpdateSchema>;

/* ── accounts and numbers ──────────────────────────────────────────────── */

/** One thing a person pastes to connect a provider, with where to find it. */
export const credentialFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
  label: z.string().min(1).max(80),
  secret: z.boolean(),
  help: z.string().max(500).optional(),
});
export type CredentialField = z.infer<typeof credentialFieldSchema>;

/** What `verify` reads back from the account: shown, never stored. */
export const accountInfoSchema = z.object({
  name: z.string().max(200),
  country: z.string().max(2).optional(),
  /** A trial account reaches only verified numbers until it is upgraded. */
  trial: z.boolean(),
});
export type AccountInfo = z.infer<typeof accountInfoSchema>;

const numberCapabilitiesSchema = z.object({ text: z.boolean(), voice: z.boolean() });

export const availableNumberSchema = z.object({
  number: e164Schema,
  locality: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  /** What the provider quotes a month: theirs to set, shown as they say it. */
  monthlyPrice: z.object({ amount: z.string().max(20), currency: z.string().length(3) }).optional(),
  capabilities: numberCapabilitiesSchema,
});
export type AvailableNumber = z.infer<typeof availableNumberSchema>;

export const ownedNumberSchema = z.object({
  number: e164Schema,
  providerId: z.string().min(1).max(200),
  capabilities: numberCapabilitiesSchema,
});
export type OwnedNumber = z.infer<typeof ownedNumberSchema>;

/** Where a carrier sends calls: the media layer's SIP address. */
export const sipTargetSchema = z.object({ uri: z.string().min(1).max(500), username: z.string().max(200).optional() });
export type SipTarget = z.infer<typeof sipTargetSchema>;

export const trunkInfoSchema = z.object({ id: z.string().min(1).max(200), sipUri: z.string().max(500), numbers: z.array(e164Schema).max(100) });
export type TrunkInfo = z.infer<typeof trunkInfoSchema>;

/* ── registration (A2P 10DLC) ──────────────────────────────────────────── */

export const BUSINESS_TYPES = ["llc", "corporation", "partnership", "nonprofit", "sole_proprietor"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** The business, as the registry needs it. Only facts Dash cannot know; the EIN is sealed and sent only to the provider. */
export const brandProfileSchema = z
  .object({
    /** Exactly as on the IRS letter. */
    legalName: z.string().trim().min(1).max(200),
    businessType: z.enum(BUSINESS_TYPES),
    /** Nine digits. Absent only for a sole proprietor. */
    ein: z
      .string()
      .regex(/^\d{2}-?\d{7}$/)
      .optional(),
    address: z.object({
      street: z.string().trim().min(1).max(200),
      city: z.string().trim().min(1).max(100),
      region: z.string().trim().min(1).max(100),
      postalCode: z.string().trim().min(1).max(20),
      country: z.enum(["US", "CA"]),
    }),
    website: z.string().url().max(500),
    industry: z.string().trim().min(1).max(100),
    contact: z.object({
      name: z.string().trim().min(1).max(200),
      title: z.string().trim().min(1).max(100),
      email: z.string().email().max(320),
      phone: e164Schema,
    }),
  })
  .superRefine((brand, ctx) => {
    if (brand.businessType !== "sole_proprietor" && !brand.ein) ctx.addIssue({ code: "custom", path: ["ein"], message: "A business that is not a sole proprietor registers with its EIN." });
  });
export type BrandProfile = z.infer<typeof brandProfileSchema>;

/** One campaign use the registry accepts for a brand, from `useCases()`, in plain words. */
export const campaignUseSchema = z.object({
  /** The registry's own code, e.g. `ACCOUNT_NOTIFICATION`, `MIXED`. */
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  /** Political, charity, sweepstakes and similar: vetted further. */
  extraVetting: z.boolean().default(false),
});
export type CampaignUse = z.infer<typeof campaignUseSchema>;

export const OPT_IN_METHODS = ["website_form", "booking_page", "in_person", "keyword", "imported"] as const;
export type OptInMethod = (typeof OPT_IN_METHODS)[number];

/** What the business will text, as the registry reviews it. */
export const campaignDraftSchema = z.object({
  use: z.string().min(1).max(80),
  description: z.string().trim().min(1).max(4096),
  samples: z.array(z.string().trim().min(1).max(1024)).min(2).max(5),
  /** How often, in plain words: "a reminder before each appointment". */
  frequency: z.string().trim().min(1).max(500),
  optIn: z.object({
    methods: z.array(z.enum(OPT_IN_METHODS)).min(1).max(OPT_IN_METHODS.length),
    description: z.string().trim().min(1).max(2048),
    pageUrl: z.string().url().max(500).optional(),
  }),
  privacyUrl: z.string().url().max(500).optional(),
  termsUrl: z.string().url().max(500).optional(),
  containsLinks: z.boolean(),
  containsPhoneNumbers: z.boolean(),
});
export type CampaignDraft = z.infer<typeof campaignDraftSchema>;

/** Something submitted to the registry, by the provider's id for it. */
export const submissionRefSchema = z.object({
  kind: z.enum(["brand", "campaign"]),
  id: z.string().min(1).max(200),
  provider: z.string().min(1).max(40),
});
export type SubmissionRef = z.infer<typeof submissionRefSchema>;

export const REGISTRATION_STATES = ["pending", "approved", "rejected"] as const;
export type RegistrationState = (typeof REGISTRATION_STATES)[number];

export const registrationStatusSchema = z.object({
  ref: submissionRefSchema,
  state: z.enum(REGISTRATION_STATES),
  /** The provider's codes, for `explain`. */
  codes: z.array(z.object({ code: z.string().min(1).max(40), message: z.string().max(1000).optional() })).max(50).default([]),
  at: z.string().datetime().optional(),
});
export type RegistrationStatus = z.infer<typeof registrationStatusSchema>;

/** A rejection code in plain words, and the wizard field that fixes it. */
export const rejectionHelpSchema = z.object({
  code: z.string().min(1).max(40),
  sentence: z.string().min(1).max(1000),
  field: z.string().max(80).optional(),
});
export type RejectionHelp = z.infer<typeof rejectionHelpSchema>;

/* ── a line, as Communications shows it ────────────────────────────────── */

export interface PhoneLineView {
  readonly id: string;
  readonly title: string;
  readonly provider: string;
  readonly number?: string | undefined;
  readonly owner: z.infer<typeof mailboxOwnerSchema>;
  readonly text: (typeof PHONE_TEXT_STATUSES)[number];
  readonly voice: (typeof PHONE_VOICE_STATUSES)[number];
  /** Today's use against the line's ceilings (UTC day). */
  readonly today: { readonly texts: number; readonly textsPerDay: number; readonly callMinutes: number; readonly callMinutesPerDay: number };
}

export const PHONE_TEXT_WORDS: Readonly<Record<(typeof PHONE_TEXT_STATUSES)[number], string>> = {
  needs_registration: "Texts: needs registration",
  pending: "Texts: registration pending",
  approved: "Texts: ready",
  rejected: "Texts: registration rejected",
};

export const PHONE_VOICE_WORDS: Readonly<Record<(typeof PHONE_VOICE_STATUSES)[number], string>> = {
  not_connected: "Calls: not connected",
  ready: "Calls: ready",
  off: "Calls: off",
};
