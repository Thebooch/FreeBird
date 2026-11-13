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

export const trunkInfoSchema = z.object({
  id: z.string().min(1).max(200),
  sipUri: z.string().max(500),
  numbers: z.array(e164Schema).max(100),
  /** Where the media layer sends outbound calls through the carrier, and the credential it signs in with. The password goes to the vault, never a spec. */
  termination: z.object({ address: z.string().max(300), username: z.string().max(100), password: z.string().max(200) }).optional(),
});
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

/* ── keywords Dash answers itself ──────────────────────────────────────── */

/**
 * STOP, HELP and START, answered by Dash on every provider so behaviour does
 * not depend on a provider's settings. A message that is only one of these
 * words (any case, trailing punctuation allowed) is a keyword; anything
 * longer is conversation. `YES` is not a START word here: Dash's own texts
 * ask people to reply YES to confirm.
 */
export const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"] as const;
export const HELP_WORDS = ["HELP", "INFO"] as const;
export const START_WORDS = ["START", "UNSTOP"] as const;
export type PhoneKeyword = "stop" | "help" | "start";

export const keywordOf = (body: string): PhoneKeyword | null => {
  const word = body.trim().replace(/[\s.!?]+$/u, "").toUpperCase();
  if ((STOP_WORDS as readonly string[]).includes(word)) return "stop";
  if ((HELP_WORDS as readonly string[]).includes(word)) return "help";
  if ((START_WORDS as readonly string[]).includes(word)) return "start";
  return null;
};

/** Why a text was allowed to go: consent on record, or they texted this line first in this conversation. */
export const TEXT_BASES = ["on_record", "texted_first", "keyword_reply"] as const;
export type TextBasis = (typeof TEXT_BASES)[number];

/* ── texts Dash keeps ──────────────────────────────────────────────────── */

/** One text on a line, in or out, as Communications keeps it (sealed). `number` is the other side. */
export const phoneTextSchema = z.object({
  line: z.string().min(1),
  id: z.string().min(1).max(200),
  number: e164Schema,
  direction: z.enum(["in", "out"]),
  body: z.string().max(10_000),
  at: z.string(),
  /** STOP, HELP or START, and Dash's answer to one: never shown to agents as conversation. */
  keyword: z.enum(["stop", "help", "start"]).optional(),
  /** A call in the conversation rather than a text: `body` is its transcript. */
  kind: z.enum(["text", "call"]).optional(),
  status: z.enum([...PHONE_DELIVERY_STATUSES, "not_sent"]).optional(),
  agent: z.string().optional(),
  contact: z.string().optional(),
  /** The inbound screen's record, and whether it held the text. */
  screen: z.string().optional(),
  held: z.boolean().optional(),
});
export type PhoneText = z.infer<typeof phoneTextSchema>;

/** A conversation on a line with one number, newest first in a list. */
export interface PhoneThreadView {
  readonly line: string;
  readonly number: string;
  readonly contact?: string | undefined;
  readonly name?: string | undefined;
  /** Who wrote first: they did, or the business. */
  readonly startedBy: "them" | "us";
  readonly last: PhoneText;
}

/* ── calls ─────────────────────────────────────────────────────────────── */

/** Said whenever the call is recorded, word for word: the business cannot change or drop it while recording is on. */
export const RECORDING_NOTICE = "This call is recorded.";

/**
 * The first thing every call hears. The business words its own greeting
 * (`disclosure`), but the line always says it is an automated assistant for
 * the business (added unless the greeting already says so) and, while
 * recording is on, ends with the fixed recording notice.
 */
export const openingLine = (business: string, disclosure: string, recording: boolean): string => {
  const own = disclosure.trim();
  const greeting = own || `Hi, you've reached ${business}.`;
  const says = /\b(automated|virtual|ai)\b[^.]*\bassistant\b|\bassistant\b[^.]*\b(automated|ai)\b/i.test(greeting);
  const parts = [greeting, says ? "" : `I'm ${business}'s automated assistant.`, recording ? RECORDING_NOTICE : ""].filter(Boolean);
  return parts.join(" ");
};

export const CALL_SPEAKERS = ["caller", "agent", "system"] as const;

/** One call on a line, kept with the conversation: who answered, and what was said. */
export const callRecordSchema = z.object({
  id: z.string().min(1),
  line: z.string().min(1),
  /** The other side's number. */
  number: e164Schema,
  direction: z.enum(["in", "out"]),
  answeredBy: z.enum(["agent", "forward", "voicemail"]),
  agent: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  recording: z.boolean(),
  transcript: z.array(z.object({ who: z.enum(CALL_SPEAKERS), text: z.string().max(4000), at: z.string() })).max(500),
  /** Handed to a person, and what they were told first. */
  transfer: z.object({ to: e164Schema, whisper: z.string().max(300) }).optional(),
  /** Approve-mode actions the agent said it would take: tasks waiting for a person. */
  waiting: z.array(z.string()).max(20).default([]),
  /** What the caller was asking, in a sentence, for the conversation list and the workflow. */
  summary: z.string().max(500).optional(),
});
export type CallRecord = z.infer<typeof callRecordSchema>;

/* ── a line, as Communications shows it ────────────────────────────────── */

export interface PhoneLineView {
  readonly id: string;
  readonly title: string;
  readonly provider: string;
  readonly number?: string | undefined;
  readonly owner: z.infer<typeof mailboxOwnerSchema>;
  readonly text: (typeof PHONE_TEXT_STATUSES)[number];
  readonly voice: (typeof PHONE_VOICE_STATUSES)[number];
  /** What answers its calls, the forward number, recording, and the business's own opening words. */
  readonly calls?: PhoneLineSpec["calls"];
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
